/**
 * Browser-half smoke test.
 *
 * The bundle cannot be rendered without a DOM, but the two things that decide
 * whether a Settings card ever appears CAN be checked in Node: the loader
 * envelope is well-formed and registered under the package id, and `apply`
 * binds the settings namespace and registers a component under the SAME key the
 * Plugins tab dispatches.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { SettingsSchema, settingsNamespaceFor } from '../lib/settings.js'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'lib', 'client.js')

/**
 * The design tokens a card may use, read from the INSTALLED theme whenever this
 * checkout can resolve it, so theme drift is caught rather than assumed.
 *
 * A token outside the set does not resolve: the declaration is dropped and the
 * control renders unstyled — which is how an invisible Save label shipped once.
 * The literal list below is the fallback for a checkout without the theme (CI),
 * and is itself only as good as the last manual check.
 */
function themeTokens() {
  try {
    const resolved = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-theme')
    const source = readFileSync(join(dirname(resolved), 'client.js'), 'utf8')
    const found = [...source.matchAll(/--dsw-alias-([a-z0-9-]+)/g)].map((match) => match[1])
    if (found.length > 20) return new Set(found)
  } catch {
    // Fall back to the checked-in list below.
  }
  return null
}

const THEME_TOKENS_FALLBACK = new Set([
  'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-mask-1', 'bg-mask-2', 'bg-mask-3',
  'bg-overlay', 'bg-skeleton', 'border-l1', 'border-l2', 'border-l3', 'border-l4',
  'brand-primary', 'brand-text', 'label-caption', 'label-dimmed', 'label-primary',
  'label-secondary', 'label-tertiary', 'link', 'state-error-primary', 'state-error-secondary',
  'state-success-primary', 'state-warn-primary', 'state-warn-label',
])

/** The tokens to check against: the installed theme, else the fallback list. */
const THEME_TOKENS = themeTokens() ?? THEME_TOKENS_FALLBACK
const PACKAGE_NAME = 'dsh-plugin-subagent-roles'
const NAMESPACE = 'subagent-roles'

/** Minimal React surface: the bundle only builds elements and calls hooks. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (fn) => fn,
  useState: (initial) => [initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** Load the bundle the way the browser loader does, returning its exports. */
function loadBundle(options = {}) {
  const loaded = []
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        loaded.push(entry)
      },
    },
  }
  try {
    const source = readFileSync(BUNDLE, 'utf8')
    // The bundle is plain ESM-free script; evaluating it registers a factory.
    // eslint-disable-next-line no-new-func
    new Function('window', source)(globalThis.window)
  } finally {
    globalThis.window = previous
  }
  assert.equal(loaded.length, 1, 'the bundle must register exactly one module')
  const [entry] = loaded
  const factory = entry.factory
  const exports = factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`unexpected module request: ${id}`)
  })
  return { entry, exports, require: createRequire(import.meta.url), options }
}

/** A client context stub exposing the two services the card needs. */
function stubClient() {
  const injections = []
  const registrations = []
  const bound = []
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: {}, user: {}, base: {}, writable: true }),
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
    mutate: async () => {},
  }
  const disposers = []
  const ctx = {
    // The real client context is a cordis context: `effect` runs the callback
    // and owns whatever disposer it returns.
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    get: () => undefined,
    settingsScope: {
      bind: (spec) => {
        bound.push(spec)
        return scope
      },
    },
    slots: {
      inject: (key, callback) => {
        injections.push(key)
        return callback()
      },
      register: (spec, component) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }
  return { ctx, injections, registrations, bound }
}

describe('browser half: the loader envelope', () => {
  test('registers one module under the package id', () => {
    const { entry } = loadBundle()
    assert.equal(entry.id, PACKAGE_NAME)
    assert.equal(typeof entry.factory, 'function')
  })

  test('exports the cordis plugin surface the client loader needs', () => {
    const { exports } = loadBundle()
    assert.equal(typeof exports.apply, 'function')
    // settingsScope is OPTIONAL: 0.2.0 removed it, and a required-but-absent
    // service leaves the row pending, which fails the whole web boot.
    assert.deepEqual([...exports.inject], ['slots'])
  })
})

