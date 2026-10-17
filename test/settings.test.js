/**
 * Host-side settings tests: the trim policy's namespace, its normalization, and
 * the live source a row reads, including every degradation path — a deployment
 * without a settings provider, and a namespace that refuses to register.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_CHILD_NAMES } from '../lib/trim.js'
import {
  SettingsSchema,
  TRIM_MODES,
  budgetDefaultsFrom,
  createTrimPolicySource,
  settingsNamespaceFor,
  trimPolicyFrom,
} from '../lib/settings.js'

/** A settings service stub with the real register/get/watch shape. */
function stubSettings(options = {}) {
  const registrations = []
  const watchers = []
  const unwatched = []
  let user = { ...(options.user ?? {}) }
  const service = {
    register(ns, schema, config) {
      if (options.throwOnRegister === true) throw new Error('namespace is already registered')
      registrations.push({ ns, schema, config })
      return {
        get: () => ({ ...config.base, ...user }),
        watch(callback) {
          watchers.push(callback)
          return () => unwatched.push(callback)
        },
        update: async (patch) => { user = { ...user, ...patch } },
        replace: async (section) => { user = { ...section } },
      }
    },
  }
  return {
    service,
    registrations,
    unwatched,
    setUser(next) {
      user = { ...next }
      for (const watcher of watchers) watcher()
    },
  }
}

/** A plugin context stub with just what the source touches. */
function stubCtx(options = {}) {
  const warnings = []
  const infos = []
  const disposers = []
  return {
    warnings,
    infos,
    disposers,
    ctx: {
      logger: {
        info: (message) => infos.push(String(message)),
        warn: (message) => warnings.push(String(message)),
        debug() {},
        error() {},
      },
      get: (name) => (name === 'settings' ? options.settings : undefined),
      inject: options.inject === undefined ? undefined : (names, callback) => {
        options.inject(names, callback)
        const disposer = () => disposers.push(names.join(','))
        return disposer
      },
    },
  }
}

/** Row config in the shape `Config` resolves it. */
function rowConfig(extra = {}) {
  return {
    childPromptTrim: 'full',
    childPromptTrimNames: [...DEFAULT_CHILD_NAMES],
    defaultMaxToolCalls: 0,
    maxToolCallsHardCap: 0,
    onToolCallBudget: 'wrap-up',
    graceToolCalls: 1,
    ...extra,
  }
}

describe('settings: budget defaults', () => {
  test('the schema mirrors the row config defaults for the budget too', () => {
    const resolved = new SettingsSchema({})
    assert.equal(resolved.defaultMaxToolCalls, 0)
    assert.equal(resolved.maxToolCallsHardCap, 0)
    assert.equal(resolved.onToolCallBudget, 'wrap-up')
    assert.equal(resolved.graceToolCalls, 1)
  })

  test('the delegation-facing names are derived from the config-facing ones', () => {
    // The settings key is the row's DEFAULT (`defaultMaxToolCalls`); calling it
    // `maxToolCalls` next to a role file's own `maxToolCalls` would be ambiguous.
    assert.deepEqual(budgetDefaultsFrom({ defaultMaxToolCalls: 12, maxToolCallsHardCap: 40, onToolCallBudget: 'interrupt', graceToolCalls: 3 }), {
      maxToolCalls: 12,
      maxToolCallsHardCap: 40,
      onToolCallBudget: 'interrupt',
      graceToolCalls: 3,
    })
  })

  test('an unusable stored section falls back instead of disabling the guard', () => {
    assert.deepEqual(budgetDefaultsFrom(undefined), { maxToolCalls: 0, maxToolCallsHardCap: 0, onToolCallBudget: 'wrap-up', graceToolCalls: 1 })
    assert.equal(budgetDefaultsFrom({ defaultMaxToolCalls: -5 }).maxToolCalls, 0)
    assert.equal(budgetDefaultsFrom({ graceToolCalls: 2.5 }).graceToolCalls, 1)
    assert.equal(budgetDefaultsFrom({ onToolCallBudget: 'wrapup' }).onToolCallBudget, 'wrap-up')
  })
})

