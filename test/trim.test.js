/**
 * Child-prompt trim tests.
 *
 * The pure planner is pinned rule by rule — including the two false-positive
 * traps the live probe hit (group-label sections, and whole-word tool matching)
 * — and the registration is pinned against a stub host for the behaviours that
 * decide whether a real child prompt changes.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Config } from '../lib/config.js'
import { apply } from '../lib/index.js'
import {
  DEFAULT_CHILD_NAMES,
  mentionsTool,
  trimChildPrompt,
} from '../lib/trim.js'

/** One assembly in the shape `SystemPrompt.assemble()` returns. */
function assembly(sections, contexts = []) {
  return {
    sections: sections.map(([name, text]) => ({ name, text })),
    contexts: contexts.map(([name, text]) => ({ name, text })),
  }
}

const KNOWN = new Set(['read', 'write', 'workflow', 'ralph', 'job_output', 'job_kill', 'create_goal', 'get_goal'])

/** A policy whose scope sees only `visible`. */
function policy(visible, extra = {}) {
  return {
    mode: 'tools',
    known: KNOWN,
    visible: new Set(visible),
    dropNames: new Set(DEFAULT_CHILD_NAMES),
    ...extra,
  }
}

describe('trim: rule 1 — guidance for a tool the scope cannot call', () => {
  test('drops a registered tool the scope cannot see', () => {
    const ralph = 'Use the ralph tool ONLY when …'
    const result = trimChildPrompt(
      assembly([['tool:read', 'Use the read tool.'], ['tool:ralph', ralph]]),
      policy(['read']),
    )
    assert.deepEqual(result.sections.map((section) => section.name), ['tool:read'])
    assert.deepEqual(result.droppedSections, [`tool:ralph(${ralph.length})`])
    assert.equal(result.saved, ralph.length)
    assert.equal(result.changed, true)
  })

  test('keeps guidance for a tool the scope CAN see', () => {
    const result = trimChildPrompt(assembly([['tool:workflow', 'Use the workflow tool.']]), policy(['workflow']))
    assert.equal(result.changed, false)
    assert.deepEqual(result.droppedSections, [])
  })

  test('never drops a section it cannot attribute to a tool', () => {
    const result = trimChildPrompt(assembly([['deployment:persona-prefix', 'PERSONA']]), policy([]))
    assert.deepEqual(result.sections.map((section) => section.name), ['deployment:persona-prefix'])
  })

  test('an unreadable registry disables the tool rules instead of guessing', () => {
    const input = assembly([['tool:ralph', 'Use the ralph tool.']])
    for (const broken of [{ known: undefined }, { visible: undefined }, { known: undefined, visible: undefined }]) {
      const result = trimChildPrompt(input, policy(['read'], broken))
      assert.equal(result.changed, false)
      assert.equal(result.saved, 0)
    }
  })

  test('does not mutate the assembly it was given', () => {
    const input = assembly([['tool:ralph', 'Use the ralph tool.']])
    trimChildPrompt(input, policy([]))
    assert.equal(input.sections.length, 1)
  })
})

describe('trim: mode off means off', () => {
  test('off touches nothing — not even the tool rules `tools` would drop', () => {
    const payload = assembly([
      ['tool:workflow', 'Use the workflow tool ONLY when …'],
      ['app:web-surface', 'You are interacting with the user through the Web GUI …'],
    ], [['context:file-reference', '@ paths']])
    const result = trimChildPrompt(payload, policy(['read'], { mode: 'off' }))
    assert.equal(result.changed, false)
    assert.equal(result.saved, 0)
    assert.deepEqual(result.droppedSections, [])
    assert.deepEqual(result.droppedContexts, [])
    assert.deepEqual(result.sections.map((section) => section.name), ['tool:workflow', 'app:web-surface'])
    assert.deepEqual(result.contexts.map((entry) => entry.name), ['context:file-reference'])
  })

  test('off is distinct from tools, which still drops unreachable guidance', () => {
    const payload = assembly([['tool:workflow', 'Use the workflow tool ONLY when …']])
    assert.equal(trimChildPrompt(payload, policy(['read'], { mode: 'off' })).saved, 0)
    assert.ok(trimChildPrompt(payload, policy(['read'], { mode: 'tools' })).saved > 0)
  })
})

