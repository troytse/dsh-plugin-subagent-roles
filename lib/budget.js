/**
 * Tool-call budget: how many tool calls a role's child may make, and what
 * happens when it runs out.
 *
 * Counting is event-sourced. The monitor folds committed `tool/call` events of
 * the Sessions this plugin started — the framework records those, so the guard
 * never parses model output and never trusts the child's self-report. One
 * `tool/call` is one "call": parallel calls inside one step each count, and a
 * call the scheduler appended before a policy denial or a post-cancellation skip
 * counts too, because the model already spent that decision.
 *
 * The enforcement ACTION is deliberately not decided here. A delegation hands in
 * `enforce` / `injectWrapUp` closures, because the three delegation routes need
 * three different mechanisms: a foreground one-shot child is stopped by aborting
 * the signal its run was started with, a background one-shot child by aborting
 * the job's controller, and a continuable child by
 * `SubagentRuntime.interrupt()` — which is documented as an accepted no-op for a
 * one-shot or unknown target, so it cannot be the only mechanism.
 *
 * This module holds no `ctx` dependency: `observe()` is the whole seam, which
 * keeps the counting rules unit-testable without a host.
 */

/** Structured-result discriminator; mirrored by the delegation output schema. */
export const TOOL_CALL_BUDGET_STATUS = 'tool-call-budget-exceeded'
/** Machine-readable reason, kept distinct from the core's own `TOOL_TIMEOUT`. */
export const TOOL_CALL_BUDGET_REASON = 'tool-call-budget'
/** Default bounded size of the per-child record table. */
const DEFAULT_MAX_RECORDS = 256

/** A count that is a non-negative safe integer, or undefined. */
function asCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Resolve one delegation's effective budget.
 *
 * Precedence is `role file` over `settings/row-config default`; `0` means
 * unlimited and is a sentinel rather than a count, so `maxToolCallsHardCap`
 * never clamps it — the escape hatch outranks the ceiling by design.
 * @param options - the role, the resolved row/settings defaults, and the hard cap.
 * @returns the effective policy, its provenance, and any clamp warning.
 */
export function resolveToolCallBudget(options = {}) {
  const { role, defaults, hardCap } = options
  const declared = asCount(role?.maxToolCalls)
  const fallback = asCount(defaults?.maxToolCalls) ?? 0
  const requested = declared ?? fallback
  const cap = asCount(hardCap) ?? 0
  // Name the actual source of the value being clamped: a clamped row/Settings
  // default is not the role file asking for something.
  const origin = declared === undefined ? 'the row/Settings default' : `role "${role?.id ?? '(unknown)'}"`
  const warnings = []
  let limit = requested
  if (cap > 0 && limit > cap) {
    warnings.push(`${origin} asked for maxToolCalls ${limit}, over the configured maxToolCallsHardCap ${cap}; using ${cap}`)
    limit = cap
  }
  const mode = role?.onToolCallBudget ?? defaults?.onToolCallBudget ?? 'wrap-up'
  return {
    limit,
    scope: role?.maxToolCallsScope ?? 'delegation',
    mode,
    grace: asCount(role?.graceToolCalls) ?? asCount(defaults?.graceToolCalls) ?? 1,
    source: declared === undefined ? (limit > 0 ? 'row-default' : 'unlimited') : (limit > 0 ? 'role' : 'unlimited'),
    warnings,
  }
}

/**
 * The structured, non-error value a budget-stopped delegation returns.
 *
 * Deliberately not thrown: a thrown error reads to the delegating agent as a
 * tool fault worth retrying, which is the opposite of the intended "choose a
 * smaller task, raise the budget, or accept the partial result".
 * @param record - the breached budget record.
 * @param partialOutput - child text preserved before the stop, when there is any.
 * @returns the value the delegation output schema declares.
 */
export function toolCallBudgetFailure(record, partialOutput) {
  const { limit, scope, mode } = record.policy
  const used = record.usedAtBreach ?? record.used
  return {
    kind: 'budget-exceeded',
    status: TOOL_CALL_BUDGET_STATUS,
    reason: TOOL_CALL_BUDGET_REASON,
    role: record.roleId,
    used,
    limit,
    scope,
    mode,
    ...(typeof partialOutput === 'string' && partialOutput.length > 0 ? { partialOutput } : {}),
    note: `role "${record.roleId}" used ${used} of its ${limit} tool calls (scope ${scope}, mode ${mode}) and was stopped. Re-delegate a narrower task, raise maxToolCalls in the role file, or accept the partial output.`,
  }
}

