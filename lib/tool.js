/**
 * Model-facing delegation: `subagent_role`.
 *
 * Parameters are deliberately minimal (`role`, `prompt`, `description`,
 * optional `run_in_background`) — the role file owns persona, route, and tool
 * policy, and every extra parameter costs schema characters in the main
 * agent's tool catalog.
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parentAgentOptionsForDelegation, settleRun } from '@deepseek-ai/dsh-subagent'
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

/**
 * Start one child while tolerating names the CHILD cannot restrict.
 *
 * A child binds the parent's standing preset scope, not the parent agent's own
 * layer, so a tool registered per-agent (the shipped preset registers
 * `subagent`/`list_subagent_models` that way) is visible to the delegator but is
 * an unknown name to `tools.restrict()` inside the child's creation window. The
 * core throws; rather than surfacing an opaque error, drop the offending names
 * once and retry — under `onMissingTool: 'error'` the failure stays loud.
 * @param start - starts one child from a request.
 * @param request - the assembled subagent request.
 * @param context - role id, the row's missing-tool posture, and a warning sink.
 * @returns the started run.
 */
async function startToleratingUnrestrictableNames(start, request, context) {
  try {
    return await start(request)
  } catch (error) {
    const names = context.onMissing === 'error' || request.toolFilter === undefined
      ? []
      : parseUnrestrictableToolNames(error)
    if (names.length === 0) throw error
    const next = dropToolFilterNames(request.toolFilter, names)
    context.warn(`${ERROR_PREFIX} the child's scope cannot restrict ${names.map((name) => `"${name}"`).join(', ')} (tools registered on the delegating agent's own layer are not inherited by a child); they were dropped from role "${context.roleId}"'s tool policy`)
    return await start({ ...request, toolFilter: next })
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
 * A local one-shot run hands its own published child over as `run.localAgent`; a
 * continuable child is looked up in the live agent registry, because
 * `startContinuable` resolves with ids rather than a run. A remote provider
 * publishes no local agent at all — that must degrade to an immediate stop
 * rather than a notice nobody reads.
 * @param ctx - plugin context.
 * @param run - the one-shot run, when the caller has one.
 * @param childSessionId - the durable child session id.
 * @returns the live agent, or undefined when there is none.
 */
function liveChildAgent(ctx, run, childSessionId) {
  if (run?.localAgent !== undefined && run.localAgent !== null) return run.localAgent
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
 * Collect and release one foreground run without letting disposal mask a result failure.
 * @param run - the started run.
 * @param record - the armed budget record, when the role is budgeted.
 */
async function settleForegroundRun(run, record) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      // A budget stop is a structured, non-error outcome. Telling it apart from a
      // fault is the whole point: the delegating agent chooses what to do next.
      if (record?.breached === true) return toolCallBudgetFailure(record, textOutputOf(result))
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result))
      return { kind: 'foreground', runId: String(run.id), output: result.output }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
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
 * `settleRun` never rejects, and an aborted run folds to a bare `killed`, which
 * cannot be told apart from a user kill. A budget record lets the job say which
 * guard stopped it: the delegating agent may hold only the job id, so this line
 * and the child session's own record are its only evidence.
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
    const run = await start
    record = onRun?.(run)
    // Always settle: `settleRun` owns `run.dispose()`, so short-circuiting it
    // would leak the run this guard just stopped.
    const outcome = await settleRun(run)
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
 * first — the delegating agent can only correct what it is told about.
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
  const { providerName, persona, toolFilter, agentOptions, capabilities, maxDepth } = options
  if (persona !== undefined && !capabilities.persona) {
    throw new Error(`${ERROR_PREFIX} role binds a persona but transport provider "${providerName}" does not support the persona capability — switch the subagent provider or drop the role persona`)
  }
  if (toolFilter !== undefined && !capabilities.toolFilter) {
    throw new Error(`${ERROR_PREFIX} role binds a tool policy but transport provider "${providerName}" does not support the toolFilter capability — switch the subagent provider or drop the policy`)
  }
  if (agentOptions !== undefined && !capabilities.agentOptions) {
    throw new Error(`${ERROR_PREFIX} role binds an LLM route but transport provider "${providerName}" does not support the agentOptions capability — switch the subagent provider or drop the role's provider/model`)
  }
  if (typeof maxDepth === 'number' && !capabilities.depthLimit) {
    throw new Error(`${ERROR_PREFIX} transport provider "${providerName}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed'`)
  }
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
      const { roles, diagnostics } = loader.loadSync(cwd)
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
        persona: role.persona,
        toolFilter,
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
      ctx.logger?.info?.(`[${LOG_PREFIX}] delegate role=${role.id} transport=${providerName} mode=${mode.route} route=${JSON.stringify(route.agentOptions ?? null)} routeLayer=${route.layer} persona=${role.persona !== undefined ? 'yes' : 'no'} toolPolicy=${toolFilter !== undefined ? JSON.stringify(toolFilter) : 'none'} maxToolCalls=${policy.limit > 0 ? `${policy.limit}(${policy.source}/${policy.scope}/${policy.mode}/grace=${policy.grace})` : 'unlimited'} warnings=${warnings.length}`)

      // ---- start ------------------------------------------------------------
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent: agent,
        ...(route.agentOptions !== undefined ? { agentOptions: route.agentOptions } : {}),
        ...(role.persona !== undefined ? { persona: role.persona } : {}),
        ...(toolFilter !== undefined ? { toolFilter } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      }
      const retry = {
        roleId: role.id,
        onMissing: config.onMissingTool === 'error' ? 'error' : 'drop',
        warn: (message) => {
          warnings.push(message)
          ctx.logger?.warn?.(`[${LOG_PREFIX}] ${message}`)
        },
      }
      /**
       * Arm the monitor for one started child.
       * @param childSessionId - the durable child session id (`SubagentRun.id` for a local run).
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
      /**
       * Say so when the child cannot be observed at all.
       *
       * A remote run publishes no local child (`SubagentRun.localAgent` is
       * undefined), so its Session events never reach this process and the budget
       * can never fire. Warning is the point: a guard that looks armed and is not
       * is the exact failure this feature exists to remove.
       */
      const warnIfUnobservable = (run) => {
        if (run?.localAgent !== undefined) return
        const message = `role "${role.id}" declares a tool-call budget of ${policy.limit}, but transport "${providerName}" publishes no local child agent, so its tool calls cannot be counted here`
        warnings.push(message)
        ctx.logger?.warn?.(`[${LOG_PREFIX}] ${message}`)
      }
      /** The durable-notice closure for one child (a continuable child has no run object). */
      const notice = (run, childSessionId) => (used) => injectBudgetNotice(liveChildAgent(ctx, run, childSessionId), role.id, used, policy.limit)

      if (mode.route === 'continuable') {
        if (provider.prepareContinuable === undefined) {
          throw new Error(`${ERROR_PREFIX} transport provider "${providerName}" does not support backgroundMode: continuable — switch the subagent provider or use backgroundMode: "one-shot"`)
        }
        const start = await startToleratingUnrestrictableNames(
          (candidate) => ctx.subagents.startContinuable({ provider: providerName, label: args.description, request: candidate, signal: exec.signal }),
          request,
          retry,
        )
        // The child outlives this call and is stopped through the runtime, because
        // there is no run object to abort here. The record is kept for the child's
        // whole life so `scope: session` survives the wake boundaries the
        // delegating agent drives with `send_message`; `interrupt` is the one
        // mechanism that reaches a continuable child.
        track(start.childId, {
          enforce: () => ctx.subagents.interrupt(start.childId, { kind: 'ancestor', agent }),
          injectNotice: notice(undefined, start.childId),
        })
        return { kind: 'continuable', subagentId: start.childId }
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
                  startToleratingUnrestrictableNames(
                    (candidate) => ctx.subagents.start(providerName, { ...candidate, signal: controller.signal }),
                    request,
                    retry,
                  ),
                  controller.signal,
                  {
                    onRun: (run) => {
                      if (tracked) warnIfUnobservable(run)
                      return track(run.id, {
                        // A user kill and a budget stop both abort this controller.
                        // The predicate is consulted BEFORE `enforce` runs, which is
                        // what keeps a kill from being reported as a budget breach.
                        isTornDown: () => controller.signal.aborted,
                        enforce: () => controller.abort(TOOL_CALL_BUDGET_REASON),
                        injectNotice: notice(run, run.id),
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
      // A foreground one-shot child cannot be interrupted — the runtime treats a
      // one-shot target as an accepted no-op — so the plugin hands the run a
      // signal it owns and forwards the caller's cancellation into it.
      const budgetController = tracked ? new AbortController() : undefined
      const detachForward = budgetController === undefined ? undefined : forwardAbort(exec.signal, budgetController)
      let record
      try {
        const run = await startToleratingUnrestrictableNames(
          (candidate) => ctx.subagents.start(providerName, { ...candidate, signal: budgetController?.signal ?? exec.signal }),
          request,
          retry,
        )
        if (tracked) warnIfUnobservable(run)
        record = track(run.id, {
          isTornDown: () => exec.signal.aborted,
          enforce: () => budgetController.abort(TOOL_CALL_BUDGET_REASON),
          injectNotice: notice(run, run.id),
        })
        return await settleForegroundRun(run, record)
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
