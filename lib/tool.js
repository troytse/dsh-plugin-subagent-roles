/**
 * Model-facing delegation: `subagent_role`.
 *
 * Parameters are deliberately minimal (`role`, `prompt`, `description`,
 * optional `run_in_background`) — the role file owns persona, route, and tool
 * policy, and every extra parameter costs schema characters in the main
 * agent's tool catalog.
 */
import { randomUUID } from 'node:crypto'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import {
  TOOL_CALL_BUDGET_REASON,
  TOOL_CALL_BUDGET_STATUS,
  resolveToolCallBudget,
  toolCallBudgetFailure,
} from './budget.js'
import {
  dropToolFilterNames,
  expandToolFilter,
  isUnrestrictableToolName,
  parseUnrestrictableToolNames,
  sumSchemaChars,
} from './policy.js'
import { resolveRoleRoute } from './route.js'

/** Log namespace for this plugin. */
export const LOG_PREFIX = 'subagent-roles'
/** Canonical structured-error prefix. */
const ERROR_PREFIX = 'subagent-roles:'

/** Whether a string is present and non-empty. */
function isEmpty(value) {
  return value === undefined || value === null || value === ''
}

/**
 * Collect the delegating agent's currently visible tool names.
 * @param ctx - plugin context.
 * @param agent - the delegating agent scope.
 * @returns the schema list, or undefined when the registry cannot answer (the
 *   caller must not treat that as "no tools are visible").
 */
function visibleToolSchemas(ctx, agent) {
  try {
    const schemas = ctx.tools.schemas(agent)
    // `run_code` is listed for PTC deployments but `tools.restrict()` throws on
    // it, so it must never reach a role's expanded policy.
    return Array.isArray(schemas)
      ? schemas.filter((schema) => !isUnrestrictableToolName(schema?.name))
      : undefined
  } catch (error) {
    ctx.logger?.warn?.(`[${LOG_PREFIX}] cannot read the visible tool catalog: ${String(error?.message ?? error)}`)
    return undefined
  }
}

/** Serialized-schema length per tool name, for budget diagnostics. */
function schemaCharsByName(schemas) {
  const map = {}
  for (const schema of schemas) {
    if (schema === null || typeof schema !== 'object' || typeof schema.name !== 'string') continue
    try {
      map[schema.name] = JSON.stringify(schema).length
    } catch {
      map[schema.name] = 0
    }
  }
  return map
}

/** Projection key the official delegation tool records its route policy under. */
export const MODEL_SELECTION_PROJECTION_KEY = 'subagentModelSelectionPolicy'

/**
 * Read one Session's DURABLE authorized-route policy, if it captured one.
 *
 * The official delegation tool does not consult the live setting per call: it
 * captures the list into the Session once, keeps it stable for that Session's
 * lifetime, and lets a child inherit its parent's capture. Reading the same
 * projection keeps a role delegation under the same authority as the generic
 * `subagent` tool instead of drifting with whatever the setting says right now.
 * An unregistered projection, an absent capture, or an unreadable service all
 * mean "this Session captured nothing" — never "no constraint was configured".
 * @param ctx - plugin context.
 * @param session - the delegating Session (a child falls back to its parent).
 * @returns the captured route list, or undefined when there is none.
 */
function capturedModelSelection(ctx, session) {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined || session === undefined || session === null) return undefined
  const read = (target) => {
    if (target === undefined || target === null) return undefined
    let state
    try {
      state = projections.stateOf(target, MODEL_SELECTION_PROJECTION_KEY)
    } catch {
      return undefined
    }
    // A registered-but-unpopulated projection folds to null; an empty list is not
    // a policy the official tool can record (it requires at least one route).
    if (!Array.isArray(state) || state.length === 0) return undefined
    const routes = state.filter((entry) => typeof entry?.provider === 'string' && typeof entry?.model === 'string')
    return routes.length > 0 ? routes.map((entry) => ({ provider: entry.provider, model: entry.model })) : undefined
  }
  const direct = read(session)
  if (direct !== undefined) return direct
  if (session.header?.origin !== 'subagent') return undefined
  let parent
  try {
    parent = ctx.get('sessions')?.get?.(session.header.parentSession)
  } catch {
    return undefined
  }
  return read(parent)
}

/**
 * Resolve the authorized model list governing one delegation.
 *
 * A durable per-Session capture wins; otherwise the live
 * `subagent-model-selection` setting seeds the Session (which is the official
 * rule too — the setting only decides the next eligible Session composition). A
 * missing seam or an unreadable section means "no constraint".
 * @param ctx - plugin context.
 * @param session - the delegating Session, when one is known.
 * @returns whether the section exists and the authorized route list, if any.
 */
export function readModelSelection(ctx, session) {
  const captured = capturedModelSelection(ctx, session)
  if (captured !== undefined) return { sectionPresent: true, allowedRoutes: captured }
  const settings = ctx.get('settings')
  if (settings === undefined) return { sectionPresent: false, allowedRoutes: undefined }
  // 0.2.0's settings service has no `get`: the durable projection captured above
  // is its only seam there, and it has already answered. Detect the method
  // instead of letting the read throw into an empty catch.
  if (typeof settings.get !== 'function') return { sectionPresent: false, allowedRoutes: undefined }
  let selection
  try {
    selection = settings.get('subagent-model-selection')
  } catch {
    return { sectionPresent: false, allowedRoutes: undefined }
  }
  if (selection === null || typeof selection !== 'object') return { sectionPresent: false, allowedRoutes: undefined }
  const models = Array.isArray(selection.allowedModels)
    ? selection.allowedModels.filter((entry) => typeof entry === 'object' && entry !== null
      && typeof entry.provider === 'string' && typeof entry.model === 'string')
    : []
  return {
    sectionPresent: true,
    allowedRoutes: selection.enabled === true && models.length > 0 ? models : undefined,
  }
}

/**
 * The route half a child inherits from its parent agent.
 *
 * The core helper reads the Session's request header and falls back to the
 * agent's own options; a minimal or partially constructed agent (a test double,
 * or a future host shape) may lack the header accessor entirely. Inheritance is
 * never worth failing a delegation over, so an unreadable parent degrades to
 * "nothing to inherit" rather than throwing.
 * @param agent - the delegating agent.
 * @returns the parent's route options, possibly empty.
 */
function parentRouteOptions(agent) {
  try {
    const options = parentAgentOptionsForDelegation(agent)
    if (options !== null && typeof options === 'object') return options
  } catch {
    // fall through to the agent's own options
  }
  return typeof agent?.options === 'object' && agent.options !== null ? agent.options : {}
}

