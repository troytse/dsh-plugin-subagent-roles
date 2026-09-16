/**
 * Host-side settings tests: the trim policy's namespace, its normalization, and
 * the live source a row reads, including every degradation path — a deployment
 * without a settings provider, and a namespace that refuses to register.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_CHILD_NAMES } from '../lib/trim.js'
import {
  TRIM_MODES,
  TrimSettingsSchema,
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
    ...extra,
  }
}

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
    const resolved = new TrimSettingsSchema({})
    assert.equal(resolved.childPromptTrim, 'full')
    assert.deepEqual(resolved.childPromptTrimNames, [...DEFAULT_CHILD_NAMES])
  })
})

describe('settings: the live policy source', () => {
  test('without a settings service the row config stays authoritative', () => {
    const host = stubCtx()
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig({ childPromptTrim: 'tools' }), namespace: 'subagent-roles' })
    assert.equal(source.read().mode, 'tools')
    assert.deepEqual(host.warnings, [])
  })

  test('a provider that mounts later is picked up through inject', () => {
    const settings = stubSettings()
    let deferred
    const host = stubCtx({ inject: (_names, callback) => { deferred = callback } })
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig({ childPromptTrim: 'tools' }), namespace: 'subagent-roles' })
    assert.equal(source.read().mode, 'tools')
    assert.equal(settings.registrations.length, 0)
    deferred({ settings: settings.service })
    assert.equal(settings.registrations.length, 1)
    // The namespace now answers: the composed row config is its base layer.
    assert.equal(source.read().mode, 'tools')
    assert.equal(settings.registrations[0].config.base.childPromptTrim, 'tools')
    source.dispose()
    assert.equal(host.disposers.length, 1)
  })

  test('the row config becomes the base layer and the user layer wins', () => {
    const settings = stubSettings({ user: { childPromptTrim: 'off' } })
    const host = stubCtx({ settings: settings.service })
    const source = createTrimPolicySource({
      ctx: host.ctx,
      config: rowConfig({ childPromptTrim: 'tools', childPromptTrimNames: ['app:web-surface'] }),
      namespace: 'subagent-roles',
    })
    const [registration] = settings.registrations
    assert.equal(registration.ns, 'subagent-roles')
    assert.equal(registration.config.applies, 'live')
    assert.deepEqual(registration.config.base, {
      childPromptTrim: 'tools',
      childPromptTrimNames: ['app:web-surface'],
    })
    assert.equal(source.read().mode, 'off')
    assert.match(host.infos.join('\n'), /editable in Settings/)
  })

  test('a Settings edit reaches the very next read', () => {
    const settings = stubSettings()
    const host = stubCtx({ settings: settings.service })
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig(), namespace: 'subagent-roles' })
    assert.equal(source.read().mode, 'full')
    assert.deepEqual([...source.read().dropNames], [...DEFAULT_CHILD_NAMES])
    settings.setUser({ childPromptTrim: 'tools', childPromptTrimNames: [] })
    assert.equal(source.read().mode, 'tools')
    assert.deepEqual([...source.read().dropNames], [])
  })

  test('a namespace that cannot register degrades to the row config and warns', () => {
    const settings = stubSettings({ throwOnRegister: true })
    const host = stubCtx({ settings: settings.service })
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig({ childPromptTrim: 'tools' }), namespace: 'subagent-roles' })
    assert.equal(source.read().mode, 'tools')
    assert.match(host.warnings.join('\n'), /settings namespace "subagent-roles" unavailable/)
  })

  test('an unreadable settings seam does not throw and keeps the row config', () => {
    const host = stubCtx()
    host.ctx.get = () => { throw new Error('cannot get property "settings" without inject') }
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig({ childPromptTrim: 'tools' }), namespace: 'subagent-roles' })
    assert.equal(source.read().mode, 'tools')
    assert.deepEqual(host.warnings, [])
  })

  test('a throwing inject seam is reported, not propagated', () => {
    const host = stubCtx({ inject: () => { throw new Error('inject is closed') } })
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig(), namespace: 'subagent-roles' })
    assert.equal(source.read().mode, 'full')
    assert.match(host.warnings.join('\n'), /settings service unavailable/)
  })

  test('dispose detaches the watch', () => {
    const settings = stubSettings()
    const host = stubCtx({ settings: settings.service })
    const source = createTrimPolicySource({ ctx: host.ctx, config: rowConfig(), namespace: 'subagent-roles' })
    source.dispose()
    assert.equal(settings.unwatched.length, 1)
  })
})
