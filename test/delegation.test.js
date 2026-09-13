/**
 * Delegation orchestration: drives `subagent_role.execute` end to end against a
 * fake host, so the product path (route -> tool policy -> start) is covered
 * without spawning a real child. This is the code that must not silently
 * misbehave in production, so every branch that changes the child's contract is
 * asserted here.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Config } from '../lib/config.js'
import { createRoleListTool, createRoleTool } from '../lib/tool.js'

const ROLE = {
  id: 'web-verifier',
  displayName: 'Web 验证者',
  description: 'verify pages',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'low',
  toolFilter: { allow: ['read', 'grep'] },
  persona: '你是验证者。',
  path: '/p/.dsh/roles/web-verifier.md',
  source: 'project',
}

const VISIBLE = ['read', 'grep', 'bash', 'write', 'edit', 'subagent', 'run_code']

/** A run object shaped like the one `ctx.subagents.start` fulfils with. */
function run(output = 'ok', id = 'child-1') {
  return {
    id,
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }),
    dispose: async () => {},
  }
}

function fakeHost(options = {}) {
  const calls = { start: [], continuable: [], jobs: [], warnings: [], infos: [] }
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true, ...options.capabilities },
    ...(options.prepareContinuable === false ? {} : { prepareContinuable: () => Promise.resolve({}) }),
  }
  const ctx = {
    logger: {
      info: (message) => calls.infos.push(String(message)),
      warn: (message) => calls.warnings.push(String(message)),
      error: (message) => calls.warnings.push(String(message)),
    },
    get: (name) => {
      if (name === 'llm') return { listProviders: () => [{ id: 'deepseek-official' }] }
      if (name === 'settings') return options.settings
      if (name === 'jobs') return options.jobs
      return undefined
    },
    tools: {
      schemas: () => (options.schemas === false
        ? (() => { throw new Error('registry down') })()
        : (options.visible ?? VISIBLE).filter((name) => name !== 'run_code' || options.exposeRunCode === true).map((name) => ({ name }))),
    },
    subagents: {
      start: async (providerName, request) => {
        calls.start.push({ providerName, request })
        if (options.failFirstStart !== undefined && calls.start.length === 1) throw options.failFirstStart
        return run()
      },
      startContinuable: async (spec) => {
        calls.continuable.push(spec)
        return { childId: 'durable-1' }
      },
    },
  }
  const loader = {
    loadSync: () => ({ roles: options.roles ?? [ROLE], diagnostics: options.diagnostics ?? [], roots: [] }),
    projectRootFor: () => '/p',
  }
  return { ctx, provider, loader, calls }
}

function exec(overrides = {}) {
  return { agent: { session: { header: { cwd: '/p' } } }, signal: new AbortController().signal, ...overrides }
}

function tool(host, config = {}) {
  return createRoleTool({ ctx: host.ctx, config: new Config(config), provider: host.provider, loader: host.loader })
}

describe('subagent_role: argument and role resolution', () => {
  test('without defaultRole the schema itself requires a role', async () => {
    const host = fakeHost()
    await assert.rejects(tool(host).execute({ prompt: 'x', description: 'd' }, exec()), /missing required property "role"/)
  })

  test('a blank role (or blank defaultRole) is refused at run time', async () => {
    const host = fakeHost()
    await assert.rejects(tool(host).execute({ role: '   ', prompt: 'x', description: 'd' }, exec()), /no role was given/)
    const blankDefault = fakeHost()
    await assert.rejects(
      tool(blankDefault, { defaultRole: '   ' }).execute({ prompt: 'x', description: 'd' }, exec()),
      /no role was given.*web-verifier/,
    )
  })

  test('an unknown role lists the available ids', async () => {
    const host = fakeHost()
    await assert.rejects(tool(host).execute({ role: 'nope', prompt: 'x', description: 'd' }, exec()), /does not exist.*web-verifier/)
  })

  test('a display name resolves with a warning', async () => {
    const host = fakeHost()
    await tool(host).execute({ role: 'Web 验证者', prompt: 'x', description: 'd' }, exec())
    assert.match(host.calls.warnings.join('\n'), /resolved by displayName to id "web-verifier"/)
    assert.equal(host.calls.start.length, 1)
  })

  test('defaultRole fills an omitted role', async () => {
    const host = fakeHost()
    await tool(host, { defaultRole: 'web-verifier' }).execute({ prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start.length, 1)
  })

  test('a blank description is refused before anything starts', async () => {
    const host = fakeHost()
    await assert.rejects(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: '  ' }, exec()), /description.*non-empty/)
    assert.equal(host.calls.start.length, 0)
  })

  test('a call with no agent is refused', async () => {
    const host = fakeHost()
    await assert.rejects(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, { signal: new AbortController().signal }), /requires a calling agent/)
  })
})