/**
 * Preflight one child LLM route against the LIVE adapter before a child exists.
 *
 * The role file is the only route source, so a typo in `model` — or a
 * `reasoningEffort` the adapter does not know — must reach the delegating agent
 * as a correctable sentence, not as an opaque failure from inside child
 * creation. `llm.resolveCallConfig()` is the runtime that owns provider lookup,
 * exact-model metadata, and effort validation, so it is asked, rather than the
 * provider list being guessed at.
 *
 * Against an older deployment without that seam the check degrades to provider
 * membership, which is strictly weaker but never wrong.
 * @param ctx - plugin context.
 * @param agent - the delegating agent, which supplies the inherited route half.
 * @param agentOptions - the role's own route options (may be undefined).
 * @param signal - the tool-call signal.
 * @returns the effective route that was checked, or undefined when no route could
 *   be determined (that case belongs to the core, and is never guessed at here).
 * @throws when the effective route cannot be resolved.
 */
export async function preflightRoleRoute(ctx, agent, agentOptions, signal) {
  const parent = parentRouteOptions(agent)
  const provider = agentOptions?.provider ?? parent.provider
  const model = agentOptions?.model ?? parent.model
  if (provider === undefined || model === undefined) return undefined
  const routeChanged = provider !== parent.provider || model !== parent.model
  // An effort belongs to the model vocabulary it was chosen for: a role that
  // changed the route without naming one gets the new model's default, not the
  // parent's effort.
  const reasoningEffort = agentOptions?.reasoningEffort ?? (routeChanged ? undefined : parent.reasoningEffort)
  const requested = { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }
  const llm = ctx.get('llm')
  if (llm === undefined) return requested
  if (typeof llm.resolveCallConfig === 'function') {
    try {
      await llm.resolveCallConfig(requested, signal)
    } catch (error) {
      throw new Error(`${ERROR_PREFIX} cannot resolve the child LLM route \`${provider}/${model}\`${reasoningEffort !== undefined ? ` with reasoning effort \`${reasoningEffort}\`` : ''}: ${String(error?.message ?? error)}`)
    }
    return requested
  }
  let providers
  try {
    providers = llm.listProviders()
  } catch {
    // An unreadable provider list is not evidence that the route is wrong.
    return requested
  }
  if (!providers.some((entry) => entry.id === provider)) {
    const available = providers.map((entry) => entry.id)
    throw new Error(`${ERROR_PREFIX} LLM provider route ${provider} is not routable (no adapter serves it). Available providers: ${available.join(', ') || '(none)'}`)
  }
  return requested
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 *
 * A fresh child needs a standalone prompt; a forked child already sees this
 * conversation's completed turns, so telling the model that the child "does not
 * share this conversation's context" (or, worse, that it must restate
 * everything) is false for a fork — and a false prompt costs context or makes
 * the model repeat work it did not have to.
 * @param inheritsConversation - whether the child's conversation is seeded with
 *   the parent's completed turns. This says nothing about tool, service, scope,
 *   or authority inheritance.
 * @returns the tool `description` body and the `prompt` parameter description.
 */
export function providerWording(inheritsConversation) {
  if (inheritsConversation === true) {
    return {
      description: "Delegate a task to a role defined by a role file in this workspace or the global role directory: the child is seeded with this conversation's completed turns (it does not see the current in-flight turn). "
        + 'The role supplies the child persona, its LLM route, and its tool policy. '
        + 'Use it instead of the generic subagent tool whenever the task matches a role in the role catalog.',
      promptDescription: "The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new.",
    }
  }
  return {
    description: 'Delegate a self-contained task to a role defined by a role file in this workspace or the global role directory (a separate agent that works in its own context). '
      + 'The role supplies the child persona, its LLM route, and its tool policy. '
      + 'Use it instead of the generic subagent tool whenever the task matches a role in the role catalog.',
    promptDescription: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs.",
  }
}

/**
 * Build the model-facing parameter schema. `role` is required unless the row
 * configures `defaultRole`.
 * @param config - row config.
 * @param wording - the provider-appropriate prompt wording.
 * @returns the parameter spec.
 */
function createDelegationParameters(config, wording) {
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const parameters = {
    role: {
      type: 'string',
      ...(isEmpty(config.defaultRole) ? { required: true } : {}),
      description: 'Role id from the role catalog in this conversation (e.g. "code-reviewer").',
    },
    prompt: {
      type: 'string',
      required: true,
      description: wording.promptDescription,
    },
    description: {
      type: 'string',
      required: true,
      description: 'A short (3-5 word) description of the delegated task, for display.',
    },
  }
  if (config.enableRunInBackground !== false) {
    parameters.run_in_background = {
      type: 'boolean',
      description: continuable
        ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
        : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
    }
  }
  return parameters
}

/** The model-facing output schema: exactly one of background, continuable, foreground, or a budget stop. */
function createDelegationOutputSchema() {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'continuable' },
          subagentId: { type: 'string', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          runId: { type: 'string', required: true },
          output: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      {
        // A budget stop is a NORMAL result carrying a status, never an error:
        // the delegating agent must be able to choose "narrower task", "raise the
        // budget", or "accept the partial output", and a thrown error instead
        // reads as a retriable tool fault.
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'budget-exceeded' },
          status: { type: 'string', required: true, const: TOOL_CALL_BUDGET_STATUS },
          reason: { type: 'string', required: true, const: TOOL_CALL_BUDGET_REASON },
          role: { type: 'string', required: true },
          used: { type: 'integer', required: true },
          limit: { type: 'integer', required: true },
          scope: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          partialOutput: { type: 'string' },
          note: { type: 'string', required: true },
        },
      },
    ],
  }
}

/** Model-facing prose for a delegation stopped by its tool-call budget. */
function renderBudgetExceeded(value) {
  const lines = [
    value.note,
    `status: ${value.status} reason: ${value.reason} role: ${value.role} used: ${value.used} limit: ${value.limit} scope: ${value.scope} mode: ${value.mode}`,
    'This is a budget stop, not a tool failure: the child was stopped deliberately. Re-delegate a narrower task, raise `maxToolCalls` in the role file, or accept the partial output.',
  ]
  if (typeof value.partialOutput === 'string' && value.partialOutput.length > 0) {
    lines.push(`Partial output before the stop:\n${value.partialOutput}`)
  }
  return lines.join('\n')
}

/**
 * Render a delegation result the way the delegation tools have always rendered
 * it, except that the background line names THIS tool rather than the generic
 * `subagent`. The line is model-facing prose, not a parsed contract.
 */
export function renderDelegationResult(value, toolName) {
  if (value.kind === 'background') return `started background ${toolName} task ${value.jobId}`
  if (value.kind === 'continuable') return `started subagent ${value.subagentId}`
  if (value.kind === 'budget-exceeded') return renderBudgetExceeded(value)
  const blocks = Array.isArray(value.output) ? value.output : []
  return blocks
    .filter((block) => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** A non-completed stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * The child's own text blocks, joined — its durable partial answer.
 * @param result - a terminal (or aborted) `SubagentResult`, possibly undefined.
 * @returns the concatenated text, or `''` when the child produced none.
 */
function textOutputOf(result) {
  return (Array.isArray(result?.output) ? result.output : [])
    .filter((block) => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Append the provider-authored diagnostic and the child's preserved partial
 * answer to a stop-reason error.
 *
 * `SubagentResult.diagnostic` is the ONLY channel carrying a provider's own
 * failure detail (it is byte-limited by the subagent runtime precisely so it can
 * be shown). Dropping it leaves the delegating agent with a bare "subagent run
 * failed" it can neither act on nor report.
 * @param error - the stop-reason headline.
 * @param result - the child's terminal result.
 * @returns the headline, diagnostic, and partial text that are present.
 */
function withDiagnosticAndPartialText(error, result) {
  const diagnostic = result?.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = textOutputOf(result)
  return `${error}${diagnostic}${text.length === 0 ? '' : `\nPartial output before the run ended:\n${text}`}`
}

/**
 * Resolve the live child Agent a wrap-up notice can be injected into.
 *
 * 0.2.1 publishes no `localAgent` on the activation, so the live agent registry
 * is the only route for both one-shot and continuable children. A remote
 * provider publishes no local agent at all — that must degrade to an immediate
 * stop rather than a notice nobody reads.
 * @param ctx - plugin context.
 * @param childSessionId - the durable child session id.
 * @returns the live agent, or undefined when there is none.
 */
function liveChildAgent(ctx, childSessionId) {
  try {
    return ctx.get('agents')?.get?.(childSessionId)
  } catch {
    // An unreadable agent registry costs the wrap-up notice, never the guard.
    return undefined
  }
}

/**
 * Inject the system-side wrap-up notice and report whether it landed.
 *
 * `Agent.inject()` queues at the next step boundary WITHOUT waking the driver,
 * which is exactly "read this and wrap up". `steer()`/`followup()` would wake an
 * idle child into a fresh turn and turn the notice into extra work.
 * @param agent - the live child Agent, when there is one.
 * @param roleId - the role, for the model-facing text.
 * @param used - tool calls observed before the notice.
 * @param limit - the role's budget.
 * @returns whether the notice was queued.
 */
function injectBudgetNotice(agent, roleId, used, limit) {
  if (agent === undefined || typeof agent.inject !== 'function') return false
  agent.inject(createUserMessage({
    content: [{
      type: 'text',
      text: `Tool-call budget exhausted for role "${roleId}": ${used} of ${limit} tool calls are used. Stop investigating now and produce your final answer — the conclusions you already have plus an explicit list of what you could not finish. Any further tool call will be cut off.`,
    }],
    // An explicit plugin source is MANDATORY: an omitted source resolves to
    // `user`, which would let this machine-generated instruction impersonate
    // human input and inherit human authority.
    source: { kind: 'plugin', plugin: LOG_PREFIX, form: 'notice', summary: boundContextSummary(`tool-call budget exhausted (${used}/${limit})`) },
  }))
  return true
}

/**
 * Forward one signal's cancellation into a controller this plugin owns.
 *
 * `AbortSignal.any()` would be shorter, but it only landed in Node 20.3 while
 * this plugin declares `engines: >= 20`; the manual forward is exact and
 * version-free. `onUpstreamAbort` runs first so the budget record can mark
 * itself torn down before the abort propagates.
 * @param source - the caller's signal.
 * @param controller - the controller this plugin owns.
 * @param onUpstreamAbort - optional bookkeeping, run before the abort propagates.
 * @returns a disposer that detaches the forward, for use on the settling path —
 *   `exec.signal` is the per-TURN phase signal, so an undetached listener would
 *   accumulate over every delegation made in one turn.
 */
function forwardAbort(source, controller, onUpstreamAbort) {
  const abort = () => {
    try {
      onUpstreamAbort?.()
    } catch {
      // Never let a bookkeeping hook block the cancellation itself.
    }
    controller.abort(source?.reason ?? 'upstream cancellation')
  }
  if (source?.aborted === true) {
    abort()
    return () => {}
  }
  source?.addEventListener?.('abort', abort, { once: true })
  return () => {
    try {
      source?.removeEventListener?.('abort', abort)
    } catch {
      // A signal that refuses removal still drops the listener with its own GC.
    }
  }
}

/**
 * Collect and release one foreground activation without letting disposal mask a
 * result failure.
 *
 * 0.2.1 replaced the one-shot `SubagentRun` with `SubagentActivation`: the id
 * lives on `childId`, and `result` / `dispose()` keep their meaning.
 * @param activation - the started activation.
 * @param record - the armed budget record, when the role is budgeted.
 */
async function settleForegroundRun(activation, record) {
  const [execution] = await Promise.allSettled([
    activation.result.then((result) => {
      // A budget stop is a structured, non-error outcome. Telling it apart from a
      // fault is the whole point: the delegating agent chooses what to do next.
      if (record?.breached === true) return toolCallBudgetFailure(record, textOutputOf(result))
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result))
      return { kind: 'foreground', runId: String(activation.childId), output: result.output }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => activation.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason], `${ERROR_PREFIX} subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`)
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Map one terminal `SubagentResult` to the `ctx.jobs` outcome vocabulary.
 *
 * This is the plugin's own copy of the mapping the 0.2.0 runtime exposed as
 * `settleRun`: 0.2.1 only exports the lower-level `settleRunResult`, and a job
 * still needs `completed` / `killed` / `failed` plus its detail.
 * @param result - the child's terminal result.
 * @returns the job outcome.
 */
function activationOutcome(result) {
  const detail = result?.diagnostic === undefined
    ? String(result?.stopReason)
    : `${String(result?.stopReason)}; diagnostic: ${result.diagnostic}`
  switch (result?.stopReason) {
    case 'completed':
      return { status: 'completed', result: textOutputOf(result) }
    case 'aborted':
      // Local cancellation carries no diagnostic; a provider-diagnosed abort does,
      // and that detail must not be flattened into a bare `killed`.
      return result?.diagnostic === undefined ? { status: 'killed' } : { status: 'failed', detail }
    default:
      return { status: 'failed', detail }
  }
}

/**
 * Settle one activation for a background job: await its result, release it, and
 * never reject the job producer contract.
 * @param activation - the started activation.
 * @returns the job outcome.
 */
async function settleActivation(activation) {
  let outcome
  try {
    outcome = activationOutcome(await activation.result)
  } catch (error) {
    outcome = { status: 'failed', detail: String(error) }
  }
  try {
    await activation.dispose()
  } catch (error) {
    return {
      status: 'failed',
      detail: `${outcome.detail === undefined ? '' : `${outcome.detail}; `}dispose failed: ${String(error)}`,
    }
  }
  return outcome
}

/**
 * Decide how one call runs, mirroring the official delegation tool's matrix:
 * the background flag is `run_in_background ?? continuable`, and a call is only
 * admitted in the background when the row exposes that affordance at all.
 * @param request - the parsed tool arguments.
 * @param options - `backgroundEnabled` and `continuable` from the row config.
 * @returns the chosen route.
 * @throws when the model forces background while the row disables it.
 */
export function resolveDelegationMode(request, options) {
  if (!options.backgroundEnabled) {
    if (request.run_in_background === true) {
      throw new Error(`${ERROR_PREFIX} run_in_background is disabled for this tool instance (enableRunInBackground: false)`)
    }
    return { runInBackground: false, route: 'foreground' }
  }
  const runInBackground = (request.run_in_background ?? options.continuable) === true
  return {
    runInBackground,
    route: runInBackground ? (options.continuable ? 'continuable' : 'background') : 'foreground',
  }
}

/**
 * Settle a background child without rejecting the Task producer contract.
 *
 * `settleActivation` never rejects, and an aborted run folds to a bare `killed`,
 * which cannot be told apart from a user kill. A budget record lets the job say
 * which guard stopped it: the delegating agent may hold only the job id, so this
 * line and the child session's own record are its only evidence.
 * @param start - the start promise, settled INSIDE so a start failure keeps the same judgement.
 * @param signal - the controller's signal.
 * @param options - `onRun` to arm the budget once the run exists, `onSettled` to release it.
 */
async function settleBackgroundRun(start, signal, options = {}) {
  const { onRun, onSettled } = options
  let record
  const stopped = () => (record?.breached === true
    ? { status: 'failed', detail: `tool-call budget exceeded: used=${record.usedAtBreach ?? record.used} limit=${record.policy.limit} scope=${record.policy.scope} mode=${record.policy.mode}` }
    : undefined)
  try {
    const activation = await start
    // `onRun` arms the budget and may log, so it is fenced: a throw there must
    // not skip the settle below, which owns `activation.dispose()`. The failure is
    // re-thrown AFTER settling, so the reported outcome is unchanged.
    let armError
    try {
      record = onRun?.(activation)
    } catch (error) {
      armError = error
    }
    // Always settle: `settleActivation` owns `activation.dispose()`, so
    // short-circuiting it would leak the child this guard just stopped.
    const outcome = await settleActivation(activation)
    if (armError !== undefined) throw armError
    return stopped() ?? outcome
  } catch (error) {
    // Mirrors the official tool: a disposal failure (AggregateError) stays
    // `failed` even after cancellation, so the diagnostic is not swallowed.
    return stopped() ?? (signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) })
  } finally {
    onSettled?.(record)
  }
}

/**
 * Resolve one role by id, then by exact displayName.
 *
 * A displayName is a human label, not an identity: a project role and a global
 * role may share one. Falling back to it is allowed, but a SHARED label is
 * reported rather than silently resolved to whichever file happened to load
 * first — it is logged for the operator, which is the only channel that sees it
 * (the tool result carries no warnings).
 * @param roles - merged role records.
 * @param requested - the requested id or display name.
 * @returns the role plus a warning when a display name was used.
 */
function resolveRole(roles, requested) {
  const byId = roles.find((role) => role.id === requested)
  if (byId !== undefined) return { role: byId }
  const byDisplay = roles.filter((role) => role.displayName === requested)
  if (byDisplay.length === 0) {
    const known = roles.map((role) => role.id).join(', ') || '(none)'
    throw new Error(`${ERROR_PREFIX} role "${requested}" does not exist in this workspace; available roles: ${known}`)
  }
  const chosen = byDisplay[0]
  if (byDisplay.length > 1) {
    return {
      role: chosen,
      warning: `${ERROR_PREFIX} displayName "${requested}" is shared by ${byDisplay.length} roles (${byDisplay.map((role) => role.id).join(', ')}); resolved to id "${chosen.id}" — pass the id to choose deliberately`,
    }
  }
  return {
    role: chosen,
    warning: `${ERROR_PREFIX} role "${requested}" is not an id; resolved by displayName to id "${chosen.id}" — prefer passing the id`,
  }
}

/** Capability gate: a resolved feature demands the matching transport capability. */
export function assertDelegationCapabilities(options) {
  const { providerName, agentOptions, capabilities, maxDepth } = options
  // persona and toolFilter are no longer transport capabilities in 0.2.1: the
  // plugin installs them on the child context itself, so only the two start-time
  // options the host still negotiates remain gated here.
  if (agentOptions !== undefined && !capabilities.agentOptions) {
    throw new Error(`${ERROR_PREFIX} role binds an LLM route but transport provider "${providerName}" does not support the agentOptions capability — switch the subagent provider or drop the role's provider/model`)
  }
  if (typeof maxDepth === 'number' && !capabilities.depthLimit) {
    throw new Error(`${ERROR_PREFIX} transport provider "${providerName}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed'`)
  }
}

/**
 * Named tool entries a per-delegation policy summary spells out before it
 * elides the rest.
 *
 * The info line is a human-read record, and a role's `allow`/`deny` list is
 * arbitrary-length — one `*` glob expands to every visible tool — so it is
 * capped. A large filter must never turn one routine delegation into a wall of
 * names; the full JSON is mirrored to `debug` for the rare case the exact list
 * matters.
 */
const POLICY_SUMMARY_NAMES = 4

/**
 * Bounded one-line summary of a role's expanded tool filter.
 * @param toolFilter - the expanded filter, or undefined when the role binds none.
 * @returns `allow=N[a,b,…] deny=M[c]`, or `none`.
 */
function summarizeToolFilter(toolFilter) {
  if (toolFilter === null || typeof toolFilter !== 'object') return 'none'
  const parts = []
  for (const key of ['allow', 'deny']) {
    const names = toolFilter[key]
    if (!Array.isArray(names)) continue
    const head = names.slice(0, POLICY_SUMMARY_NAMES).join(',')
    parts.push(`${key}=${names.length}${names.length > 0 ? `[${head}${names.length > POLICY_SUMMARY_NAMES ? ',…' : ''}]` : ''}`)
  }
  return parts.length > 0 ? parts.join(' ') : 'none'
}

/**
 * Bounded one-line summary of the effective route.
 *
 * `route.agentOptions` is normally the three-key route, but it is also the merge
 * point for a provider's `agentRouteDefaults`, so the info line reads only the
 * fields an operator scans and leaves the exact object to the debug line.
 * @param agentOptions - the resolved route options, or undefined when inheriting.
 * @returns `provider/model[/effort]`, or `inherit`.
 */
function summarizeRoute(agentOptions) {
  if (agentOptions === null || typeof agentOptions !== 'object') return 'inherit'
  const effort = typeof agentOptions.reasoningEffort === 'string' && agentOptions.reasoningEffort.length > 0
    ? agentOptions.reasoningEffort
    : undefined
  const pair = [agentOptions.provider, agentOptions.model].filter((part) => typeof part === 'string' && part.length > 0).join('/')
  if (pair.length === 0) {
    // A role may bind ONLY an effort (no provider/model — `roles.js` does not force
    // the pair). The child then really receives `{ reasoningEffort }`, so a bare
    // `inherit` would state the opposite of what was bound, and `debug` sits below a
    // default exporter's level: the info line is all a default deployment can read.
    return effort === undefined ? 'inherit' : `inherit+effort=${effort}`
  }
  return effort === undefined ? pair : `${pair}/${effort}`
}

/**
 * Create the `subagent_role` tool for one mounted transport provider.
 * @param options - ctx, config, provider, the role loader, the budget monitor,
 *   and the live budget-defaults reader.
 * @returns the registry-ready definition.
 */
export function createRoleTool(options) {
  const { ctx, config, provider, loader, budgetMonitor } = options
  /**
   * The budget defaults a role file may omit — the settings user layer over the
   * row config. Read PER DELEGATION so a Settings edit applies to the next one
   * without a restart.
   */
  const readBudgetSettings = options.readBudgetSettings ?? (() => ({
    maxToolCalls: config.defaultMaxToolCalls ?? 0,
    maxToolCallsHardCap: config.maxToolCallsHardCap ?? 0,
    onToolCallBudget: config.onToolCallBudget ?? 'wrap-up',
    graceToolCalls: config.graceToolCalls ?? 1,
  }))
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent_role'
  const providerName = config.subagentProvider ?? 'spawn'
  const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined

  // ---- role composition bridge -------------------------------------------
  // 0.2.1 no longer accepts persona/toolFilter in the start request: the host
  // composes a child from its preset only. The documented lifecycle event fires
  // synchronously inside the host's materialization — after the child Agent
  // exists but BEFORE its initial prompt is submitted — so a listener can install
  // the exact same section/restriction the old core applied inline.
  //
  // Correlation: `startActivation` accepts a caller-supplied childId. The plugin
  // generates it, records the role composition under it, and the listener looks
  // it up by the id the host publishes. Without that key the event would arrive
  // before `startActivation` resolved and there would be nothing to match on.
  const pendingComposition = new Map()
  /** Composition failures that must fail the delegation after the child exists. */
  const compositionErrors = new Map()

  /** Install one role's persona and tool policy on a freshly created child. */
  function installComposition(child, composition) {
    let applied = false
    const prompt = child?.ctx?.systemPrompt
    if (composition.persona !== undefined && typeof prompt?.section === 'function') {
      const order = Number(prompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX'))
      prompt.section({
        name: 'deployment:persona-prefix',
        order: Number.isFinite(order) ? order : 0,
        text: composition.persona,
      })
      applied = true
    }
    const tools = child?.ctx?.tools
    if (composition.toolFilter !== undefined && typeof tools?.restrict === 'function') {
      try {
        tools.restrict(composition.toolFilter)
      } catch (error) {
        // A tool registered on the delegating agent's own layer is visible to the
        // parent but unknown to the child's scope. Drop exactly those names and
        // retry, instead of losing the whole policy to one opaque rejection.
        // Under `onMissingTool: 'error'` the caller asked for loudness, so the
        // original failure is kept and surfaces from `startDelegation`.
        if (composition.onMissing === 'error') throw error
        const names = parseUnrestrictableToolNames(error)
        const next = names.length === 0 ? undefined : dropToolFilterNames(composition.toolFilter, names)
        if (next === undefined) throw error
        tools.restrict(next)
        ctx.logger?.warn?.(`[${LOG_PREFIX}] the child's scope cannot restrict ${names.map((name) => `"${name}"`).join(', ')}; they were dropped from the role's tool policy`)
      }
      applied = true
    }
    return applied
  }

  /** Look up the live child for one pending composition and install it once. */
  function applyPendingComposition(childId) {
    const composition = pendingComposition.get(childId)
    if (composition === undefined) return
    pendingComposition.delete(childId)
    let child
    try {
      child = ctx.get('agents')?.get?.(childId)
    } catch {
      child = undefined
    }
    if (child === undefined) {
      // A provider that publishes no local agent cannot receive a section or a
      // tool restriction; the delegation still runs, so say what was lost.
      ctx.logger?.warn?.(`[${LOG_PREFIX}] child ${String(childId)} was published without a live agent; its role persona/tool policy could not be applied`)
      return
    }
    try {
      installComposition(child, composition)
    } catch (error) {
      // The child already exists, so the caller must decide after `startActivation`
      // resolves: record it and let `startDelegation` dispose the child and fail.
      compositionErrors.set(childId, error)
      ctx.logger?.warn?.(`[${LOG_PREFIX}] applying the role composition to child ${String(childId)} failed: ${String(error?.message ?? error)}`)
    }
  }

  if (typeof ctx.effect === 'function' && typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('subagent/start', (info) => {
      if (info?.id !== undefined) applyPendingComposition(info.id)
    }), 'subagent-roles: role composition bridge')
  }

  // A fork provider seeds the child with this conversation's completed turns, so
  // the "self-contained prompt" wording would be false there.
  const wording = providerWording(provider?.inheritsParentContext === true)
  return defineTool({
    name: toolName,
    description: wording.description
      + (backgroundEnabled
        ? continuable
          ? ' Runs in the background by default and returns a durable subagent id; set run_in_background: false to wait.'
          : ' Waits for the result by default; set run_in_background: true to return a job id.'
        : ' Waits for the subagent and returns its result.'),
    parameters: createDelegationParameters(config, wording),
    output: {
      schema: createDelegationOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderDelegationResult(value, toolName) }],
    },
    // Enforced by the core's tool-call timeout policy, which swaps `exec.signal`
    // for a deadline signal before this body runs — and the foreground path
    // already forwards that signal into `ctx.subagents.start`, so the child dies
    // with the call. A background delegation returns immediately and never sees it.
    ...(typeof config.timeoutMs === 'number' ? { timeoutMs: config.timeoutMs } : {}),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error(`${ERROR_PREFIX} tool requires a calling agent (exec.agent was undefined)`)
      const cwd = agent.session?.header?.cwd
      // `freshDiagnostics` shares the loader's per-path "already surfaced" state
      // with the catalog provider (`lib/index.js`), so one bad role file — same
      // path, same reason — is logged ONCE per loader instead of on every
      // delegation. Only the operator is told: the loop below writes each finding
      // to `ctx.logger.warn`, and the `diagnostics` returned by the loader are
      // NOT put into the tool's result (the model never reads them). The
      // comparison is per identity, so a finding that clears (the file heals, a
      // shadow lifts) and comes back is logged again. The FULL inventory stays
      // available because the `subagent_roles` tool reads `loadSync` WITHOUT this
      // flag.
      const { roles, diagnostics } = loader.loadSync(cwd, { freshDiagnostics: true })
      for (const diagnostic of diagnostics) {
        ctx.logger?.warn?.(`[${LOG_PREFIX}] skipped ${diagnostic.id} (${diagnostic.source}) at ${diagnostic.path}: ${diagnostic.reason}`)
      }
      const requestedRaw = isEmpty(args.role) ? config.defaultRole : args.role
      const requested = typeof requestedRaw === 'string' ? requestedRaw.trim() : requestedRaw
      if (isEmpty(requested)) {
        const known = roles.map((role) => role.id).join(', ') || '(none)'
        throw new Error(`${ERROR_PREFIX} no role was given and no defaultRole is configured; available roles: ${known}`)
      }
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error(`${ERROR_PREFIX} \`description\` must be a short non-empty task label (it becomes the child's session label)`)
      }
      const resolved = resolveRole(roles, requested)
      const role = resolved.role
      if (resolved.warning !== undefined) ctx.logger?.warn?.(`[${LOG_PREFIX}] ${resolved.warning}`)
      const warnings = []

      // ---- route ------------------------------------------------------------
      const respectSelection = config.respectModelSelection !== false
      const selection = respectSelection
        ? readModelSelection(ctx, agent.session)
        : { sectionPresent: false, allowedRoutes: undefined }
      let route = resolveRoleRoute({ role, allowedRoutes: selection.allowedRoutes })
      warnings.push(...route.warnings)
      // Route warnings are the only signal that a role's binding was dropped, so
      // they must reach the log instead of a bare count in the info line.
      for (const message of route.warnings) ctx.logger?.warn?.(`[${LOG_PREFIX}] ${message}`)
      // A provider may advertise the route its children run on. Mirroring the
      // official tool, those defaults are merged UNDER the role's own binding —
      // and never over a route the authorized list just rejected.
      const routeDefaults = provider.agentRouteDefaults
      if (routeDefaults !== undefined && route.dropped !== true && route.agentOptions !== undefined) {
        const merged = { ...routeDefaults, ...route.agentOptions }
        if (merged.provider !== undefined && merged.model !== undefined) {
          route = { ...route, agentOptions: merged }
        }
      }
      // The role is the only route source, so a bad route must be reported here,
      // where the delegating agent can fix the role file — not thrown from inside
      // child creation as an opaque transport failure.
      await preflightRoleRoute(ctx, agent, route.agentOptions, exec.signal)

      // ---- tool policy ------------------------------------------------------
      const schemas = visibleToolSchemas(ctx, agent)
      const visibleNames = new Set((schemas ?? []).map((schema) => schema.name))
      let toolFilter
      let expansion
      if (role.toolFilter !== undefined) {
        if (schemas === undefined) {
          // Fail loud instead of guessing: an unreadable registry would expand
          // every entry to nothing, which is indistinguishable from a role that
          // genuinely allows no tool.
          throw new Error(`${ERROR_PREFIX} cannot apply role "${role.id}"'s tool policy: the visible tool catalog is unreadable`)
        }
        expansion = expandToolFilter(role.toolFilter, visibleNames, { onMissing: config.onMissingTool === 'error' ? 'error' : 'drop' })
        toolFilter = expansion.filter
        if (expansion.dropped.length > 0) {
          const message = `${ERROR_PREFIX} role "${role.id}" names unavailable tool(s) ${expansion.dropped.join(', ')}; they were left out of the child's policy`
          warnings.push(message)
          ctx.logger?.warn?.(`[${LOG_PREFIX}] ${message}`)
        }
        if (toolFilter?.allow?.length === 0) {
          const message = `${ERROR_PREFIX} role "${role.id}" allows no currently available tool; the child will see an empty tool set`
          warnings.push(message)
          ctx.logger?.warn?.(`[${LOG_PREFIX}] ${message}`)
        }
      }
      assertDelegationCapabilities({
        providerName,
        agentOptions: route.agentOptions,
        capabilities: provider.capabilities ?? {},
        maxDepth,
      })
      // The role file owns the number; the row config and the Settings namespace
      // supply the default a role file may omit plus the hard cap an operator
      // uses to keep a project from opening the budget to a meaningless size.
      const budgetDefaults = readBudgetSettings()
      const policy = resolveToolCallBudget({ role, defaults: budgetDefaults, hardCap: budgetDefaults.maxToolCallsHardCap })
      for (const message of policy.warnings) {
        warnings.push(message)
        ctx.logger?.warn?.(`[${LOG_PREFIX}] ${message}`)
      }
      // `0` means unlimited: the escape hatch skips counting AND enforcement, so
      // an unlimited role pays nothing for this feature.
      const tracked = policy.limit > 0 && budgetMonitor !== undefined

      // Resolved here, BEFORE the log: the row's `backgroundMode` alone does not
      // say how this call runs (`enableRunInBackground: false` forces one-shot),
      // and a log line that reports a mode the call never takes is worse than none.
      const mode = resolveDelegationMode(args, { backgroundEnabled, continuable })
      // Bounded on purpose: a `*` allow list expands to every visible tool, so
      // the filter is summarised rather than stringified, and the full route /
      // filter JSON is demoted to `debug`. One routine delegation must not emit a
      // single enormous line.
      ctx.logger?.info?.(`[${LOG_PREFIX}] delegate role=${role.id} transport=${providerName} mode=${mode.route} route=${summarizeRoute(route.agentOptions)} routeLayer=${route.layer} persona=${role.persona !== undefined ? 'yes' : 'no'} toolPolicy=${summarizeToolFilter(toolFilter)} maxToolCalls=${policy.limit > 0 ? `${policy.limit}(${policy.source}/${policy.scope}/${policy.mode}/grace=${policy.grace})` : 'unlimited'} warnings=${warnings.length}`)
      // The exact objects live here, not on the info line above. `debug` sits below a
      // default exporter's level (raise it to read these), and the exporter's own line
      // cap still applies — this is "the exact objects", not an unbounded dump.
      ctx.logger?.debug?.(`[${LOG_PREFIX}] delegate detail role=${role.id} route=${JSON.stringify(route.agentOptions ?? null)} toolPolicy=${toolFilter !== undefined ? JSON.stringify(toolFilter) : 'none'}`)

      // ---- start ------------------------------------------------------------
      // 0.2.1 moved `label`/`signal` onto the activation spec and dropped
      // persona/toolFilter from the request. Composition is installed on the
      // child through `subagent/start` (see the bridge above), correlated by a
      // childId this plugin picks before the call.
      const request = {
        prompt: [{ type: 'text', text: args.prompt }],
        parent: agent,
        ...(route.agentOptions !== undefined ? { agentOptions: route.agentOptions } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      }
      const composition = {
        ...(role.persona !== undefined ? { persona: role.persona } : {}),
        ...(toolFilter !== undefined ? { toolFilter } : {}),
        onMissing: config.onMissingTool === 'error' ? 'error' : 'drop',
      }
      const hasComposition = composition.persona !== undefined || composition.toolFilter !== undefined

      /**
       * Start one activation for this call.
       * @param signal - the cancellation signal the child observes.
       * @returns the published activation.
       */
      const startDelegation = async (signal) => {
        const childId = randomUUID()
        if (hasComposition) pendingComposition.set(childId, composition)
        try {
          const activation = await ctx.subagents.startActivation({
            provider: providerName,
            label: args.description,
            childId,
            request,
            signal,
            delivery: 'parent',
          })
          // The listener normally consumed the entry. A provider that publishes
          // no local agent, or ignores the requested childId, leaves it behind,
          // so move it to the published id and fall back to that instead of
          // losing the composition.
          const publishedId = activation?.childId
          if (hasComposition && publishedId !== undefined && publishedId !== childId && pendingComposition.has(childId)) {
            pendingComposition.set(publishedId, pendingComposition.get(childId))
            pendingComposition.delete(childId)
          }
          applyPendingComposition(publishedId ?? childId)
          // A composition failure recorded by the bridge means the child exists
          // but does not carry the role it was asked for. Fail the delegation and
          // release the child rather than running an uncomposed subagent.
          const compositionError = compositionErrors.get(childId) ?? compositionErrors.get(publishedId)
          if (compositionError !== undefined) {
            compositionErrors.delete(childId)
            compositionErrors.delete(publishedId)
            try {
              await activation?.dispose?.()
            } catch {}
            throw compositionError
          }
          // Nothing is left to correlate once the child is published.
          pendingComposition.delete(childId)
          pendingComposition.delete(publishedId)
          return activation
        } catch (error) {
          pendingComposition.delete(childId)
          compositionErrors.delete(childId)
          throw error
        }
      }

      /**
       * Arm the monitor for one started child.
       * @param childSessionId - the durable child session id (`activation.childId`).
       * @param spec - the enforcement closures and the teardown predicate.
       * @returns the record to report from, or undefined when the role is unlimited.
       */
      const track = (childSessionId, spec) => (tracked
        ? budgetMonitor.arm({
          childSessionId,
          roleId: role.id,
          policy,
          enforce: spec.enforce,
          injectNotice: spec.injectNotice,
          isTornDown: spec.isTornDown,
        })
        : undefined)
      /** Warn without letting a throwing logger cost the caller its cleanup. */
      const safeLog = (message) => {
        try {
          ctx.logger?.warn?.(message)
        } catch {
          // A logger must never break ownership cleanup or a tool result.
        }
      }
      /**
       * Say so when the child cannot be observed at all.
       *
       * A remote provider publishes no local child, so its Session events never
       * reach this process and the budget can never fire. Warning is the point:
       * a guard that looks armed and is not is the exact failure this feature
       * exists to remove.
       * @param childSessionId - the durable child session id.
       */
      const warnIfUnobservable = (childSessionId) => {
        let live
        try {
          live = ctx.get('agents')?.get?.(childSessionId)
        } catch {
          live = undefined
        }
        if (live !== undefined) return
        const message = `role "${role.id}" declares a tool-call budget of ${policy.limit}, but transport "${providerName}" publishes no local child agent, so its tool calls cannot be counted here`
        warnings.push(message)
        safeLog(`[${LOG_PREFIX}] ${message}`)
      }
      /** The durable-notice closure for one child. */
      const notice = (childSessionId) => (used) => injectBudgetNotice(liveChildAgent(ctx, childSessionId), role.id, used, policy.limit)

      if (mode.route === 'continuable') {
        if (provider.prepareContinuable === undefined) {
          throw new Error(`${ERROR_PREFIX} transport provider "${providerName}" does not support backgroundMode: continuable — switch the subagent provider or use backgroundMode: "one-shot"`)
        }
        const activation = await startDelegation(exec.signal)
        // The child outlives this call and is stopped through the runtime, because
        // there is no run object to dispose here. The record is kept for the
        // child's whole life so `scope: session` survives the wake boundaries the
        // delegating agent drives with `send_message`; `interrupt` is the one
        // mechanism that reaches a continuable child.
        track(activation.childId, {
          enforce: () => ctx.subagents.interrupt(activation.childId, { kind: 'ancestor', agent }),
          injectNotice: notice(activation.childId),
        })
        return { kind: 'continuable', subagentId: activation.childId }
      }
      if (mode.route === 'background') {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) throw new Error(`${ERROR_PREFIX} background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`)
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: agent,
            run: () => {
              const controller = new AbortController()
              return {
                cancel: (reason) => controller.abort(reason ?? 'background subagent task killed'),
                // The start promise is settled INSIDE settleBackgroundRun, so a
                // start failure keeps the same killed/failed judgement.
                done: settleBackgroundRun(
                  startDelegation(controller.signal),
                  controller.signal,
                  {
                    onRun: (activation) => {
                      if (tracked) warnIfUnobservable(activation.childId)
                      return track(activation.childId, {
                        // A user kill and a budget stop both abort this controller.
                        // The predicate is consulted BEFORE `enforce` runs, which is
                        // what keeps a kill from being reported as a budget breach.
                        isTornDown: () => controller.signal.aborted,
                        enforce: () => controller.abort(TOOL_CALL_BUDGET_REASON),
                        injectNotice: notice(activation.childId),
                      })
                    },
                    onSettled: (record) => {
                      if (record !== undefined) budgetMonitor.release(record.childSessionId)
                    },
                  },
                ),
              }
            },
          }),
        }
      }
      // A foreground child is released when its result settles, so the plugin
      // hands it a signal it owns and forwards the caller's cancellation into it.
      const budgetController = tracked ? new AbortController() : undefined
      const detachForward = budgetController === undefined ? undefined : forwardAbort(exec.signal, budgetController)
      let record
      try {
        const activation = await startDelegation(budgetController?.signal ?? exec.signal)
        // Both calls can throw (one logs, the other arms the monitor) and neither
        // may skip `settleForegroundRun`, which owns `activation.dispose()`: a
        // diagnostics failure must never leak the child it was diagnosing.
        if (tracked) {
          try {
            warnIfUnobservable(activation.childId)
          } catch (error) {
            warnings.push(`could not check whether the budget is observable: ${String(error?.message ?? error)}`)
          }
        }
        try {
          record = track(activation.childId, {
            isTornDown: () => exec.signal.aborted,
            enforce: () => budgetController.abort(TOOL_CALL_BUDGET_REASON),
            injectNotice: notice(activation.childId),
          })
        } catch (error) {
          safeLog(`[${LOG_PREFIX}] could not arm the tool-call budget for this run (${String(error?.message ?? error)}); the run continues unguarded`)
        }
        return await settleForegroundRun(activation, record)
      } finally {
        // `exec.signal` is the per-TURN phase signal, so an undetached forward
        // would accumulate one listener per delegation made in that turn.
        detachForward?.()
        if (record !== undefined) budgetMonitor.release(record.childSessionId)
      }
    },
  })
}

