/**
 * Remaining behavioural edges that the orchestration tests do not reach:
 * result rendering, disposal failures, the background job callback, and the
 * malformed-document branches of role parsing.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { Config } from '../lib/config.js'
import { createRoleLoader, parseRoleDocument } from '../lib/roles.js'
import { createRoleListTool, createRoleTool, readModelSelection, renderDelegationResult } from '../lib/tool.js'

const roots = []
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-roles-edges-'))
  roots.push(dir)
  return dir
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const ROLE = {
  id: 'web-verifier',
  displayName: 'Web 验证者',
  description: 'verify pages',
  toolFilter: { allow: ['read'] },
  persona: '你是验证者。',
  path: '/p/.dsh/roles/web-verifier.md',
  source: 'project',
}

function toolFor(startBehaviour, options = {}) {
  const calls = { warnings: [], jobs: [] }
  const ctx = {
    logger: { info() {}, warn: (m) => calls.warnings.push(String(m)), error: (m) => calls.warnings.push(String(m)) },
    get: (name) => (name === 'jobs' ? { start: (spec) => { calls.jobs.push(spec); return 'job-1' } } : undefined),
    tools: { schemas: () => [{ name: 'read' }, { name: 'grep' }] },
    subagents: { start: startBehaviour, startContinuable: async () => ({ childId: 'c1' }) },
  }
  const provider = { name: 'spawn', capabilities: { persona: true, toolFilter: true, agentOptions: true, depthLimit: true } }
  const loader = { loadSync: () => ({ roles: [ROLE], diagnostics: [] }), projectRootFor: () => '/p' }
  return { definition: createRoleTool({ ctx, config: new Config(options.config ?? {}), provider, loader }), calls }
}

const exec = () => ({ agent: { session: { header: { cwd: '/p' } } }, signal: new AbortController().signal })
const args = { role: 'web-verifier', prompt: 'x', description: 'd' }

describe('result rendering', () => {
  test('renders every result kind', () => {
    assert.equal(renderDelegationResult({ kind: 'background', jobId: 'j1' }, 'subagent_role'), 'started background subagent_role task j1')
    assert.equal(renderDelegationResult({ kind: 'continuable', subagentId: 's1' }, 'subagent_role'), 'started subagent s1')
    assert.equal(renderDelegationResult({ kind: 'foreground', runId: 'r', output: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }, 'subagent_role'), 'ab')
  })

  test('tolerates a missing or malformed output list', () => {
    assert.equal(renderDelegationResult({ kind: 'foreground', output: undefined }, 'x'), '')
    assert.equal(renderDelegationResult({ kind: 'foreground', output: [null, 'text'] }, 'x'), '')
  })
})

describe('disposal handling', () => {
  test('a dispose failure surfaces instead of being swallowed', async () => {
    const { definition } = toolFor(async () => ({
      id: 'r1',
      result: Promise.resolve({ stopReason: 'completed', output: [] }),
      dispose: async () => { throw new Error('dispose exploded') },
    }))
    await assert.rejects(definition.execute(args, exec()), /dispose exploded/)
  })

  test('a run failure plus a dispose failure aggregates both', async () => {
    const { definition } = toolFor(async () => ({
      id: 'r2',
      result: Promise.resolve({ stopReason: 'error', output: [] }),
      dispose: async () => { throw new Error('dispose exploded') },
    }))
    await assert.rejects(definition.execute(args, exec()), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.match(String(error.message), /dispose failed/)
      return true
    })
  })
})

describe('background job callback', () => {
  test('a failed start settles the job as failed', async () => {
    const { definition, calls } = toolFor(async () => { throw new Error('start blew up') })
    await definition.execute({ ...args, run_in_background: true }, exec())
    const settled = await calls.jobs[0].run().done
    assert.deepEqual(settled, { status: 'failed', detail: 'Error: start blew up' })
  })

  test('a cancelled job reports killed', async () => {
    // The real registry rejects a start whose signal aborts; the fake must too,
    // otherwise the job callback would wait forever.
    const abortAware = (_providerName, request) => new Promise((_resolve, reject) => {
      if (request.signal.aborted) reject(new Error('aborted'))
      else request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    const { definition, calls } = toolFor(abortAware)
    await definition.execute({ ...args, run_in_background: true }, exec())
    const job = calls.jobs[0].run()
    job.cancel('stop')
    const settled = await job.done
    assert.deepEqual(settled, { status: 'killed' })
  })

  test('a completed job resolves the run', async () => {
    const { definition, calls } = toolFor(async () => ({
      id: 'bg',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }),
      dispose: async () => {},
    }))
    await definition.execute({ ...args, run_in_background: true }, exec())
    const settled = await calls.jobs[0].run().done
    // The core's settleRun normalizes the run into { status, output }.
    assert.deepEqual(settled, { status: 'completed', output: 'done' })
  })
})

describe('continuable capability', () => {
  test('a provider without prepareContinuable refuses continuable mode', async () => {
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      get: () => undefined,
      tools: { schemas: () => [{ name: 'read' }] },
      subagents: { start: async () => { throw new Error('unused') }, startContinuable: async () => ({ childId: 'c' }) },
    }
    const provider = { name: 'spawn', capabilities: { persona: true, toolFilter: true } }
    const loader = { loadSync: () => ({ roles: [ROLE], diagnostics: [] }) }
    const definition = createRoleTool({ ctx, config: new Config({ backgroundMode: 'continuable' }), provider, loader })
    await assert.rejects(definition.execute(args, exec()), /does not support backgroundMode: continuable/)
  })
})

describe('model selection seam', () => {
  const ctxWith = (settings) => ({ get: (name) => (name === 'settings' ? settings : undefined) })

  test('a missing seam, a throwing getter, and a non-object section all mean "no constraint"', () => {
    assert.deepEqual(readModelSelection({ get: () => undefined }), { sectionPresent: false, allowedRoutes: undefined })
    assert.deepEqual(readModelSelection(ctxWith({ get: () => { throw new Error('unknown namespace') } })), { sectionPresent: false, allowedRoutes: undefined })
    assert.deepEqual(readModelSelection(ctxWith({ get: () => 'nope' })), { sectionPresent: false, allowedRoutes: undefined })
  })

  test('the list only constrains when enabled with usable entries', () => {
    const entries = [{ provider: 'p', model: 'm' }, { provider: 'p' }, null]
    assert.equal(readModelSelection(ctxWith({ get: () => ({ enabled: false, allowedModels: entries }) })).allowedRoutes, undefined)
    assert.equal(readModelSelection(ctxWith({ get: () => ({ enabled: true, allowedModels: entries }) })).allowedRoutes.length, 1)
    assert.equal(readModelSelection(ctxWith({ get: () => ({ enabled: true }) })).allowedRoutes, undefined)
  })
})

describe('diagnostic tool: gaps', () => {
  test('a role with no policy, no persona and no route is described as such', async () => {
    const bare = { id: 'bare', displayName: 'bare', description: 'd', path: '/p/.dsh/roles/bare.md', source: 'global' }
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      get: () => undefined,
      tools: { schemas: () => [{ name: 'read' }] },
      subagents: {},
    }
    const loader = { loadSync: () => ({ roles: [bare], diagnostics: [] }), projectRootFor: () => '/p' }
    const definition = createRoleListTool({ ctx, config: new Config({}), loader })
    const text = await definition.execute({}, exec())
    assert.match(text, /- bare \[global\] \(inherits parent\)/)
    assert.match(text, /persona: \(none\)/)
    assert.match(text, /tool policy: \(none — inherits every visible tool\)/)
  })

  test('the loader project root is reported when there is no cwd', async () => {
    const ctx = { logger: { info() {}, warn() {}, error() {} }, get: () => undefined, tools: { schemas: () => [] }, subagents: {} }
    const loader = { loadSync: () => ({ roles: [], diagnostics: [] }), projectRootFor: () => undefined }
    const definition = createRoleListTool({ ctx, config: new Config({}), loader })
    const text = await definition.execute({}, { agent: undefined, signal: new AbortController().signal })
    assert.match(text, /cwd: \(none\)/)
    assert.match(text, /projectRoot: \(none\)/)
    assert.match(text, /roles: 0/)
  })
})

describe('malformed role documents', () => {
  const cases = [
    ['invalid YAML', '---\ndescription: [unclosed\n---\np', /not valid YAML/],
    ['frontmatter is a list', '---\n- a\n- b\n---\np', /must be a YAML mapping/],
    ['toolFilter is a string', '---\ndescription: d\ntoolFilter: nope\n---\np', /must be an object/],
    ['toolFilter unknown key', '---\ndescription: d\ntoolFilter:\n  only: [read]\n---\np', /not supported/],
    ['blank displayName', '---\ndescription: d\ndisplayName: "  "\n---\np', /`displayName` must be a non-empty string/],
    ['blank whenToUse', '---\ndescription: d\nwhenToUse: ""\n---\np', /`whenToUse` must be a non-empty string/],
    ['blank reasoningEffort', '---\ndescription: d\nreasoningEffort: " "\n---\np', /`reasoningEffort` must be a non-empty string/],
    ['empty frontmatter block', '---\n---\np', /`description` is required/],
  ]
  for (const [name, raw, pattern] of cases) {
    test(`refuses ${name}`, () => {
      assert.match(parseRoleDocument('worker', raw).error, pattern)
    })
  }

  test('an unreadable role directory is treated as empty, not fatal', () => {
    const project = sandbox()
    mkdirSync(join(project, '.git'), { recursive: true })
    // A FILE where the roles directory would be: readdir must fail softly.
    writeFileSync(join(project, '.dsh'), 'not a directory')
    const loader = createRoleLoader({ dshHome: sandbox() })
    const { roles, diagnostics } = loader.loadSync(project)
    assert.deepEqual(roles, [])
    assert.deepEqual(diagnostics, [])
  })

  test('an unreadable role file is reported and skipped', () => {
    const project = sandbox()
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(join(project, '.dsh', 'roles'), { recursive: true })
    const loader = createRoleLoader({ dshHome: sandbox() })
    // A dangling symlink: stat fails, so the file is diagnosed rather than read.
    const link = join(project, '.dsh', 'roles', 'ghost.md')
    symlinkSync(join(project, 'missing-target.md'), link)
    const { roles, diagnostics } = loader.loadSync(project)
    assert.deepEqual(roles, [])
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].reason, /cannot stat role file/)
  })
})