describe('subagent_role: what reaches the child', () => {
  test('persona, route and expanded policy ride the request', async () => {
    const host = fakeHost()
    await tool(host).execute({ role: 'web-verifier', prompt: 'do it', description: 'verify pages' }, exec())
    const { request } = host.calls.start[0]
    assert.equal(request.label, 'verify pages')
    assert.deepEqual(request.prompt, [{ type: 'text', text: 'do it' }])
    assert.equal(request.persona, '你是验证者。')
    assert.deepEqual(request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
    assert.deepEqual(request.toolFilter, { allow: ['read', 'grep'] })
  })

  test('run_code never reaches a policy (the core refuses to restrict it)', async () => {
    const host = fakeHost({ exposeRunCode: true })
    const starred = { ...ROLE, toolFilter: { allow: ['*'] } }
    await tool(host, {}, { roles: [starred] }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    const { toolFilter } = host.calls.start[0].request
    assert.equal(toolFilter.allow.includes('run_code'), false)
    assert.equal(toolFilter.allow.includes('read'), true)
  })

  test('an unavailable name is dropped with a warning', async () => {
    const host = fakeHost()
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    const missing = { ...ROLE, toolFilter: { allow: ['read', 'ghost'] } }
    const host2 = fakeHost({ roles: [missing] })
    await tool(host2).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(host2.calls.start[0].request.toolFilter, { allow: ['read'] })
    assert.match(host2.calls.warnings.join('\n'), /unavailable tool\(s\) ghost/)
  })

  test('an empty policy is reported and still passed through (fail closed)', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, toolFilter: { allow: ['ghost'] } }] })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(host.calls.start[0].request.toolFilter, { allow: [] })
    assert.match(host.calls.warnings.join('\n'), /allows no currently available tool/)
  })

  test('onMissingTool=error refuses instead of degrading', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, toolFilter: { allow: ['ghost'] } }] })
    await assert.rejects(
      tool(host, { onMissingTool: 'error' }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()),
      /unavailable tool "ghost"/,
    )
    assert.equal(host.calls.start.length, 0)
  })

  test('an unreadable catalog with a role policy fails loud', async () => {
    const host = fakeHost({ schemas: false })
    await assert.rejects(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()), /visible tool catalog is unreadable/)
  })

  test('a child-unrestrictable name is dropped and the start retried once', async () => {
    const failure = new Error('tools.restrict() names unknown global tool "subagent"; known global tools: read, grep')
    const host = fakeHost({ failFirstStart: failure, roles: [{ ...ROLE, toolFilter: { allow: ['read', 'grep', 'subagent'] } }] })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start.length, 2)
    assert.deepEqual(host.calls.start[0].request.toolFilter, { allow: ['read', 'grep', 'subagent'] })
    assert.deepEqual(host.calls.start[1].request.toolFilter, { allow: ['read', 'grep'] })
    assert.match(host.calls.warnings.join('\n'), /cannot restrict "subagent"/)
  })

  test('with onMissingTool=error the restrict failure stays loud', async () => {
    const failure = new Error('tools.restrict() names unknown global tool "subagent"')
    const host = fakeHost({ failFirstStart: failure, roles: [{ ...ROLE, toolFilter: { allow: ['read', 'subagent'] } }] })
    await assert.rejects(
      tool(host, { onMissingTool: 'error' }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()),
      /unknown global tool/,
    )
    assert.equal(host.calls.start.length, 1)
  })
})

describe('subagent_role: route and capability gates', () => {
  test('an unauthorized role route is dropped and the child inherits', async () => {
    const settings = { get: () => ({ enabled: true, allowedModels: [{ provider: 'other', model: 'x' }] }) }
    const host = fakeHost({ settings })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start[0].request.agentOptions, undefined)
    assert.match(host.calls.warnings.join('\n'), /not in the authorized model list/)
  })

  test('an unroutable role provider is refused', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, provider: 'ghost-llm', model: 'm' }] })
    await assert.rejects(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()), /is not routable/)
  })

  test('a provider without the persona capability refuses the role', async () => {
    const host = fakeHost({ capabilities: { persona: false } })
    await assert.rejects(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()), /does not support the persona capability/)
  })

  test('respectModelSelection=false ignores the authorized list', async () => {
    const settings = { get: () => ({ enabled: true, allowedModels: [{ provider: 'other', model: 'x' }] }) }
    const host = fakeHost({ settings })
    await tool(host, { respectModelSelection: false }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(host.calls.start[0].request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
  })
})