/**
 * Optional diagnostic tool: what the loader sees, where it came from, what each
 * role's tool policy expands to (with schema-character budgets), and the
 * tool-call budget each role would get.
 * @param options - ctx, config, the role loader, and the budget-defaults reader.
 * @returns the registry-ready definition.
 */
export function createRoleListTool(options) {
  const { ctx, config, loader } = options
  const readBudgetSettings = options.readBudgetSettings ?? (() => ({
    maxToolCalls: config.defaultMaxToolCalls ?? 0,
    maxToolCallsHardCap: config.maxToolCallsHardCap ?? 0,
    onToolCallBudget: config.onToolCallBudget ?? 'wrap-up',
    graceToolCalls: config.graceToolCalls ?? 1,
  }))
  // Per-row, so a profile mounting two role rows does not have the second
  // registration throw on a name the first one already took.
  const listToolName = config.listToolName ?? 'subagent_roles'
  return defineTool({
    name: listToolName,
    description: 'Report the subagent role catalog for this workspace: role ids, source (project/global), file paths, bound routes, and the expanded tool policy with its schema-character budget. Diagnostic only.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      const cwd = agent?.session?.header?.cwd
      const { roles, diagnostics } = loader.loadSync(cwd)
      const schemas = agent === undefined ? undefined : visibleToolSchemas(ctx, agent)
      const chars = schemaCharsByName(schemas ?? [])
      const totalVisible = sumSchemaChars(chars, Object.keys(chars))
      const budgetDefaults = readBudgetSettings()
      const lines = [
        `cwd: ${cwd ?? '(none)'}`,
        `projectRoot: ${loader.projectRootFor(cwd) ?? '(none)'}`,
        `visible tools: ${schemas === undefined ? 'unreadable' : `${Object.keys(chars).length} (${totalVisible} schema chars)`}`,
        `roles: ${roles.length}`,
      ]
      for (const role of roles) {
        const route = [role.provider, role.model, role.reasoningEffort].filter((value) => value !== undefined).join(' / ') || '(inherits parent)'
        lines.push(`- ${role.id} [${role.source}] ${route}`)
        lines.push(`    path: ${role.path}`)
        lines.push(`    persona: ${role.persona === undefined ? '(none)' : `${role.persona.length} chars`}`)
        // The tool-call budget, with its provenance: a role file, the row/Settings
        // default, or the unlimited escape hatch.
        const budget = resolveToolCallBudget({ role, defaults: budgetDefaults, hardCap: budgetDefaults.maxToolCallsHardCap })
        lines.push(`    tool-call budget: ${budget.limit > 0 ? `${budget.limit} (${budget.source}, scope ${budget.scope}, mode ${budget.mode}, grace ${budget.grace})` : 'unlimited'}`)
        // The delegation path logs a clamp warning; a diagnostic that showed the
        // clamped number silently would hide why the number is not the declared one.
        for (const message of budget.warnings) lines.push(`    warning: ${message}`)
        if (role.toolFilter === undefined) {
          lines.push('    tool policy: (none — inherits every visible tool)')
        } else {
          const expansion = expandToolFilter(role.toolFilter, new Set(Object.keys(chars)), { onMissing: 'drop' })
          const filter = expansion.filter ?? {}
          lines.push(`    tool policy: ${JSON.stringify(role.toolFilter)}`)
          lines.push(`    expanded${schemas === undefined ? ' (tool catalog unreadable — NOT what the child would get)' : ''}: allow=[${(filter.allow ?? []).join(', ')}] deny=[${(filter.deny ?? []).join(', ')}]`)
          if (filter.allow !== undefined) {
            lines.push(`    budget: ${sumSchemaChars(chars, filter.allow)} of ${totalVisible} visible tool-schema chars`)
          }
          if (expansion.dropped.length > 0) lines.push(`    unavailable: ${expansion.dropped.join(', ')}`)
        }
      }
      if (diagnostics.length > 0) {
        lines.push(`skipped files: ${diagnostics.length}`)
        for (const diagnostic of diagnostics) lines.push(`- ${diagnostic.id} [${diagnostic.source}] ${diagnostic.path}: ${diagnostic.reason}`)
      }
      return lines.join('\n')
    },
  })
}
