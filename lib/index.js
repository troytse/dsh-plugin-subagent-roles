/**
 * `subagent-roles` — file-defined subagent roles for DeepSeek Harness.
 *
 * Host-plane plugin row (a profile bundle). It publishes no service, so it
 * needs no `isolate` realm; it consumes the host `tools`, `subagents`, and
 * `systemPrompt` registries.
 *
 * Three contributions:
 *  1. a scope-aware role catalog section (compact; empty when a project has no
 *     roles, when the delegation tool is not visible to that agent, or when
 *     the catalog is switched off);
 *  2. the `subagent_role` delegation tool, which applies the role persona and
 *     the role's tool policy to the child;
 *  3. an opt-in `subagent_roles` diagnostic tool.
 *
 * Role definitions live in FILES: `<projectRoot>/.dsh/roles/<id>.md` (project)
 * and `~/.dsh/roles/<id>.md` (global), project winning on id collision.
 */
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { Config } from './config.js'
import { renderRoleCatalog } from './catalog.js'
import { createRoleLoader } from './roles.js'
import { LOG_PREFIX, createRoleListTool, createRoleTool } from './tool.js'

export { Config }
export { createRoleLoader, parseRoleDocument, resolveDshHome } from './roles.js'
export { renderRoleCatalog } from './catalog.js'
export { expandToolFilter, globToRegExp } from './policy.js'
export { resolveRoleRoute } from './route.js'

/** Cordis plugin name. */
export const name = 'subagent-roles'
/** Hard dependencies: the tool registry and the subagent registry. */
export const inject = ['tools', 'subagents']

/**
 * Stable prompt section name. Deliberately namespaced rather than the official
 * `tool:<toolName>` convention: this is a global (host-plane) section that must
 * never collide with the scoped `tool:<name>` sections tool plugins register,
 * even when a deployment renames this plugin's tool to `subagent`.
 */
export const CATALOG_SECTION_NAME = 'subagent-roles:catalog'

/**
 * Register the role catalog section, the delegation tool, and (optionally) the
 * diagnostic tool.
 * @param ctx - the plugin context.
 * @param config - the resolved row config.
 */
export function apply(ctx, config = {}) {
  const toolName = config.toolName ?? 'subagent_role'
  const providerName = config.subagentProvider ?? 'spawn'
  const loader = createRoleLoader({
    projectRootMarkers: config.projectRootMarkers,
    dshHome: config.dshHome,
    maxBodyBytes: config.maxBodyBytes,
  })
  /**
   * A roles plugin must never take the harness down with it: a failure here is
   * logged and the contribution is skipped, so a bad config or an unexpected
   * host shape costs roles, not the whole profile boot.
   */
  const safely = (label, run) => {
    try {
      return run()
    } catch (error) {
      ctx.logger?.error?.(`[${LOG_PREFIX}] ${label} failed: ${String(error?.message ?? error)}`)
      return undefined
    }
  }

  // ---- delegation tool ----------------------------------------------------
  let definition
  let disposeTool
  const backgroundEnabled = config.enableRunInBackground !== false
  const mount = (provider) => safely(`registering ${toolName} on transport "${providerName}"`, () => {
    const capabilities = provider.capabilities ?? {}
    if (typeof config.maxDepth === 'number' && !capabilities.depthLimit) {
      throw new Error(`provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed'`)
    }
    // Continuable children are only ever started from the background path, so
    // the capability is required exactly when that path is reachable.
    if ((config.backgroundMode ?? 'one-shot') === 'continuable') {
      if (!backgroundEnabled) {
        ctx.logger?.warn?.(`[${LOG_PREFIX}] backgroundMode "continuable" is inactive while enableRunInBackground is false; delegations run one-shot`)
      } else if (provider.prepareContinuable === undefined) {
        throw new Error(`provider "${provider.name}" does not support backgroundMode: continuable — switch the subagent provider or use backgroundMode: "one-shot"`)
      }
    }
    const created = createRoleTool({ ctx, config, provider, loader })
    disposeTool = ctx.effect(() => ctx.tools.register(created), 'subagent-roles: delegation tool')
    // Only a REGISTERED definition may advertise the catalog: the section's
    // visibility guard compares against this exact object.
    definition = created
    ctx.logger?.info?.(`[${LOG_PREFIX}] registered ${toolName} on subagent transport "${providerName}" (backgroundMode ${config.backgroundMode ?? 'one-shot'})`)
  })
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === providerName && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== providerName || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
    definition = undefined
  })
  safely('mounting the delegation tool', () => {
    const present = ctx.subagents.getProvider(providerName)
    if (present !== undefined) mount(present)
    else ctx.logger?.info?.(`[${LOG_PREFIX}] subagent provider "${providerName}" is not registered yet; ${toolName} will register when it appears`)
  })

  // ---- role catalog section ----------------------------------------------
  const systemPrompt = safely('reading the systemPrompt service', () => ctx.get('systemPrompt'))
  if (systemPrompt === undefined) {
    // No prompt registry means no catalog. Say so: otherwise the plugin looks
    // installed while the model is never told which roles exist.
    ctx.logger?.warn?.(`[${LOG_PREFIX}] no systemPrompt service in this composition; the role catalog will not be advertised`)
  } else if ((config.catalog ?? 'compact') !== 'off') {
    safely('registering the role catalog section', () => {
      const order = Number(systemPrompt.getSectionOrder('TOOL_SUBAGENT'))
      ctx.effect(() => systemPrompt.section({
        name: CATALOG_SECTION_NAME,
        order: Number.isFinite(order) ? order + 1 : 2901,
        text: (context) => {
          try {
            const agent = context?.agent
            if (agent === undefined || agent === null) return ''
            if (definition === undefined) return ''
            // Advertise roles only where the delegation tool is actually usable:
            // a restricted child (or a shadowing registration) must not be told
            // about roles it cannot reach.
            if (ctx.tools.get(toolName, context.scope ?? agent) !== definition) return ''
            if ((config.catalogScope ?? 'main') === 'main' && delegationDepthOf(agent) > 0) return ''
            const { roles, diagnostics } = loader.loadSync(agent.session?.header?.cwd, { freshDiagnostics: true })
            for (const diagnostic of diagnostics) {
              ctx.logger?.warn?.(`[${LOG_PREFIX}] skipped ${diagnostic.id} (${diagnostic.source}) at ${diagnostic.path}: ${diagnostic.reason}`)
            }
            return renderRoleCatalog(roles, { toolName, descriptionMaxLength: config.catalogDescriptionMaxLength })
          } catch (error) {
            // Prompt assembly must never fail because role discovery hiccuped.
            // NOTE: this only covers the provider; the returned text is still
            // interpolated by the core, which is why role CATALOG fields are
            // validated to contain no `{{` at load time.
            ctx.logger?.warn?.(`[${LOG_PREFIX}] role catalog unavailable: ${String(error?.message ?? error)}`)
            return ''
          }
        },
      }), 'subagent-roles: catalog section')
    })
  }

  // ---- optional diagnostics ----------------------------------------------
  if (config.enableListTool === true) {
    safely('registering the subagent_roles diagnostic tool', () => {
      ctx.effect(() => ctx.tools.register(createRoleListTool({ ctx, config, loader })), 'subagent-roles: list tool')
    })
  }
}