describe('trim: group labels are not tool names', () => {
  // `tool:jobs` covers job_output/job_kill/job_list; `tool:goal` covers the three
  // goal tools. Treating the label as a tool name stripped 1,116 characters of
  // live guidance in the live probe — these tests pin that fix.
  test('keeps a group section whose tools are visible', () => {
    const text = 'Track every background job id you start … collect with job_output … stop with job_kill.'
    const result = trimChildPrompt(assembly([['tool:jobs', text]]), policy(['job_output', 'job_kill']))
    assert.equal(result.changed, false)
    assert.deepEqual(result.droppedSections, [])
  })

  test('drops a group section when every tool it names is invisible', () => {
    const text = 'Track every background job id you start … collect with job_output … stop with job_kill.'
    const result = trimChildPrompt(assembly([['tool:jobs', text]]), policy(['read']))
    assert.deepEqual(result.sections, [])
    assert.deepEqual(result.droppedSections, [`tool:jobs(${text.length})`])
    assert.equal(result.saved, text.length)
  })

  test('keeps a group section when ONE named tool is still reachable', () => {
    const text = 'Use create_goal … then get_goal …'
    const result = trimChildPrompt(assembly([['tool:goal', text]]), policy(['get_goal']))
    assert.equal(result.changed, false)
  })

  test('a group section naming no known tool is left alone', () => {
    const result = trimChildPrompt(assembly([['tool:jobs', 'Nothing here names a tool.']]), policy([]))
    assert.equal(result.changed, false)
  })

  test('tool names match as whole words, not as substrings', () => {
    assert.equal(mentionsTool('the file is already there', 'read'), false)
    assert.equal(mentionsTool('use `read` now', 'read'), true)
    assert.equal(mentionsTool('thread-safe', 'read'), false)
    // A group section whose only near-miss is a substring keeps its guidance.
    const result = trimChildPrompt(assembly([['tool:misc', 'The value is already spread.']]), policy([]))
    assert.equal(result.changed, false)
  })
})

describe('trim: full mode', () => {
  const noisy = assembly(
    [['app:web-surface', 'You are interacting with the user through the Web GUI …'], ['tool:read', 'Use the read tool.']],
    [['context:file-reference', 'Tokens prefixed with @ are workspace paths …']],
  )

  test('tools mode keeps the named non-tool sections', () => {
    const result = trimChildPrompt(noisy, policy(['read']))
    assert.equal(result.changed, false)
    assert.deepEqual(result.droppedContexts, [])
  })

  test('full mode drops the named sections and contexts', () => {
    const result = trimChildPrompt(noisy, policy(['read'], { mode: 'full' }))
    assert.deepEqual(result.sections.map((section) => section.name), ['tool:read'])
    assert.deepEqual(result.contexts, [])
    assert.deepEqual(result.droppedSections, [`app:web-surface(${'You are interacting with the user through the Web GUI …'.length})`])
    assert.deepEqual(result.droppedContexts, [`context:file-reference(${'Tokens prefixed with @ are workspace paths …'.length})`])
  })

  test('a row can override the dropped names', () => {
    const result = trimChildPrompt(noisy, policy(['read'], {
      mode: 'full',
      dropNames: new Set(['tool:read']),
    }))
    assert.deepEqual(result.sections.map((section) => section.name), ['app:web-surface'])
    assert.deepEqual(result.contexts.map((entry) => entry.name), ['context:file-reference'])
  })

  test('a name is dropped wherever it appears — section or context', () => {
    // `context:file-reference` is registered as a SECTION by the installed core
    // despite its name; the list must not care which array carries it.
    const named = assembly(
      [['context:file-reference', '@ paths as a section'], ['tool:read', 'Use the read tool.']],
      [['context:file-reference', '@ paths as a context']],
    )
    const result = trimChildPrompt(named, policy(['read'], { mode: 'full' }))
    assert.deepEqual(result.sections.map((section) => section.name), ['tool:read'])
    assert.deepEqual(result.contexts, [])
    // Only the dropped parts are counted; the kept guidance is not "saved".
    assert.equal(result.saved, '@ paths as a section'.length + '@ paths as a context'.length)
  })

  test('a renamed core section degrades to "not trimmed", never to an error', () => {
    const renamed = assembly([['app:web-surface-v2', 'noise']])
    const result = trimChildPrompt(renamed, policy(['read'], { mode: 'full' }))
    assert.equal(result.changed, false)
  })
})

// ---- registration ---------------------------------------------------------