describe('subagent_role: run modes', () => {
  test('the default is a foreground run that settles its result', async () => {
    const host = fakeHost()
    const value = await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(value, { kind: 'foreground', runId: 'child-1', output: [{ type: 'text', text: 'ok' }] })
  })

  test('a non-completed foreground run is an error carrying the partial output', async () => {
    const host = fakeHost()
    host.ctx.subagents.start = async () => ({
      id: 'child-2',
      result: Promise.resolve({ stopReason: 'max-tokens', output: [{ type: 'text', text: 'half done' }] }),
      dispose: async () => {},
    })
    await assert.rejects(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()), /token limit[\s\S]*half done/)
  })

  test('every non-completed stop reason becomes an actionable error', async () => {
    const cases = [
      ['aborted', /was cancelled/],
      ['refusal', /declined the task/],
      ['weird-reason', /ended abnormally \(weird-reason\)/],
    ]
    for (const [stopReason, pattern] of cases) {
      const host = fakeHost()
      host.ctx.subagents.start = async () => ({
        id: 'child-x',
        result: Promise.resolve({ stopReason, output: [] }),
        dispose: async () => {},
      })
      await assert.rejects(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()), pattern)
    }
  })

  test('skipped role files are reported on every delegation', async () => {
    const host = fakeHost({ diagnostics: [{ id: 'bad', path: '/p/.dsh/roles/bad.md', source: 'project', reason: 'missing description' }] })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.match(host.calls.warnings.join('\n'), /skipped bad \(project\) at \/p\/\.dsh\/roles\/bad\.md: missing description/)
  })

  test('one-shot background registers a job', async () => {
    const host = fakeHost({ jobs: { start: (spec) => { host.calls.jobs.push(spec); return 'job-7' } } })
    const value = await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd', run_in_background: true }, exec())
    assert.deepEqual(value, { kind: 'background', jobId: 'job-7' })
    assert.equal(host.calls.jobs.length, 1)
  })

  test('one-shot background without a jobs service is refused', async () => {
    const host = fakeHost()
    await assert.rejects(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd', run_in_background: true }, exec()), /background jobs unavailable/)
  })

  test('continuable mode returns the durable child id', async () => {
    const host = fakeHost()
    const value = await tool(host, { backgroundMode: 'continuable' }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(value, { kind: 'continuable', subagentId: 'durable-1' })
    assert.equal(host.calls.continuable.length, 1)
  })

  test('continuable mode with run_in_background=false waits instead', async () => {
    const host = fakeHost()
    const value = await tool(host, { backgroundMode: 'continuable' }).execute({ role: 'web-verifier', prompt: 'x', description: 'd', run_in_background: false }, exec())
    assert.equal(value.kind, 'foreground')
    assert.equal(host.calls.continuable.length, 0)
  })

  test('a disabled run_in_background is not advertised and refuses a forced call', async () => {
    const host = fakeHost()
    const definition = tool(host, { enableRunInBackground: false })
    assert.equal('run_in_background' in definition.parameters.properties, false)
    await assert.rejects(definition.execute({ role: 'web-verifier', prompt: 'x', description: 'd', run_in_background: true }, exec()), /run_in_background is disabled/)
  })
})

describe('subagent_roles (diagnostic tool)', () => {
  test('reports roles, sources, paths and the expanded budget', async () => {
    const host = fakeHost({ diagnostics: [{ id: 'bad', path: '/p/.dsh/roles/bad.md', source: 'project', reason: 'missing description' }] })
    const definition = createRoleListTool({ ctx: host.ctx, config: new Config({}), loader: host.loader })
    const text = await definition.execute({}, exec())
    assert.match(text, /roles: 1/)
    assert.match(text, /- web-verifier \[project\] deepseek-official \/ deepseek-v4-flash \/ low/)
    assert.match(text, /path: \/p\/\.dsh\/roles\/web-verifier\.md/)
    assert.match(text, /expanded: allow=\[read, grep\]/)
    assert.match(text, /budget: \d+ of \d+ visible tool-schema chars/)
    assert.match(text, /skipped files: 1/)
    assert.match(text, /bad \[project\].*missing description/)
  })

  test('an unreadable catalog is labelled instead of silently shown', async () => {
    const host = fakeHost({ schemas: false })
    const definition = createRoleListTool({ ctx: host.ctx, config: new Config({}), loader: host.loader })
    const text = await definition.execute({}, exec())
    assert.match(text, /visible tools: unreadable/)
    assert.match(text, /expanded \(tool catalog unreadable/)
  })
})