describe('settings: namespace naming', () => {
  test('the default row keeps the stable name the browser half binds to', () => {
    assert.equal(settingsNamespaceFor(undefined), 'subagent-roles')
    assert.equal(settingsNamespaceFor('subagent_role'), 'subagent-roles')
  })

  test('a second row gets a slugged, still-valid namespace', () => {
    assert.equal(settingsNamespaceFor('subagent_role_fork'), 'subagent-roles-subagent-role-fork')
    assert.equal(settingsNamespaceFor('Role.Delegate'), 'subagent-roles-role-delegate')
  })

  test('a name with nothing sluggable falls back instead of producing an invalid id', () => {
    assert.equal(settingsNamespaceFor('___'), 'subagent-roles')
  })
})

describe('settings: policy normalization', () => {
  test('accepts every declared mode', () => {
    for (const mode of TRIM_MODES) assert.equal(trimPolicyFrom({ childPromptTrim: mode }).mode, mode)
  })

  test('an unknown mode falls back to the default instead of disabling the trim', () => {
    assert.equal(trimPolicyFrom({ childPromptTrim: 'nonsense' }).mode, 'full')
    assert.equal(trimPolicyFrom(undefined).mode, 'full')
  })

  test('the name list becomes a set, non-strings are dropped, an absent list takes the defaults', () => {
    const policy = trimPolicyFrom({ childPromptTrimNames: ['a', 7, 'b'] })
    assert.deepEqual([...policy.dropNames], ['a', 'b'])
    assert.deepEqual([...trimPolicyFrom({ childPromptTrimNames: [] }).dropNames], [])
    assert.deepEqual([...trimPolicyFrom({}).dropNames], [...DEFAULT_CHILD_NAMES])
  })

  test('the settings schema mirrors the row config defaults', () => {
    const resolved = new SettingsSchema({})
    assert.equal(resolved.childPromptTrim, 'full')
    assert.deepEqual(resolved.childPromptTrimNames, [...DEFAULT_CHILD_NAMES])
  })
})

describe('settings: the row config source', () => {
  test('the row config is authoritative without any settings service', () => {
    const host = stubCtx()
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig({ childPromptTrim: 'tools' }), namespace: 'subagent-roles' })
    assert.equal(source.read().mode, 'tools')
    assert.deepEqual(host.warnings, [])
    assert.match(host.infos.join('\n'), /follow the plugin row config/)
  })

  test('the budget defaults follow the row config', () => {
    const host = stubCtx()
    const source = createTrimPolicySource({
      ctx: host.ctx,
      config: rowConfig({ defaultMaxToolCalls: 30, maxToolCallsHardCap: 40, onToolCallBudget: 'interrupt', graceToolCalls: 2 }),
      namespace: 'subagent-roles',
    })
    assert.deepEqual(source.readBudgetDefaults(), { maxToolCalls: 30, maxToolCallsHardCap: 40, onToolCallBudget: 'interrupt', graceToolCalls: 2 })
  })

  test('a settings service is never asked to register a namespace', () => {
    // 0.2.1 removed `settings.register`; touching it would either throw or
    // resurrect a namespace the host no longer renders.
    const host = stubCtx()
    let touched = 0
    host.ctx.get = (name) => {
      if (name !== 'settings') return undefined
      touched += 1
      return { register: () => { throw new Error('settings.register must not be used') } }
    }
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig({ childPromptTrim: 'off' }), namespace: 'subagent-roles' })
    assert.equal(source.read().mode, 'off')
    assert.equal(touched, 0)
  })

  test('dispose is a no-op', () => {
    const host = stubCtx()
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig(), namespace: 'subagent-roles' })
    source.dispose()
    assert.deepEqual(host.disposers, [])
  })
})
