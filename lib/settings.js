/**
 * Retunable row policy: trim rules and the tool-call budget.
 *
 * DSH 0.2.1 removed plugin-registered settings namespaces (`settings.register`),
 * so there is no user layer to watch: the ROW CONFIG is the whole policy and the
 * plugin-manager config page edits exactly that row. The readers below keep the
 * same shape the rest of the plugin already consumes, which is why the switch is
 * a deletion rather than a rewrite.
 *
 * `SettingsSchema` survives as the single declaration of the retunable subset:
 * the row Config is the storage, and tests pin the config page's field list
 * against this schema so a knob cannot silently fall out of the GUI.
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
 * Build the policy source a row reads.
 *
 * In 0.2.1 the row config is the only storage: the plugin manager edits the
 * config schema, and a change restarts the row, so there is no watch to keep.
 * The returned shape is unchanged for the rest of the plugin.
 * @param options - the plugin `ctx` and the row `config`.
 * @returns `read()` for the trim policy, `readBudgetDefaults()` for the budget,
 *   and a no-op disposer kept for the caller's effect.
 */
export function createTrimPolicySource(options) {
  const { ctx, config } = options
  const base = {
    childPromptTrim: config.childPromptTrim ?? 'full',
    childPromptTrimNames: [...(config.childPromptTrimNames ?? DEFAULT_CHILD_NAMES)],
    defaultMaxToolCalls: config.defaultMaxToolCalls ?? 0,
    maxToolCallsHardCap: config.maxToolCallsHardCap ?? 0,
    onToolCallBudget: config.onToolCallBudget ?? 'wrap-up',
    graceToolCalls: config.graceToolCalls ?? 1,
  }
  const current = { trim: trimPolicyFrom(base), budget: budgetDefaultsFrom(base) }
  ctx.logger?.info?.(`[${LOG_PREFIX}] trim and tool-call budget follow the plugin row config; edit them from the Plugins page`)

  return {
    /** The trim policy to apply to the next assembly. */
    read: () => current.trim,
    /** The budget defaults to apply to the next delegation. */
    readBudgetDefaults: () => current.budget,
    /** Nothing to detach: the row config owns the values. */
    dispose: () => {},
  }
}