describe('browser half: staged save semantics', () => {
  const { __internals } = loadBundle().exports
  /** The resolved values in their RENDERED form, exactly as the card holds them. */
  const current = {
    childPromptTrim: 'full',
    childPromptTrimNames: 'harness:source',
    defaultMaxToolCalls: '0',
    maxToolCallsHardCap: '0',
    onToolCallBudget: 'wrap-up',
    graceToolCalls: '1',
  }
  /** The resolved state with `patch` applied — what the card would render. */
  const shownWith = (patch) => ({ ...current, ...patch })

  test('a changed field is written with its staged text', () => {
    const plan = __internals.planSave([], shownWith({ childPromptTrim: 'tools', childPromptTrimNames: 'a, b' }), current)
    assert.deepEqual(plan, [
      { kind: 'set', field: 'childPromptTrim', value: 'tools' },
      { kind: 'set', field: 'childPromptTrimNames', value: ['a', 'b'] },
    ])
  })

  test('a field the user never touched is NOT pinned as an override', () => {
    // Presence in the user layer is what marks a field overridden, so writing an
    // untouched field would shadow later deployment changes to it.
    const plan = __internals.planSave([], shownWith({ childPromptTrim: 'tools' }), current)
    assert.deepEqual(plan, [{ kind: 'set', field: 'childPromptTrim', value: 'tools' }])
  })

  test('saving with nothing changed writes nothing', () => {
    assert.deepEqual(__internals.planSave([], current, current), [])
    assert.deepEqual(__internals.planSave([], shownWith({ childPromptTrimNames: ' harness:source , ' }), current), [])
  })

  test('a staged reset CLEARS the field instead of pinning the current default', () => {
    const plan = __internals.planSave(['childPromptTrim', 'childPromptTrimNames'], current, current)
    assert.deepEqual(plan, [
      { kind: 'unset', field: 'childPromptTrim' },
      { kind: 'unset', field: 'childPromptTrimNames' },
    ])
  })

  test('one staged field does not disturb the other draft', () => {
    const plan = __internals.planSave(['childPromptTrim'], shownWith({ childPromptTrimNames: 'app:web-surface' }), current)
    assert.deepEqual(plan, [
      { kind: 'unset', field: 'childPromptTrim' },
      { kind: 'set', field: 'childPromptTrimNames', value: ['app:web-surface'] },
    ])
  })

  test('an empty list field writes an empty array, not the string', () => {
    const plan = __internals.planSave([], shownWith({ childPromptTrim: 'off', childPromptTrimNames: '   ' }), current)
    assert.deepEqual(plan[1].value, [])
  })

  test('a count field is written as a NUMBER, never as a digit string', () => {
    const plan = __internals.planSave([], shownWith({ defaultMaxToolCalls: '40', graceToolCalls: '2' }), current)
    assert.deepEqual(plan, [
      { kind: 'set', field: 'defaultMaxToolCalls', value: 40 },
      { kind: 'set', field: 'graceToolCalls', value: 2 },
    ])
  })

  test('unusable count text folds to the fallback instead of writing a value the Host refuses', () => {
    // The Host stores `z.natural()`: "8.5" would be a refused write, so the card
    // must never turn it into a number.
    const field = { kind: 'count', fallback: 1 }
    for (const text of ['', '8.5', '-1', 'abc', ' ']) {
      assert.equal(__internals.fieldValue(field, text), 1, `unexpected value for ${JSON.stringify(text)}`)
    }
    assert.equal(__internals.fieldValue({ kind: 'count', fallback: 0 }, '0'), 0)
  })

  test('two texts of the same count are the same value', () => {
    const field = { kind: 'count', fallback: 0 }
    assert.equal(__internals.sameFieldValue(field, '30', '30'), true)
    assert.equal(__internals.sameFieldValue(field, '30', '30 '), true)
    assert.equal(__internals.sameFieldValue(field, '30', '31'), false)
  })

  test('editing a field cancels a reset staged for THAT field only', () => {
    // Regression: a Reset followed by typing used to save the clear, silently
    // discarding what the user typed.
    const staged = ['childPromptTrim', 'childPromptTrimNames']
    const edited = __internals.applyEdit({ draft: undefined, shown: shownWith({ childPromptTrimNames: '' }), staged }, 'childPromptTrimNames', { childPromptTrimNames: 'app:web-surface' })
    assert.deepEqual(edited.staged, ['childPromptTrim'])
    // …and Save now writes the typed value while still clearing the other field.
    assert.deepEqual(__internals.planSave(edited.staged, edited.draft, current), [
      { kind: 'unset', field: 'childPromptTrim' },
      { kind: 'set', field: 'childPromptTrimNames', value: ['app:web-surface'] },
    ])
  })

  test('an edit merges into the draft, not into the resolved value', () => {
    const edited = __internals.applyEdit(
      { draft: shownWith({ childPromptTrim: 'tools' }), shown: current, staged: [] },
      'childPromptTrim',
      { childPromptTrim: 'off' },
    )
    assert.equal(edited.draft.childPromptTrim, 'off')
    assert.equal(edited.draft.childPromptTrimNames, 'harness:source')
  })

  test('list comparison ignores spacing but not order or content', () => {
    assert.equal(__internals.sameNames('a,b', 'a, b'), true)
    assert.equal(__internals.sameNames('b,a', 'a,b'), false)
    assert.equal(__internals.sameNames('a', 'a,b'), false)
  })

  test('the dictionaries stay in sync with the exported copy table', () => {
    assert.deepEqual(Object.keys(__internals.COPY.en).sort(), Object.keys(__internals.COPY.zh).sort())
  })
})

