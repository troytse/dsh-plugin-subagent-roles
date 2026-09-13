/**
 * Route resolution for one role delegation.
 *
 * The role FILE is the only route source (the tool exposes no per-call
 * provider/model overrides). When the official `subagent-model-selection`
 * section is enabled with an authorized list, a role route outside it is
 * dropped so the child inherits the parent's model — never silently swapped
 * for a different authorized route. The role's `reasoningEffort` rides only
 * with an admitted route: it belongs to that model's vocabulary.
 */

/**
 * Whether a provider/model pair is admitted by an authorized route list.
 * An absent or empty list admits everything; with a list, only an exact pair
 * is admitted (a partial route cannot be).
 * @param route - `{ provider?, model? }`.
 * @param allowedRoutes - the authorized list, if any.
 * @returns whether the route is admitted.
 */
export function isRouteAllowed(route, allowedRoutes) {
  if (allowedRoutes === undefined || allowedRoutes.length === 0) return true
  if (route.provider === undefined || route.model === undefined) return false
  return allowedRoutes.some((entry) => entry.provider === route.provider && entry.model === route.model)
}

/**
 * Resolve the child's AgentOptions from one role.
 *
 * The role's `reasoningEffort` rides only with an admitted route OR when the
 * role declares no route at all: an effort is part of the model vocabulary it
 * was chosen for, so a route dropped by the authorized-list constraint takes
 * its effort with it.
 * @param input - the role and the authorized route list.
 * @returns `{ agentOptions?, layer, warnings }`.
 */
export function resolveRoleRoute(input) {
  const { role, allowedRoutes } = input
  const warnings = []
  const provider = role?.provider
  const model = role?.model
  let effort = role?.reasoningEffort
  const routeDeclared = provider !== undefined || model !== undefined
  let admitted = routeDeclared
  if (routeDeclared && !isRouteAllowed({ provider, model }, allowedRoutes)) {
    admitted = false
    const described = provider !== undefined && model !== undefined ? `${provider}/${model}` : String(provider ?? model)
    warnings.push(`subagent-roles: role "${role?.id ?? 'unknown'}" binds LLM route ${described} which is not in the authorized model list (subagent-model-selection.allowedModels); the route and its reasoning effort were dropped and the subagent inherits the parent model`)
    effort = undefined
  }
  const agentOptions = {
    ...(admitted && provider !== undefined ? { provider } : {}),
    ...(admitted && model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  }
  const defined = Object.keys(agentOptions).length > 0
  return {
    ...(defined ? { agentOptions } : {}),
    layer: admitted && routeDeclared ? 'role' : 'inherit',
    /**
     * A route the role DID bind but the authorized list rejected. It must never
     * be quietly replaced by a provider's own route defaults: the list said no.
     */
    dropped: routeDeclared && !admitted,
    warnings,
  }
}
