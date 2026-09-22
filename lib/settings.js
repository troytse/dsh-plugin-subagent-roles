/**
 * Settings namespace for the row's retunable policy.
 *
 * The trim rules and the tool-call budget are the two parts of this plugin a
 * deployment is expected to retune per taste, so they share ONE host settings
 * namespace: the host serves a namespace as a unit, and a second registration of
 * the same key would be refused. The row config becomes the `base` layer,
 * `~/.dsh/settings.yaml` (written by the Web GUI's Settings → Plugins card, see
 * `lib/client.js`) becomes the user layer, and the readers resolve live.
 *
 * A settings namespace alone renders NOTHING: the Plugins tab dispatches one
 * slot key per served namespace and pairs it with a card some plugin registered
 * under that key (`@deepseek-ai/dsh-client-ui-settings-plugins`). That is why
 * this file is paired with the browser half — host namespace plus card, or the
 * user sees an empty tab.
 */
import z from '@deepseek-ai/schemastery'
import { TOOL_CALL_BUDGET_MODES } from './roles.js'
import { LOG_PREFIX } from './tool.js'
import { DEFAULT_CHILD_NAMES } from './trim.js'

/** The three trim postures, shared by the row config and the settings schema. */
export const TRIM_MODES = Object.freeze(['off', 'tools', 'full'])

/** Settings schema for one row (mirrors the retunable subset of the row config). */
export const SettingsSchema = z.object({
  childPromptTrim: z.union([...TRIM_MODES]).default('full'),
  childPromptTrimNames: z.array(z.string()).default([...DEFAULT_CHILD_NAMES]),
  defaultMaxToolCalls: z.natural().default(0),
  maxToolCallsHardCap: z.natural().default(0),
  onToolCallBudget: z.union([...TOOL_CALL_BUDGET_MODES]).default('wrap-up'),
  graceToolCalls: z.natural().default(1),
})

/**
 * The settings namespace (and Settings card key) for one row.
 *
 * Namespaces are lowercase-hyphenated, so a renamed tool — the way a profile
 * mounts a second row — is slugged rather than used verbatim. The default row
 * keeps the stable `subagent-roles` name the browser half binds to.
 * @param toolName - the configured delegation tool name.
 * @returns the namespace for this row.
 */
export function settingsNamespaceFor(toolName) {
  const name = toolName ?? 'subagent_role'
  if (name === 'subagent_role') return 'subagent-roles'
  const slug = String(name).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '')
  return slug.length === 0 ? 'subagent-roles' : `subagent-roles-${slug}`
}

/** Normalize one resolved settings/config section into a trim policy. */
export function trimPolicyFrom(values) {
  const mode = TRIM_MODES.includes(values?.childPromptTrim) ? values.childPromptTrim : 'full'
  const names = Array.isArray(values?.childPromptTrimNames)
    ? values.childPromptTrimNames.filter((name) => typeof name === 'string')
    : [...DEFAULT_CHILD_NAMES]
  return { mode, dropNames: new Set(names) }
}

/**
 * Normalize one resolved settings/config section into the budget defaults a role
 * file may omit.
 *
 * The output uses the DELEGATION-facing names (`maxToolCalls`), while the input
 * uses the config/schema names (`defaultMaxToolCalls`): the settings key is the
 * row's default, and calling it `maxToolCalls` next to a role file's own
 * `maxToolCalls` would be ambiguous about which one wins.
 * @param values - the resolved settings section (or the row config as `base`).
 * @returns the normalized defaults.
 */
export function budgetDefaultsFrom(values) {
  const count = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback)
  return {
    maxToolCalls: count(values?.defaultMaxToolCalls, 0),
    maxToolCallsHardCap: count(values?.maxToolCallsHardCap, 0),
    onToolCallBudget: TOOL_CALL_BUDGET_MODES.includes(values?.onToolCallBudget) ? values.onToolCallBudget : 'wrap-up',
    graceToolCalls: count(values?.graceToolCalls, 1),
  }
}

/**
 * Build the live policy source a row reads.
 *
 * The row config answers until (and unless) the settings namespace attaches, so
 * a deployment without a settings provider keeps exactly the composed
 * behaviour. A namespace that cannot register — an invalid stored section, a
 * duplicate registration from a second row — is logged and degrades to the row
 * config: a settings problem must never cost the guard, let alone boot.
 * @param options - the plugin `ctx`, the row `config`, and the namespace to own.
 * @returns `read()` for the trim policy, `readBudgetDefaults()` for the budget,
 *   and the disposer that detaches both.
 */
export function createTrimPolicySource(options) {
  const { ctx, config, namespace } = options
  // Every retunable knob rides the ONE namespace, so the `base` layer must carry
  // them all: a key the base omits would silently fall back to the schema
  // default instead of the deployment's row config.
  const base = {
    childPromptTrim: config.childPromptTrim ?? 'full',
    childPromptTrimNames: [...(config.childPromptTrimNames ?? DEFAULT_CHILD_NAMES)],
    defaultMaxToolCalls: config.defaultMaxToolCalls ?? 0,
    maxToolCallsHardCap: config.maxToolCallsHardCap ?? 0,
    onToolCallBudget: config.onToolCallBudget ?? 'wrap-up',
    graceToolCalls: config.graceToolCalls ?? 1,
  }
  const resolve = (values) => ({ trim: trimPolicyFrom(values), budget: budgetDefaultsFrom(values) })
  let current = resolve(base)
  let detach
  let attached = false

  const attach = (settings) => {
    if (attached || settings?.register === undefined) return
    attached = true
    try {
      const scope = settings.register(namespace, SettingsSchema, { base, applies: 'live' })
      current = resolve(scope.get())
      const unwatch = scope.watch(() => {
        current = resolve(scope.get())
      })
      detach = () => {
        if (typeof unwatch === 'function') unwatch()
      }
      ctx.logger?.info?.(`[${LOG_PREFIX}] child prompt trim and tool-call budget are editable in Settings → Plugins (namespace "${namespace}")`)
    } catch (error) {
      attached = false
      ctx.logger?.warn?.(`[${LOG_PREFIX}] settings namespace "${namespace}" unavailable (${String(error?.message ?? error)}); the row config stays authoritative`)
    }
  }

  let disposeInject
  // `ctx.get` itself can throw on a host shape that requires an `inject`
  // declaration for the service; an unreadable settings seam must cost the
  // namespace, never the plugin row.
  let settings
  try {
    settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  } catch {
    settings = undefined
  }
  if (settings !== undefined) attach(settings)
  else if (typeof ctx.inject === 'function') {
    // A provider that mounts later still gets the namespace; the row config
    // answers until then.
    try {
      disposeInject = ctx.inject(['settings'], (settingsCtx) => attach(settingsCtx.settings))
    } catch (error) {
      ctx.logger?.warn?.(`[${LOG_PREFIX}] settings service unavailable (${String(error?.message ?? error)}); the row config stays authoritative`)
    }
  }

  return {
    /** The trim policy to apply to the next assembly. */
    read: () => current.trim,
    /** The budget defaults to apply to the next delegation. */
    readBudgetDefaults: () => current.budget,
    /** Detach the namespace and any pending injection. */
    dispose: () => {
      detach?.()
      if (typeof disposeInject === 'function') disposeInject()
    },
  }
}
