/**
 * Settings namespace for the child-prompt trim.
 *
 * The trim rules are the one part of this plugin a deployment is expected to
 * retune per taste, so they are exposed through the host settings service: the
 * row config becomes the `base` layer, `~/.dsh/settings.yaml` (written by the
 * Web GUI's Settings → Plugins card, see `lib/client.js`) becomes the user
 * layer, and the trim listener reads the resolved value per assembly.
 *
 * A settings namespace alone renders NOTHING: the Plugins tab dispatches one
 * slot key per served namespace and pairs it with a card some plugin registered
 * under that key (`@deepseek-ai/dsh-client-ui-settings-plugins`). That is why
 * this file is paired with the browser half — host namespace plus card, or the
 * user sees an empty tab.
 */
import z from '@deepseek-ai/schemastery'
import { LOG_PREFIX } from './tool.js'
import { DEFAULT_CHILD_NAMES } from './trim.js'

/** The three trim postures, shared by the row config and the settings schema. */
export const TRIM_MODES = Object.freeze(['off', 'tools', 'full'])

/** Settings schema for one row's trim policy (mirrors the row config subset). */
export const TrimSettingsSchema = z.object({
  childPromptTrim: z.union([...TRIM_MODES]).default('full'),
  childPromptTrimNames: z.array(z.string()).default([...DEFAULT_CHILD_NAMES]),
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
 * Build the live trim-policy source a row reads per assembly.
 *
 * The row config answers until (and unless) the settings namespace attaches, so
 * a deployment without a settings provider keeps exactly the composed
 * behaviour. A namespace that cannot register — an invalid stored section, a
 * duplicate registration from a second row — is logged and degrades to the row
 * config: a settings problem must never cost the trim, let alone boot.
 * @param options - the plugin `ctx`, the row `config`, and the namespace to own.
 * @returns `read()` for the current policy and the disposer that detaches it.
 */
export function createTrimPolicySource(options) {
  const { ctx, config, namespace } = options
  const base = {
    childPromptTrim: config.childPromptTrim ?? 'full',
    childPromptTrimNames: [...(config.childPromptTrimNames ?? DEFAULT_CHILD_NAMES)],
  }
  let current = trimPolicyFrom(base)
  let detach
  let attached = false

  const attach = (settings) => {
    if (attached || settings?.register === undefined) return
    attached = true
    try {
      const scope = settings.register(namespace, TrimSettingsSchema, { base, applies: 'live' })
      current = trimPolicyFrom(scope.get())
      const unwatch = scope.watch(() => {
        current = trimPolicyFrom(scope.get())
      })
      detach = () => {
        if (typeof unwatch === 'function') unwatch()
      }
      ctx.logger?.info?.(`[${LOG_PREFIX}] child prompt trim is editable in Settings → Plugins (namespace "${namespace}")`)
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
    /** The policy to apply to the next assembly. */
    read: () => current,
    /** Detach the namespace and any pending injection. */
    dispose: () => {
      detach?.()
      if (typeof disposeInject === 'function') disposeInject()
    },
  }
}