function stubHost(options = {}) {
  // A settings service whose user layer the test can move, so a Settings edit can
  // be driven through the very same path the card writes.
  const settings = (() => {
    let base = {}
    let user = {}
    const watchers = []
    const commit = (next) => {
      user = next
      // The real scope watches COMMITTED changes; a stub that never fires would
      // make the "Settings switch reaches the listener" test pass vacuously.
      for (const watcher of watchers) watcher()
    }
    const scope = {
      // The real service resolves schema defaults, then the composition base the
      // registration passed, then the user layer. A stub that dropped `base`
      // would silently override the row config it is supposed to sit under.
      get: () => ({ ...base, ...user }),
      watch: (callback) => {
        watchers.push(callback)
        return () => {}
      },
      update: async (patch) => commit({ ...user, ...patch }),
      replace: async (section) => commit({ ...section }),
    }
    return {
      service: {
        register: (_ns, _schema, config) => {
          base = config?.base ?? {}
          return scope
        },
      },
      setUser: (next) => commit({ ...next }),
    }
  })()
  const handlers = new Map()
  const info = []
  const debug = []
  const warnings = []
  const ctx = {
    logger: {
      info: (message) => info.push(String(message)),
      debug: (message) => debug.push(String(message)),
      warn: (message) => warnings.push(String(message)),
      error() {},
    },
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    effect: (callback) => callback(),
    get: (name) => {
      if (name === 'systemPrompt') return { section: () => () => {}, getSectionOrder: () => 2800 }
      // The local `settings` handle: referring to the not-yet-returned `host`
      // would throw inside the plugin's own try/catch and silently fall back to
      // the row config, making this stub lie about what it provides.
      if (name === 'settings') return settings.service
      return undefined
    },
    tools: {
      register: () => () => {},
      get: () => undefined,
      schemas: (scope) => (scope === undefined ? options.globalSchemas ?? [] : options.scopeSchemas ?? []),
    },
    subagents: { getProvider: () => undefined },
  }
  return { ctx, handlers, info, debug, warnings, settings }
}

/** A child agent at `depth` seeing `scopeSchemas`. */
function childAgent(depth = 1, id = 'child-1') {
  return { options: {}, session: { header: { id, cwd: '/tmp', delegationDepth: depth } } }
}

/** Only the trim's own log lines: mounting also logs about the transport provider. */
function trimLines(lines) {
  return lines.filter((line) => line.includes('child prompt trimmed'))
}

/** Drive the registered waterfall listener once. */
async function assemble(host, payload, context) {
  const listener = (host.handlers.get('system-prompt/assemble') ?? [])[0]
  assert.ok(listener, 'no assemble listener was registered')
  let nextCalls = 0
  const value = await listener(payload, context, () => {
    nextCalls += 1
    return Promise.resolve(payload)
  })
  assert.equal(nextCalls, 1, 'a waterfall listener must call next() exactly once')
  return value
}

