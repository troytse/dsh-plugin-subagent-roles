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
import { CATALOG_SECTION_NAME, apply } from '../lib/index.js'

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
  const ctx = {
    logger: { info() {}, warn: (message) => warnings.push(String(message)), debug() {} },
    on: () => () => {},
    effect: (callback) => callback(),
    get: (name) => (name === 'systemPrompt' ? systemPrompt : undefined),
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
      get: (name) => registered.find((definition) => definition.name === name),
      schemas: () => options.schemas ?? [],
    },
    subagents: { getProvider: (name) => (name === provider.name ? provider : undefined) },
  }
  const systemPrompt = {
    section: (definition) => {
      sections.push(definition)
      return () => {}
    },
    getSectionOrder: (key) => (key === 'TOOL_SUBAGENT' ? 2800 : 0),
  }
  return { ctx, warnings, registered, sections, provider }
}

function agentAt(cwd, depth = 0) {
  const agent = { options: {}, session: { header: { cwd, ...(depth > 0 ? { delegationDepth: depth } : {}) } } }
  return { agent, scope: agent }
}

function fixtureProject() {
  const project = sandbox()
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, '.dsh', 'roles'), { recursive: true })
  writeFileSync(join(project, '.dsh', 'roles', 'web-operator.md'), '---\ndisplayName: 浏览器操作员\ndescription: 浏览器调试与验证\ntools: [read]\n---\nPERSONA-BODY')
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
    assert.match(text, /^- `web-operator` \(浏览器操作员\): 浏览器调试与验证$/m)
    assert.equal(text.includes('PERSONA-BODY'), false)
    assert.equal(host.sections[0].text(agentAt(project, 1)), '')
  })

  test('catalogScope all reaches subagents too', () => {
    const project = fixtureProject()
    const host = stubHost()
    apply(host.ctx, new Config({ catalogScope: 'all' }))
    assert.match(host.sections[0].text(agentAt(project, 1)), /web-operator/)
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
    assert.match(text, /web-operator/)
    assert.equal(text.includes('broken'), false)
    assert.equal(host.warnings.some((message) => message.includes('broken.md')), true)
  })

  test('the section survives a discovery error', () => {
    const host = stubHost()
    apply(host.ctx, new Config({}))
    const broken = { session: { header: { cwd: { not: 'a path' } } }, options: {} }
    assert.equal(host.sections[0].text({ agent: broken, scope: broken }), '')
  })
})