/**
 * Create the per-row budget monitor.
 *
 * Registers ONE `session/event` observer for every child Session of the host (a
 * child lives in its own context, so the observer must bypass the context filter)
 * plus a `session/disposed` release, and keeps a bounded table of the delegations
 * that armed it.
 * @param options - the plugin `ctx` and a warning sink.
 * @returns the arm/release seam, the raw `observe` fold, and a disposer.
 */
export function createToolCallBudgetMonitor(options = {}) {
  const { ctx, log } = options
  const maxRecords = asCount(options.maxRecords) || DEFAULT_MAX_RECORDS
  const records = new Map()

  const warn = (message) => {
    try {
      log?.(message)
    } catch {
      // A warning sink that throws must not escape into the Session commit path.
    }
  }

  /**
   * Insert a record, evicting the OLDEST INSERTION when the table is full.
   *
   * Not an LRU: a live record whose delegation keeps running is not re-ordered by
   * use, so an eviction is a real (if remote) loss of enforcement. The table is a
   * backstop against a leak, not the primary lifecycle — `release()` on disposal
   * is.
   */
  function remember(record) {
    if (!records.has(record.childSessionId) && records.size >= maxRecords) {
      for (const oldest of records.keys()) {
        records.delete(oldest)
        break
      }
    }
    records.set(record.childSessionId, record)
  }

  /**
   * Deliver the plugin-authored notice, at most once per delegation.
   *
   * The notice is the DURABLE audit record: it carries `used`/`limit`/`scope`/
   * `mode` into the child Session's own log, so a stop can be replayed even when
   * the child never gets another step. It is delivered on every stop, not only
   * under `wrap-up`, because an interrupted child is exactly the case a bare host
   * log line cannot answer "where did it stop, and how much was left".
   */
  function deliverNotice(record, used) {
    if (record.noticeSent === true) return
    record.noticeSent = true
    let delivered = false
    try {
      delivered = record.injectNotice?.(used) === true
    } catch (error) {
      warn(`[subagent-roles] role=${record.roleId} could not inject the wrap-up notice: ${String(error?.message ?? error)}`)
    }
    if (!delivered) {
      warn(`[subagent-roles] role=${record.roleId} wrap-up notice could not be delivered (no live local child agent); the stop is recorded in this log only`)
    }
  }

  /**
   * Report and enforce one budget stop.
   *
   * A delegation already being torn down is skipped: the core's own deadline and
   * the budget are orthogonal guards, and each must report itself rather than the
   * other's teardown being mislabelled as a budget breach.
   *
   * Enforcement runs at most ONCE PER TURN. A `session` budget stays breached for
   * the child's whole life and is never reset, so a parent that wakes the child
   * again must be able to stop it again — but a single crossing is followed by the
   * calls the scheduler appends for a stopped batch, each of which is a
   * `tool/call` too, and re-enforcing on those would only repeat one stop.
   */
  function breach(record, used, turn) {
    // The teardown predicate is what keeps the two orthogonal guards apart: when
    // the core's own deadline (or a user cancel) already aborted this delegation,
    // the stop is that guard's to report, not this one's. Contained because a
    // bookkeeping throw in here would disable the cap for the rest of the run.
    try {
      if (typeof record.isTornDown === 'function' && record.isTornDown() === true) return
    } catch (error) {
      warn(`[subagent-roles] role=${record.roleId} could not read the teardown state: ${String(error?.message ?? error)}`)
      return
    }
    if (turn !== undefined && record.enforcedTurn === turn) return
    record.enforcedTurn = turn
    // The FIRST crossing owns the reported facts; a later wake's larger count
    // must not rewrite what the delegation is reported to have stopped at.
    if (record.breached !== true) {
      record.breached = true
      record.usedAtBreach = used
    }
    const { limit, scope, mode } = record.policy
    warn(`[subagent-roles] role=${record.roleId} tool-call budget exceeded: used=${used} limit=${limit} scope=${scope} mode=${mode}`)
    deliverNotice(record, used)
    try {
      record.enforce?.()
    } catch (error) {
      warn(`[subagent-roles] role=${record.roleId} could not enforce the tool-call budget: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Apply the pinned threshold rules to one already-counted call.
   *
   * `used === limit` is NOT a breach. The call that crosses the limit tells the
   * child to wrap up; `wrap-up` then tolerates `grace` further calls before the
   * stop, while `interrupt` stops on that same call. `grace: 0` therefore IS
   * `interrupt`: the same notice and the same stop, on the same call.
   */
  function onToolCall(record, used, turn) {
    const { limit, mode, grace } = record.policy
    if (limit <= 0 || used <= limit) return
    if (mode === 'off') {
      // Warn once per crossing, not once per call beyond the limit.
      if (used === limit + 1) {
        warn(`[subagent-roles] role=${record.roleId} tool-call budget exhausted: used=${used} limit=${limit} scope=${record.policy.scope} mode=off`)
      }
      return
    }
    if (mode === 'interrupt') {
      breach(record, used, turn)
      return
    }
    // wrap-up: tell the child first, then tolerate the grace calls.
    deliverNotice(record, used)
    if (used >= limit + 1 + grace) breach(record, used, turn)
  }

  /**
   * Fold one committed Session event.
   *
   * Synchronous and fully contained on purpose: this runs inside
   * `Session.append()`'s commit path, so an exception escaping here would
   * corrupt the very log the guard reads.
   * @param session - the Session that committed the event.
   * @param event - the committed event (`{ type, data, ... }`).
   */
  function observe(session, event) {
    try {
      const id = session?.id
      const record = id === undefined ? undefined : records.get(id)
      if (record === undefined) return
      if (event?.type === 'tool/call') {
        record.used += 1
        onToolCall(record, record.used, event.data?.turn)
        return
      }
      // A continuable child's wake opens a new turn, which is the only
      // observable definition of "one count per background wake".
      if (event?.type === 'turn/start' && record.policy.scope === 'delegation') {
        record.used = 0
        record.noticeSent = false
        // The reported latch clears with the count: a new turn IS a new delegation
        // under this scope, and leaving it set would let the guard fire once per
        // child session and leave every later wake unbounded.
        record.breached = false
        record.usedAtBreach = undefined
        record.enforcedTurn = undefined
      }
    } catch (error) {
      warn(`[subagent-roles] tool-call budget monitor failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Track one delegation. Call after `start` resolves, when the child Session id
   * is known — a child cannot have made a tool call before its first model
   * request, which is always after `start` fulfilled.
   * @param spec - child session id, role id, policy, and the enforcement
   *   closures: `enforce` (stop the child), `injectNotice(used)` (deliver the
   *   durable notice), and `isTornDown` (whether another guard already stopped it).
   * @returns the record the delegation reports from.
   */
  function arm(spec) {
    const record = {
      childSessionId: spec.childSessionId,
      roleId: spec.roleId,
      policy: spec.policy,
      enforce: spec.enforce,
      injectNotice: spec.injectNotice,
      isTornDown: spec.isTornDown,
      used: 0,
      noticeSent: false,
      breached: false,
    }
    remember(record)
    return record
  }

  /** Forget one delegation. Safe to call twice. */
  function release(childSessionId) {
    records.delete(childSessionId)
  }

  const detach = []
  if (typeof ctx?.on === 'function') {
    // `global: true` bypasses context-filter checks; without it a child Session's
    // events would never reach this host-plane row.
    detach.push(ctx.on('session/event', observe, { global: true }))
    // The primary lifecycle, so a dead child's record does not sit in the bounded
    // table until an eviction takes a LIVE one with it.
    detach.push(ctx.on('session/disposed', (session) => {
      if (session?.id !== undefined) release(session.id)
    }, { global: true }))
  }

  return {
    arm,
    release,
    observe,
    /** Number of tracked delegations (diagnostics and tests). */
    get size() {
      return records.size
    },
    dispose: () => {
      for (const disposer of detach) {
        try {
          if (typeof disposer === 'function') disposer()
        } catch {
          // A disposed fiber already removed the listener.
        }
      }
      records.clear()
    },
  }
}
