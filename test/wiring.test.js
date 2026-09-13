/**
 * Wiring test: mounts the plugin against stub host services (no live host) and
 * pins the two behaviours that matter most — when the catalog section renders,
 * and which tool name gets registered.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { Config } from '../lib/config.js'
import { CATALOG_SECTION_NAME, apply, catalogSectionName } from '../lib/index.js'

const roots = []
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-roles-wiring-'))
  roots.push(dir)
  return dir
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function stubHost(options = {}) {
  const registered = []
  const sections = []
  const warnings = []
  const provider = {
    name: options.providerName ?? 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    prepareContinuable: () => Promise.resolve({}),
  }
  const errors = []
  const handlers = new Map()
  const ctx = {
    logger: {
      info() {},
      debug() {},
      warn: (message) => warnings.push(String(message)),
      error: (message) => errors.push(String(message)),
    },
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
    effect: (callback) => callback(),
    get: (name) => (name === 'systemPrompt' ? (options.noSystemPrompt === true ? undefined : systemPrompt) : undefined),
    tools: {
      register: (definition) => {
        // The real registry throws on a duplicate name in one scope; the stub
        // must too, or a two-row collision would pass here and break in a profile.
        if (registered.some((existing) => existing.name === definition.name)) {
          throw new Error(`tool "${definition.name}" is already registered`)
        }
        registered.push(definition)
        return () => {
          const at = registered.indexOf(definition)
          if (at >= 0) registered.splice(at, 1)
        }
      },
      get: (name) => registered.find((definition) => definition.name === name),
      schemas: () => options.schemas ?? [],
    },
    subagents: {
      getProvider: (name) => (options.noProvider === true || name !== provider.name ? undefined : provider),
    },
  }
  const systemPrompt = {
    section: (definition) => {
      if (options.sectionThrows === true) throw new Error('section registry is closed')
      if (sections.some((existing) => existing.name === definition.name)) {
        throw new Error(`prompt section "${definition.name}" is already registered`)
      }
      sections.push(definition)
      return () => {}
    },
    getSectionOrder: (key) => (key === 'TOOL_SUBAGENT' ? 2800 : 0),
  }
  const emit = (name, payload) => {
    for (const handler of handlers.get(name) ?? []) handler(payload)
  }
  return { ctx, warnings, errors, registered, sections, provider, handlers, emit }
}

function agentAt(cwd, depth = 0) {
  const agent = { options: {}, session: { header: { cwd, ...(depth > 0 ? { delegationDepth: depth } : {}) } } }
  return { agent, scope: agent }
}

function fixtureProject() {
  const project = sandbox()
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, '.dsh', 'roles'), { recursive: true })
  writeFileSync(join(project, '.dsh', 'roles', 'web-verifier.md'), '---\ndisplayName: Web 验证者\ndescription: 浏览器调试与验证\ntools: [read]\n---\nPERSONA-BODY')
  return project
}

describe('plugin wiring', () => {
  test('registers exactly the delegation tool on the configured provider', () => {
    const host = stubHost()
    apply(host.ctx, new Config({}))
    assert.deepEqual(host.registered.map((definition) => definition.name), ['subagent_role'])
  })

  test('honours a custom toolName and the optional list tool', () => {
    const host = stubHost()
    apply(host.ctx, new Config({ toolName: 'role_delegate', enableListTool: true }))
    assert.deepEqual(host.registered.map((definition) => definition.name), ['role_delegate', 'subagent_roles'])
  })

  test('registers the catalog section with a bounded order', () => {
    const host = stubHost()
    apply(host.ctx, new Config({}))
    assert.equal(host.sections.length, 1)
    assert.equal(host.sections[0].name, CATALOG_SECTION_NAME)
    assert.equal(host.sections[0].order, 2801)
  })

  test('catalog renders for a top-level agent and stays empty for a child', () => {
    const project = fixtureProject()
    const host = stubHost()
    apply(host.ctx, new Config({}))
    const text = host.sections[0].text(agentAt(project, 0))
    assert.match(text, /^- `web-verifier` \(Web 验证者\): 浏览器调试与验证$/m)
    assert.equal(text.includes('PERSONA-BODY'), false)
    assert.equal(host.sections[0].text(agentAt(project, 1)), '')
  })

  test('catalogScope all reaches subagents too', () => {
    const project = fixtureProject()
    const host = stubHost()
    apply(host.ctx, new Config({ catalogScope: 'all' }))
    assert.match(host.sections[0].text(agentAt(project, 1)), /web-verifier/)
  })

  test('a project without role files contributes nothing', () => {
    const host = stubHost()
    apply(host.ctx, new Config({}))
    assert.equal(host.sections[0].text(agentAt(sandbox(), 0)), '')
  })

  test('catalog off registers no section at all', () => {
    const host = stubHost()
    apply(host.ctx, new Config({ catalog: 'off' }))
    assert.equal(host.sections.length, 0)
  })

  test('a hidden delegation tool hides the catalog (restricted child)', () => {
    const project = fixtureProject()
    const host = stubHost()
    apply(host.ctx, new Config({}))
    host.ctx.tools.get = () => undefined
    assert.equal(host.sections[0].text(agentAt(project, 0)), '')
  })

  test('a broken role file is reported and never breaks assembly', () => {
    const project = fixtureProject()
    writeFileSync(join(project, '.dsh', 'roles', 'broken.md'), '---\nmodel: x\n---\nbody')
    const host = stubHost()
    apply(host.ctx, new Config({}))
    const text = host.sections[0].text(agentAt(project, 0))
    assert.match(text, /web-verifier/)
    assert.equal(text.includes('broken'), false)
    assert.equal(host.warnings.some((message) => message.includes('broken.md')), true)
  })

  test('a provider that appears later is mounted, and its removal unwinds the tool', () => {
    const host = stubHost({ noProvider: true })
    apply(host.ctx, new Config({}))
    assert.deepEqual(host.registered, [])
    host.emit('subagent/provider-added', host.provider)
    assert.deepEqual(host.registered.map((definition) => definition.name), ['subagent_role'])
    // A second add for the same provider must not double-register.
    host.emit('subagent/provider-added', host.provider)
    assert.equal(host.registered.length, 1)
    host.emit('subagent/provider-removed', 'spawn')
    assert.deepEqual(host.registered, [])
    // …and it can come back.
    host.emit('subagent/provider-added', host.provider)
    assert.equal(host.registered.length, 1)
  })

  test('events for another transport provider and an unknown removal are ignored', () => {
    const host = stubHost()
    apply(host.ctx, new Config({}))
    const before = host.registered.length
    host.emit('subagent/provider-added', { name: 'fork', capabilities: {}, prepareContinuable: () => {} })
    host.emit('subagent/provider-removed', 'fork')
    assert.equal(host.registered.length, before)
  })

  test('a missing systemPrompt service warns instead of failing silently', () => {
    const host = stubHost({ noSystemPrompt: true })
    apply(host.ctx, new Config({}))
    assert.deepEqual(host.registered.map((definition) => definition.name), ['subagent_role'])
    assert.match(host.warnings.join('\n'), /no systemPrompt service/)
  })

  test('a failing prompt registration is logged and does not break the tool', () => {
    const host = stubHost({ sectionThrows: true })
    apply(host.ctx, new Config({}))
    assert.match(host.errors.join('\n'), /role catalog section failed/)
    assert.deepEqual(host.registered.map((definition) => definition.name), ['subagent_role'])
  })

  test('the section survives a discovery error', () => {
    const host = stubHost()
    apply(host.ctx, new Config({}))
    const broken = { session: { header: { cwd: { not: 'a path' } } }, options: {} }
    assert.equal(host.sections[0].text({ agent: broken, scope: broken }), '')
  })

  test('two rows coexist: each keeps its own catalog section and tool names', () => {
    const host = stubHost()
    apply(host.ctx, new Config({ toolName: 'subagent_role', enableListTool: true }))
    apply(host.ctx, new Config({ toolName: 'subagent_role_fork', enableListTool: true, listToolName: 'subagent_roles_fork' }))
    assert.deepEqual(host.registered.map((definition) => definition.name), [
      'subagent_role', 'subagent_roles', 'subagent_role_fork', 'subagent_roles_fork',
    ])
    assert.deepEqual(host.sections.map((section) => section.name), [
      'subagent_role:catalog', 'subagent_role_fork:catalog',
    ])
    // Nothing was swallowed: a hardcoded section or tool name would have thrown.
    assert.deepEqual(host.errors, [])
  })

  test('the catalog section name follows the configured tool name', () => {
    assert.equal(catalogSectionName('role_delegate'), 'role_delegate:catalog')
    assert.equal(catalogSectionName(undefined), 'subagent_role:catalog')
    const host = stubHost()
    apply(host.ctx, new Config({ toolName: 'role_delegate' }))
    assert.equal(host.sections[0].name, 'role_delegate:catalog')
  })
})