describe('trim registration', () => {
  test('childPromptTrim off registers no listener', () => {
    const host = stubHost()
    apply(host.ctx, new Config({ childPromptTrim: 'off' }))
    assert.equal(host.handlers.has('system-prompt/assemble'), false)
  })

  test('the default mode registers the listener', () => {
    const host = stubHost()
    apply(host.ctx, new Config({}))
    assert.equal((host.handlers.get('system-prompt/assemble') ?? []).length, 1)
  })

  test('trimming is on by default, and the default is full', async () => {
    const host = stubHost({ globalSchemas: [], scopeSchemas: [] })
    apply(host.ctx, new Config({}))
    assert.equal(new Config({}).childPromptTrim, 'full')
    const payload = assembly([['app:web-surface', 'GUI noise']], [['context:file-reference', '@ paths']])
    const value = await assemble(host, payload, { agent: childAgent(1) })
    assert.deepEqual(value.sections, [])
    assert.deepEqual(value.contexts, [])
  })

  test('a deployment can keep every named part by emptying the list', async () => {
    const host = stubHost({ globalSchemas: [], scopeSchemas: [] })
    apply(host.ctx, new Config({ childPromptTrimNames: [] }))
    const payload = assembly([['harness:source', 'checkout path']], [['context:file-reference', '@ paths']])
    const value = await assemble(host, payload, { agent: childAgent(1) })
    assert.deepEqual(value.sections.map((section) => section.name), ['harness:source'])
    assert.deepEqual(value.contexts.map((entry) => entry.name), ['context:file-reference'])
  })

  test('a child keeps the tools it can call and loses the ones it cannot', async () => {
    const host = stubHost({
      globalSchemas: [{ name: 'read' }, { name: 'workflow' }, { name: 'job_output' }, { name: 'job_kill' }],
      scopeSchemas: [{ name: 'read' }],
    })
    apply(host.ctx, new Config({}))
    const childText = 'Track every job id … job_output … job_kill.'
    const payload = assembly([
      ['harness:identity', 'You are an AI agent.'],
      ['tool:read', 'Use the read tool.'],
      ['tool:workflow', 'Use the workflow tool ONLY when …'],
      ['tool:misc', childText],
    ])
    const value = await assemble(host, payload, { agent: childAgent(1) })
    assert.deepEqual(value.sections.map((section) => section.name), ['harness:identity', 'tool:read'])
    assert.match(host.info.join('\n'), /child prompt trimmed: -\d+ chars \(tool:workflow\(\d+\), tool:misc\(\d+\)\)/)
  })

  test('a top-level agent prompt is left exactly as composed', async () => {
    const host = stubHost({
      globalSchemas: [{ name: 'workflow' }],
      scopeSchemas: [{ name: 'read' }],
    })
    apply(host.ctx, new Config({}))
    const payload = assembly([['tool:workflow', 'Use the workflow tool.']])
    const value = await assemble(host, payload, { agent: childAgent(0, 'main-1') })
    assert.deepEqual(value.sections.map((section) => section.name), ['tool:workflow'])
    assert.deepEqual(trimLines(host.info), [])
  })

  test('a diagnostic assembly without an agent is untouched', async () => {
    const host = stubHost({ globalSchemas: [{ name: 'workflow' }], scopeSchemas: [] })
    apply(host.ctx, new Config({}))
    const payload = assembly([['tool:workflow', 'Use the workflow tool.']])
    const value = await assemble(host, payload, {})
    assert.equal(value.sections.length, 1)
  })

  test('the trim reports one info line per child and falls back to debug after', async () => {
    const host = stubHost({ globalSchemas: [{ name: 'workflow' }], scopeSchemas: [] })
    apply(host.ctx, new Config({}))
    // A fresh assembly per turn: the listener mutates the object it returns.
    const payload = () => assembly([['tool:workflow', 'Use the workflow tool.']])
    await assemble(host, payload(), { agent: childAgent(1, 'child-7') })
    await assemble(host, payload(), { agent: childAgent(1, 'child-7') })
    assert.equal(trimLines(host.info).length, 1)
    assert.equal(trimLines(host.debug).length, 1)
  })

  test('a malformed depth is caught: assembly survives and the skip is logged', async () => {
    const host = stubHost({ globalSchemas: [{ name: 'workflow' }], scopeSchemas: [] })
    apply(host.ctx, new Config({}))
    const agent = { options: { subagentDepth: -1 }, session: { header: { id: 'bad', delegationDepth: 1 } } }
    const payload = assembly([['tool:workflow', 'Use the workflow tool.']])
    const value = await assemble(host, payload, { agent })
    assert.equal(value.sections.length, 1)
    assert.match(host.warnings.join('\n'), /child prompt trim skipped:/)
  })

  test('a registry that throws costs the tool rules, never the assembly', async () => {
    const host = stubHost({ scopeSchemas: [], globalSchemas: [] })
    host.ctx.tools.schemas = () => {
      throw new Error('registry is closed')
    }
    apply(host.ctx, new Config({}))
    const payload = assembly([['app:web-surface', 'GUI noise'], ['tool:read', 'Use the read tool.']])
    const value = await assemble(host, payload, { agent: childAgent(1) })
    // The named parts still go (they need no registry); the assembly survives.
    assert.deepEqual(value.sections.map((section) => section.name), ['tool:read'])
  })

  test('unwinding the row disposes the trim listener', async () => {
    const host = stubHost({ globalSchemas: [], scopeSchemas: [] })
    const disposers = []
    host.ctx.effect = (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    }
    apply(host.ctx, new Config({}))
    assert.equal((host.handlers.get('system-prompt/assemble') ?? []).length, 1)
    for (const dispose of disposers) dispose()
    assert.equal((host.handlers.get('system-prompt/assemble') ?? []).length, 0)
  })

  test('a Settings switch to off reaches the listener and stops trimming', async () => {
    const host = stubHost({ globalSchemas: [{ name: 'workflow' }], scopeSchemas: [] })
    apply(host.ctx, new Config({ childPromptTrim: 'full' }))
    const payload = assembly([['tool:workflow', 'Use the workflow tool.']])
    assert.equal((await assemble(host, payload, { agent: childAgent(1) })).sections.length, 0)
    // The user layer now says off; the very next assembly must be untouched.
    host.settings.setUser({ childPromptTrim: 'off' })
    const next = await assemble(host, assembly([['tool:workflow', 'Use the workflow tool.']]), { agent: childAgent(1, 'child-2') })
    assert.deepEqual(next.sections.map((section) => section.name), ['tool:workflow'])
  })

  test('full mode reaches the child through the configured names', async () => {
    const host = stubHost({ globalSchemas: [], scopeSchemas: [] })
    apply(host.ctx, new Config({ childPromptTrim: 'full' }))
    const payload = assembly([['app:web-surface', 'GUI noise']], [['context:file-reference', '@ paths']])
    const value = await assemble(host, payload, { agent: childAgent(1) })
    assert.deepEqual(value.sections, [])
    assert.deepEqual(value.contexts, [])
  })
})
