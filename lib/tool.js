/**
 * Model-facing delegation: `subagent_role`.
 *
 * Parameters are deliberately minimal (`role`, `prompt`, `description`,
 * optional `run_in_background`) — the role file owns persona, route, and tool
 * policy, and every extra parameter costs schema characters in the main
 * agent's tool catalog.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settleRun } from '@deepseek-ai/dsh-subagent'
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
export const ERROR_PREFIX = 'subagent-roles:'

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

/**
 * Read the official `subagent-model-selection` section through the settings
 * seam. A missing seam or an unreadable section simply means "no constraint".
 * @param ctx - plugin context.
 * @returns whether the section exists and the authorized route list, if any.
 */
export function readModelSelection(ctx) {
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

/** Whether an LLM route has a registered adapter. */
function isProviderRoutable(ctx, provider) {
  const llm = ctx.get('llm')
  if (llm === undefined) return true
  try {
    return llm.listProviders().some((entry) => entry.id === provider)
  } catch {
    return true
  }
}

/**
 * Build the model-facing parameter schema. `role` is required unless the row
 * configures `defaultRole`.
 * @param config - row config.
 * @returns the parameter spec.
 */
export function createDelegationParameters(config) {
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const parameters = {
    role: {
      type: 'string',
      ...(isEmpty(config.defaultRole) ? { required: true } : {}),
      description: 'Role id from the role catalog in this conversation (e.g. "web-operator").',
    },
    prompt: {
      type: 'string',
      required: true,
      description: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs.",
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

/** The model-facing output schema: exactly one of background, continuable, or foreground. */
export function createDelegationOutputSchema() {
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
    ],
  }
}

/** Render a delegation result exactly as the delegation tools have always rendered. */
export function renderDelegationResult(value, toolName) {
  if (value.kind === 'background') return `started background ${toolName} task ${value.jobId}`
  if (value.kind === 'continuable') return `started subagent ${value.subagentId}`
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

/** Append the child's preserved partial answer to a stop-reason error. */
function withPartialText(error, output) {
  const text = (Array.isArray(output) ? output : [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

/** Collect and release one foreground run without letting disposal mask a result failure. */
async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
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

/** Settle a background child without rejecting the Task producer contract. */
async function settleBackgroundRun(start, signal) {
  try {
    return await settleRun(await start)
  } catch (error) {
    // Mirrors the official tool: a disposal failure (AggregateError) stays
    // `failed` even after cancellation, so the diagnostic is not swallowed.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/**
 * Resolve one role by id, then by exact displayName.
 * @param roles - merged role records.
 * @param requested - the requested id or display name.
 * @returns the role plus a warning when a display name was used.
 */
export function resolveRole(roles, requested) {
  const byId = roles.find((role) => role.id === requested)
  if (byId !== undefined) return { role: byId }
  const byDisplay = roles.find((role) => role.displayName === requested)
  if (byDisplay !== undefined) {
    return {
      role: byDisplay,
      warning: `${ERROR_PREFIX} role "${requested}" is not an id; resolved by displayName to id "${byDisplay.id}" — prefer passing the id`,
    }
  }
  const known = roles.map((role) => role.id).join(', ') || '(none)'
  throw new Error(`${ERROR_PREFIX} role "${requested}" does not exist in this workspace; available roles: ${known}`)
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
 * @param options - ctx, config, provider, and the role loader.
 * @returns the registry-ready definition.
 */
export function createRoleTool(options) {
  const { ctx, config, provider, loader } = options
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent_role'
  const providerName = config.subagentProvider ?? 'spawn'
  const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
  return defineTool({
    name: toolName,
    description: 'Delegate a self-contained task to a role defined by a role file in this workspace or the global role directory. '
      + 'The role supplies the child persona, its LLM route, and its tool policy. Use it instead of the generic subagent tool whenever the task matches a role in the role catalog.'
      + (backgroundEnabled
        ? continuable
          ? ' Runs in the background by default and returns a durable subagent id; set run_in_background: false to wait.'
          : ' Waits for the result by default; set run_in_background: true to return a job id.'
        : ' Waits for the subagent and returns its result.'),
    parameters: createDelegationParameters(config),
    output: {
      schema: createDelegationOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderDelegationResult(value, toolName) }],
    },
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
      const selection = respectSelection ? readModelSelection(ctx) : { sectionPresent: false, allowedRoutes: undefined }
      const route = resolveRoleRoute({ role, allowedRoutes: selection.allowedRoutes })
      warnings.push(...route.warnings)
      const routeProvider = route.agentOptions?.provider
      if (routeProvider !== undefined && !isProviderRoutable(ctx, routeProvider)) {
        const llm = ctx.get('llm')
        const available = llm === undefined ? [] : llm.listProviders().map((entry) => entry.id)
        throw new Error(`${ERROR_PREFIX} LLM provider route ${routeProvider} is not routable (no adapter serves it). Available providers: ${available.join(', ') || '(none)'}`)
      }

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
      ctx.logger?.info?.(`[${LOG_PREFIX}] delegate role=${role.id} transport=${providerName} mode=${continuable ? 'continuable' : 'one-shot'} route=${JSON.stringify(route.agentOptions ?? null)} persona=${role.persona !== undefined ? 'yes' : 'no'} toolPolicy=${toolFilter !== undefined ? JSON.stringify(toolFilter) : 'none'} warnings=${warnings.length}`)

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
      const mode = resolveDelegationMode(args, { backgroundEnabled, continuable })
      if (mode.route === 'continuable') {
        if (provider.prepareContinuable === undefined) {
          throw new Error(`${ERROR_PREFIX} transport provider "${providerName}" does not support backgroundMode: continuable — switch the subagent provider or use backgroundMode: "one-shot"`)
        }
        const start = await startToleratingUnrestrictableNames(
          (candidate) => ctx.subagents.startContinuable({ provider: providerName, label: args.description, request: candidate, signal: exec.signal }),
          request,
          retry,
        )
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
                ),
              }
            },
          }),
        }
      }
      return settleForegroundRun(await startToleratingUnrestrictableNames(
        (candidate) => ctx.subagents.start(providerName, { ...candidate, signal: exec.signal }),
        request,
        retry,
      ))
    },
  })
}

/**
 * Optional diagnostic tool: what the loader sees, where it came from, and what
 * each role's tool policy expands to (with schema-character budgets).
 * @param options - ctx, config, and the role loader.
 * @returns the registry-ready definition.
 */
export function createRoleListTool(options) {
  const { ctx, config, loader } = options
  return defineTool({
    name: 'subagent_roles',
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