describe('browser half: the settings card registration', () => {
  test('binds the host namespace the card is keyed on', () => {
    const { exports } = loadBundle()
    const client = stubClient()
    exports.apply(client.ctx)
    assert.deepEqual(client.bound, [{ namespace: NAMESPACE }])
  })

  test('the card edits exactly the fields the host schema declares', () => {
    const { __internals } = loadBundle().exports
    // A source-text match would pass on the constants alone; compare the real
    // schema keys with the keys the save plan writes. The tool-call budget
    // controls ride the SAME namespace, so a forgotten field would be invisible
    // in the UI while settings.yaml still honoured it.
    const hostFields = Object.keys(new SettingsSchema({})).sort()
    assert.deepEqual(hostFields, [
      'childPromptTrim',
      'childPromptTrimNames',
      'defaultMaxToolCalls',
      'graceToolCalls',
      'maxToolCallsHardCap',
      'onToolCallBudget',
    ])
    assert.deepEqual([...__internals.FIELD_KEYS].sort(), hostFields)
    const edited = Object.fromEntries(__internals.FIELD_KEYS.map((key) => [key, 'edited']))
    const written = new Set(__internals
      .planSave([...__internals.FIELD_KEYS], edited, edited)
      .map((step) => step.field))
    assert.deepEqual([...written].sort(), hostFields)
  })

  test('registers a card under the settings.plugin.item key of that namespace', () => {
    const { exports } = loadBundle()
    const client = stubClient()
    exports.apply(client.ctx)
    assert.deepEqual(client.injections, ['settings.plugin.item'])
    assert.equal(client.registrations.length, 1)
    const { spec, component } = client.registrations[0]
    assert.equal(spec.name, 'settings.plugin.item')
    // `settings.plugin.item` is a KEYED slot: the tab dispatches one entry per
    // served namespace with `entryKey: ns`, and a card claims it with `key`.
    // `id` belongs to LIST slots and renders nothing here.
    assert.equal(spec.key, NAMESPACE)
    assert.equal(spec.id, undefined)
    assert.equal(typeof spec.inject, 'function')
    assert.equal(typeof component, 'function')
    // The injected object is spread onto the component as props.
    const props = spec.inject()
    assert.equal(typeof props.scope.getSnapshot, 'function')
  })

  test('the injected scope is the one the card reads and writes', () => {
    const { exports } = loadBundle()
    const client = stubClient()
    exports.apply(client.ctx)
    const props = client.registrations[0].spec.inject()
    assert.equal(props.scope.getSnapshot().status, 'ready')
  })

  test('the card mirrors the host PluginCard chrome, not a flat box', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    // Assert on the COMPONENT, not the stylesheet: a marker that only appears in
    // CSS would prove nothing about what the card renders.
    const code = source.split('\n').filter((line) => !line.trimStart().startsWith("'.dsr-")).join('\n')
    for (const marker of [
      'aria-expanded',
      'dsr-cardOpen',
      'dsr-chevronOpen',
      'dsr-pending',
      'dsr-footer',
      'dsr-save',
      "'unsaved'",
    ]) {
      assert.ok(code.includes(marker), `missing host chrome marker: ${marker}`)
    }
    // Styles ride the same design tokens as the host's own cards.
    assert.match(source, /var\(--dsw-alias-border-l4\)/)
    assert.match(source, /var\(--dsw-alias-brand-primary\)/)
    assert.match(source, /data-plugin-css/)
  })

  test('card copy follows the Language setting instead of hard-coding two languages', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    // Both dictionaries ship, keyed identically.
    for (const key of ['title', 'mode', 'modeHint', 'names', 'namesHint', 'maxToolCalls', 'hardCap', 'budgetMode', 'grace', 'save', 'discard', 'reset', 'unsaved']) {
      assert.ok(source.includes(`${key}:`), `missing dictionary key: ${key}`)
    }
    assert.match(source, /zh:\s*\{/)
    assert.match(source, /en:\s*\{/)
    // The card reads copy through the seat, and never renders a bilingual literal.
    assert.match(source, /props\.t/)
    assert.match(source, /locale\.register\(NAMESPACE, COPY\)/)
    assert.match(source, /locale: NAMESPACE/)
    for (const literal of ['· 模式', '· 保存', '· 丢弃', '· 未保存']) {
      assert.equal(source.includes(literal), false, `bilingual literal leaked: ${literal}`)
    }
  })

  test('every design token the card uses exists in the theme', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    const rules = source.split('\n').filter((line) => line.trimStart().startsWith("'.dsr-"))
    assert.ok(rules.length > 10, 'expected the card stylesheet')
    const used = new Set()
    for (const rule of rules) {
      for (const token of rule.matchAll(/--dsw-alias-([a-z0-9-]+)/g)) used.add(token[1])
    }
    assert.ok(used.size > 5, 'expected the card to use theme tokens')
    for (const token of used) {
      assert.ok(THEME_TOKENS.has(token), `unknown design token: --dsw-alias-${token}`)
    }
    // Record which ledger judged it: the installed theme, or the fallback list.
    const judgedBy = themeTokens() === null ? 'checked-in fallback list' : 'installed theme'
    assert.ok(judgedBy.length > 0)
  })

  test('the token guard is judged by the installed theme when it is resolvable', () => {
    // Not a hard requirement (CI may lack the theme), but on a developer machine
    // the derived set must be the one in force, or the guard could rot.
    const derived = themeTokens()
    if (derived === null) return
    assert.ok(derived.size > THEME_TOKENS_FALLBACK.size / 2)
    assert.ok(derived.has('label-primary'))
    assert.equal(derived.has('label-inverse'), false, 'the invented token must not exist in the theme')
  })

  test('every class the component renders is defined in the stylesheet', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    const defined = new Set()
    for (const line of source.split('\n').filter((entry) => entry.trimStart().startsWith("'.dsr-"))) {
      // Class names are camelCase after the prefix (dsr-labelRow, dsr-cardOpen).
      for (const match of line.matchAll(/\.(dsr-[A-Za-z-]+)/g)) defined.add(match[1])
    }
    const used = new Set()
    for (const match of source.matchAll(/className: (`[^`]*`|'[^']*')/g)) {
      const literal = match[1].slice(1, -1)
      // Template literals compose conditionals: keep the static class names.
      for (const part of literal.split(/[\s${}?:'\"`]+/)) {
        if (part.startsWith('dsr-')) used.add(part)
      }
    }
    assert.ok(defined.size > 15, 'expected the stylesheet')
    assert.ok(used.size > 10, 'expected rendered classes')
    for (const name of used) {
      assert.ok(defined.has(name), `class rendered but never styled: ${name}`)
    }
  })

  test('the Save button pairs a surface and a contrasting label', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    const save = source.split('\n').find((line) => line.includes("'.dsr-save{"))
    assert.ok(save, 'expected a .dsr-save rule')
    // The host's own rule: a label-coloured surface with the page colour as its
    // text. A hand-picked pair is exactly how "text same colour as background"
    // happens, so this pins the host's pair.
    assert.match(save, /background:var\(--dsw-alias-label-primary\)/)
    assert.match(save, /color:var\(--dsw-alias-bg-layer-3\)/)
  })

  test('every copy key the card asks for exists in both dictionaries', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    const dictionary = (locale) => {
      const start = source.indexOf(`      ${locale}: {`)
      assert.ok(start > 0, `missing ${locale} dictionary`)
      const block = source.slice(start, source.indexOf('      },', start))
      return new Set([...block.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]))
    }
    const en = dictionary('en')
    const zh = dictionary('zh')
    assert.ok(en.size > 10 && zh.size > 10, 'expected both dictionaries')
    assert.deepEqual([...en].sort(), [...zh].sort(), 'the two dictionaries must share one key set')
    // A bare `t(` would also match `createElement(`: require a non-identifier
    // character in front, so only real copy lookups are collected.
    const used = new Set([
      ...[...source.matchAll(/(?:^|[^A-Za-z0-9_$.])t\('([A-Za-z][A-Za-z0-9]*)'\)/gm)].map((match) => match[1]),
      ...[...source.matchAll(/(?:^|[^A-Za-z0-9_$.])key: '([A-Za-z][A-Za-z0-9]*)'/gm)].map((match) => match[1]),
    ])
    assert.ok(used.size > 8, 'expected the card to ask for copy keys')
    for (const key of used) {
      assert.ok(en.has(key), `copy key missing from the dictionaries: ${key}`)
    }
  })

  test('both halves agree on the namespace the card is keyed by', () => {
    const { __internals } = loadBundle().exports
    // The Host half serves `settingsNamespaceFor(toolName)`; the card must claim
    // exactly that key or the Plugins tab pairs nothing and renders an empty tab.
    assert.equal(__internals.NAMESPACE, settingsNamespaceFor('subagent_role'))
    assert.equal(__internals.NAMESPACE, settingsNamespaceFor(undefined))
  })

  test('the card carries no list-slot fields', () => {
    const { exports } = loadBundle()
    const client = stubClient()
    exports.apply(client.ctx)
    const { spec } = client.registrations[0]
    assert.deepEqual(Object.keys(spec).filter((field) => field !== 'locale').sort(), ['inject', 'key', 'name'])
  })

  test('a duplicated apply mounts exactly one card', () => {
    const { exports } = loadBundle()
    const client = stubClient()
    exports.apply(client.ctx)
    exports.apply(client.ctx)
    assert.equal(client.registrations.length, 1)
    assert.equal(client.injections.length, 1)
  })

  test('a deployment without the settings extension point does not throw', () => {
    const { exports } = loadBundle()
    const warnings = []
    const original = console.warn
    console.warn = (message) => warnings.push(String(message))
    try {
      exports.apply({
        effect: (callback) => { callback(); return () => {} },
        settingsScope: { bind: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }) },
        get: () => undefined,
        slots: {
          inject: (_key, callback) => callback(),
          register: () => {
            throw new Error('no such slot in this deployment')
          },
        },
      })
    } finally {
      console.warn = original
    }
    assert.match(warnings.join('\n'), /settings card not registered/)
  })

  test('a build without the settings-scope service skips the card instead of failing the boot', () => {
    const { exports } = loadBundle()
    const notes = []
    const original = console.info
    console.info = (message) => notes.push(String(message))
    let touched = 0
    try {
      const ctx = {
        effect: (callback) => { callback(); return () => {} },
        slots: {
          inject: () => { touched += 1 },
          register: () => { touched += 1; return () => {} },
        },
      }
      exports.apply(ctx)
      exports.apply(ctx)
    } finally {
      console.info = original
    }
    assert.equal(touched, 0, 'no card work may run without a settings scope')
    assert.equal(notes.length, 1, 'the skip is explained once, not on every re-apply')
    assert.match(notes.join('\n'), /settingsScope/)
  })

  test('a settings scope without `bind` is treated as absent', () => {
    const { exports } = loadBundle()
    const notes = []
    const original = console.info
    console.info = (message) => notes.push(String(message))
    let touched = 0
    try {
      exports.apply({
        effect: (callback) => { callback(); return () => {} },
        settingsScope: {},
        slots: {
          inject: () => { touched += 1 },
          register: () => { touched += 1; return () => {} },
        },
      })
    } finally {
      console.info = original
    }
    assert.equal(touched, 0)
    assert.match(notes.join('\n'), /settingsScope/)
  })

  test('a settings scope registered later still mounts the card', () => {
    const { exports } = loadBundle()
    const registrations = []
    let listener
    const original = console.info
    console.info = () => {}
    try {
      const ctx = {
        effect: (callback) => {
          const disposer = callback()
          return () => { if (typeof disposer === 'function') disposer() }
        },
        // A pre-0.2.0 build may activate the client settings plugin AFTER this
        // one. The registration event is the wait a one-shot read cannot give.
        on: (name, handler) => { listener = handler; return () => { listener = undefined } },
        slots: {
          inject: (_key, callback) => callback(),
          register: (spec) => { registrations.push(spec); return () => {} },
        },
      }
      exports.apply(ctx)
      assert.equal(registrations.length, 0, 'nothing mounts before the service arrives')
      ctx.settingsScope = { bind: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }) }
      listener('settingsScope')
      assert.equal(registrations.length, 1, 'the card mounts when the service finally arrives')
      assert.equal(registrations[0].key, 'subagent-roles')
    } finally {
      console.info = original
    }
  })
})
