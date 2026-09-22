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
import { createToolCallBudgetMonitor } from '../lib/budget.js'
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
function run(output = 'ok', id = 'child-1', localAgent) {
  return {
    id,
    ...(localAgent !== undefined ? { localAgent } : {}),
    result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }),
    dispose: async () => {},
  }
}

function fakeHost(options = {}) {
  const calls = { start: [], continuable: [], jobs: [], warnings: [], infos: [], interrupts: [], subscriptions: [] }
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true, ...options.capabilities },
    ...(options.inheritsParentContext === true ? { inheritsParentContext: true } : {}),
    ...(options.agentRouteDefaults !== undefined ? { agentRouteDefaults: options.agentRouteDefaults } : {}),
    ...(options.prepareContinuable === false ? {} : { prepareContinuable: () => Promise.resolve({}) }),
  }
  const ctx = {
    logger: {
      info: (message) => calls.infos.push(String(message)),
      warn: (message) => calls.warnings.push(String(message)),
      error: (message) => calls.warnings.push(String(message)),
    },
    // The budget monitor subscribes once with `{ global: true }`; the fake keeps
    // the listener so a test can commit a child's events by hand.
    on: (name, listener, opts) => {
      const entry = { name, listener, opts }
      calls.subscriptions.push(entry)
      return () => {
        const at = calls.subscriptions.indexOf(entry)
        if (at >= 0) calls.subscriptions.splice(at, 1)
      }
    },
    get: (name) => {
      if (name === 'llm') return options.llm ?? { listProviders: () => [{ id: 'deepseek-official' }] }
      if (name === 'settings') return options.settings
      if (name === 'jobs') return options.jobs
      if (name === 'sessionProjections') return options.sessionProjections
      if (name === 'sessions') return options.sessions
      if (name === 'agents') return options.agents
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
      interrupt: (targetSessionId, authority) => {
        calls.interrupts.push({ targetSessionId, authority })
      },
    },
  }
  const loader = {
    loadSync: () => ({ roles: options.roles ?? [ROLE], diagnostics: options.diagnostics ?? [], roots: [] }),
    projectRootFor: () => '/p',
  }
  // Created from the same ctx as the tool, so both share ONE observation seam.
  const budgetMonitor = createToolCallBudgetMonitor({ ctx, log: (message) => calls.warnings.push(String(message)) })
  return { ctx, provider, loader, budgetMonitor, calls }
}

/**
 * Commit one event to the `session/event` listener the host registered.
 *
 * Filtered by NAME: the monitor now also registers a `session/disposed` release,
 * and broadcasting blindly would hand that listener a `tool/call` event, making
 * it release the very record the test is trying to count into.
 */
function emit(host, sessionId, event) {
  for (const entry of [...host.calls.subscriptions]) {
    if (entry.name === 'session/event') entry.listener({ id: sessionId }, event)
  }
}

/** Announce one session's disposal to the listener registered for it. */
function emitDisposed(host, sessionId) {
  for (const entry of [...host.calls.subscriptions]) {
    if (entry.name === 'session/disposed') entry.listener({ id: sessionId })
  }
}

/** Commit `count` tool calls for one child session, in the given turn. */
function emitCalls(host, sessionId, count, turn = 1) {
  for (let index = 0; index < count; index += 1) {
    emit(host, sessionId, { type: 'tool/call', data: { turn, step: index + 1, callId: `c${turn}-${index}`, name: 'read', arguments: {} } })
  }
}

/** Wait until `predicate` holds, or fail loudly instead of hanging. */
async function until(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Wait until the delegation's budget record is armed.
 *
 * The record is armed only after `start` resolves, while the fake child's
 * resolver exists as soon as `start` is CALLED — so waiting on the run would let
 * a test commit events into a delegation nothing was tracking yet.
 */
const armed = (host, label = 'the budget record to arm') => until(() => host.budgetMonitor.size > 0, label)

/** The route the delegating agent is already on. */
const PARENT_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

function exec(overrides = {}) {
  const agent = {
    options: { ...PARENT_ROUTE },
    session: { header: { cwd: '/p' }, requestHeader: () => ({ config: { ...PARENT_ROUTE } }) },
    ...(overrides.agent ?? {}),
  }
  return { ...overrides, agent, signal: overrides.signal ?? new AbortController().signal }
}

function tool(host, config = {}) {
  return createRoleTool({ ctx: host.ctx, config: new Config(config), provider: host.provider, loader: host.loader, budgetMonitor: host.budgetMonitor })
}

/** The message of a rejection, or a failure if the promise resolved. */
async function rejectionMessage(promise) {
  try {
    await promise
  } catch (error) {
    return error.message
  }
  throw new Error('expected a rejection, but the call resolved')
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

describe('subagent_role: wording follows the transport provider', () => {
  test('a fresh provider gets the self-contained wording on the schema', () => {
    const definition = tool(fakeHost())
    assert.match(definition.description, /self-contained task/)
    assert.match(definition.parameters.properties.prompt.description, /does not share this conversation's context/)
  })

  test('a fork provider gets the inherits-conversation wording on the schema', () => {
    const definition = tool(fakeHost({ inheritsParentContext: true }))
    assert.match(definition.description, /seeded with this conversation's completed turns/)
    assert.doesNotMatch(definition.description, /self-contained/)
    assert.match(definition.parameters.properties.prompt.description, /already sees this conversation's completed turns/)
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

  test("the provider's own diagnostic reaches the delegating agent", async () => {
    const host = fakeHost()
    host.ctx.subagents.start = async () => ({
      id: 'child-3',
      result: Promise.resolve({
        stopReason: 'error',
        diagnostic: 'adapter refused: context window exceeded',
        output: [{ type: 'text', text: 'partial answer' }],
      }),
      dispose: async () => {},
    })
    await assert.rejects(
      tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()),
      /subagent run failed[\s\S]*Diagnostic: adapter refused: context window exceeded[\s\S]*partial answer/,
    )
  })

  test('a completed run is unaffected by the diagnostic path', async () => {
    const host = fakeHost()
    host.ctx.subagents.start = async () => ({
      id: 'child-4',
      result: Promise.resolve({ stopReason: 'completed', diagnostic: 'noise', output: [{ type: 'text', text: 'ok' }] }),
      dispose: async () => {},
    })
    const value = await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(value, { kind: 'foreground', runId: 'child-4', output: [{ type: 'text', text: 'ok' }] })
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

describe('subagent_role: LLM route preflight', () => {
  /** An llm seam whose resolveCallConfig accepts exactly one route. */
  const strictLlm = (resolved = []) => ({
    listProviders: () => [{ id: 'deepseek-official' }],
    resolveCallConfig: async (config) => {
      resolved.push(config)
      const knownModel = config.provider === 'deepseek-official' && config.model === 'deepseek-v4-flash'
      if (!knownModel) throw new Error(`unknown model "${config.model}" for provider "${config.provider}"`)
      if (config.reasoningEffort !== undefined && config.reasoningEffort !== 'low') {
        throw new Error(`unknown reasoning effort "${config.reasoningEffort}"`)
      }
    },
  })

  test('the effective route is resolved through the live adapter', async () => {
    const resolved = []
    const host = fakeHost({ llm: strictLlm(resolved) })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(resolved, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' }])
    assert.equal(host.calls.start.length, 1)
  })

  test('an unknown model is refused with a correctable message, not an opaque one', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, model: 'deepseek-v9-typo' }], llm: strictLlm() })
    const message = await rejectionMessage(tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()))
    assert.match(message, /cannot resolve the child LLM route `deepseek-official\/deepseek-v9-typo`/)
    assert.match(message, /unknown model "deepseek-v9-typo"/)
    assert.equal(host.calls.start.length, 0)
  })

  test('an unknown reasoning effort is refused before any child is created', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, reasoningEffort: 'turbo' }], llm: strictLlm() })
    await assert.rejects(
      tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec()),
      /with reasoning effort `turbo`/,
    )
    assert.equal(host.calls.start.length, 0)
  })

  test('a deployment without the seam degrades to provider membership', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, model: 'anything-at-all' }] })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start.length, 1)
  })

  test('an unreadable provider list is not evidence that the route is wrong', async () => {
    const host = fakeHost({ llm: { listProviders: () => { throw new Error('llm registry down') } } })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start.length, 1)
  })
})

describe('subagent_role: provider route defaults', () => {
  const defaults = { provider: 'provider-default', model: 'provider-model' }

  test('defaults fill a route the role did not bind', async () => {
    const llm = { listProviders: () => [{ id: 'deepseek-official' }, { id: 'provider-default' }] }
    const host = fakeHost({ roles: [{ ...ROLE, provider: undefined, model: undefined, reasoningEffort: 'low' }], agentRouteDefaults: defaults, llm })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(host.calls.start[0].request.agentOptions, { provider: 'provider-default', model: 'provider-model', reasoningEffort: 'low' })
  })

  test('a role that binds nothing at all still inherits the parent', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, provider: undefined, model: undefined, reasoningEffort: undefined }], agentRouteDefaults: defaults })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start[0].request.agentOptions, undefined)
  })

  test('defaults never resurrect a route the authorized list rejected', async () => {
    const settings = { get: () => ({ enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }] }) }
    const rejected = { ...ROLE, provider: 'local', model: 'Qwen3.6-35B-A3B' }
    const host = fakeHost({ settings, roles: [rejected], agentRouteDefaults: defaults })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start[0].request.agentOptions, undefined)
    assert.match(host.calls.warnings.join('\n'), /not in the authorized model list/)
  })

  test('the role binding wins over the provider defaults', async () => {
    const host = fakeHost({ agentRouteDefaults: defaults })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.deepEqual(host.calls.start[0].request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
  })
})

describe('subagent_role: durable model-selection policy', () => {
  const routes = [{ provider: 'captured', model: 'captured-model' }]

  test('a captured per-Session policy wins over the live setting', async () => {
    const settings = { get: () => ({ enabled: true, allowedModels: [{ provider: 'live', model: 'live-model' }] }) }
    const projections = { stateOf: () => routes }
    const host = fakeHost({ settings, sessionProjections: projections })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    // The role route is not in the captured list, so it is dropped.
    assert.equal(host.calls.start[0].request.agentOptions, undefined)
    assert.match(host.calls.warnings.join('\n'), /not in the authorized model list/)
  })

  test('the live setting seeds a Session that captured nothing', async () => {
    const settings = { get: () => ({ enabled: true, allowedModels: routes }) }
    const projections = { stateOf: () => null }
    const host = fakeHost({ settings, sessionProjections: projections })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start[0].request.agentOptions, undefined)
  })

  test('a child Session inherits its parent Session policy', async () => {
    const settings = { get: () => ({ enabled: true, allowedModels: [] }) }
    const child = { header: { cwd: '/p', origin: 'subagent', parentSession: 'parent-1' } }
    const parent = { id: 'parent-1' }
    const projections = { stateOf: (session) => (session === parent ? routes : null) }
    const host = fakeHost({ settings, sessionProjections: projections, sessions: { get: (id) => (id === 'parent-1' ? parent : undefined) } })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec({ agent: { session: child } }))
    assert.equal(host.calls.start[0].request.agentOptions, undefined)
    assert.match(host.calls.warnings.join('\n'), /not in the authorized model list/)
  })

  test('an unreadable projection service is not a constraint', async () => {
    const settings = { get: () => ({ enabled: true, allowedModels: routes }) }
    const projections = { stateOf: () => { throw new Error('projection registry closed') } }
    const host = fakeHost({ settings, sessionProjections: projections })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.match(host.calls.warnings.join('\n'), /not in the authorized model list/)
  })
})

describe('subagent_role: shared display names', () => {
  test('a label shared by two roles is reported instead of silently picked', async () => {
    const twin = { ...ROLE, id: 'web-verifier-global', source: 'global' }
    const host = fakeHost({ roles: [ROLE, twin] })
    await tool(host).execute({ role: 'Web 验证者', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.start.length, 1)
    assert.match(host.calls.warnings.join('\n'), /shared by 2 roles \(web-verifier, web-verifier-global\); resolved to id "web-verifier"/)
  })

  test('an id always wins over a clashing label', async () => {
    const twin = { ...ROLE, id: 'decoy', displayName: 'web-verifier' }
    const host = fakeHost({ roles: [twin, ROLE] })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.calls.warnings.length, 0)
  })
})

describe('subagent_role: row knobs', () => {
  test('timeoutMs reaches the tool definition only when configured', () => {
    assert.equal(tool(fakeHost()).timeoutMs, undefined)
    assert.equal(tool(fakeHost(), { timeoutMs: 2500 }).timeoutMs, 2500)
  })

  test('the log reports the mode the call actually takes', async () => {
    const host = fakeHost()
    await tool(host, { backgroundMode: 'continuable', enableRunInBackground: false })
      .execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.match(host.calls.infos.join('\n'), /mode=foreground/)
    assert.equal(host.calls.continuable.length, 0)
  })

  test('the log reports the resolved route layer', async () => {
    const bound = fakeHost()
    await tool(bound).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.match(bound.calls.infos.join('\n'), /routeLayer=role/)

    const inherited = fakeHost({ roles: [{ ...ROLE, provider: undefined, model: undefined, reasoningEffort: undefined }] })
    await tool(inherited).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.match(inherited.calls.infos.join('\n'), /routeLayer=inherit/)
  })

  test('the diagnostic tool honours a configured name', () => {
    const host = fakeHost()
    assert.equal(createRoleListTool({ ctx: host.ctx, config: new Config({}), loader: host.loader }).name, 'subagent_roles')
    assert.equal(createRoleListTool({ ctx: host.ctx, config: new Config({ listToolName: 'roles_report' }), loader: host.loader }).name, 'roles_report')
  })
})

describe('subagent_role: tool-call budget enforcement', () => {
  const budgeted = (budget) => fakeHost({ roles: [{ ...ROLE, ...budget }] })

  test('a foreground child is stopped through the signal its run owns', async () => {
    // `SubagentRuntime.interrupt()` is an accepted NO-OP for a one-shot run, so
    // the run's own signal is the only channel that actually stops it.
    const host = budgeted({ maxToolCalls: 2, onToolCallBudget: 'interrupt' })
    let settle
    let runSignal
    host.ctx.subagents.start = async (providerName, request) => {
      runSignal = request.signal
      return { id: 'child-9', result: new Promise((resolve) => { settle = resolve }), dispose: async () => {} }
    }
    const pending = tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    await armed(host, 'the foreground child to be tracked')
    emitCalls(host, 'child-9', 2)
    assert.equal(runSignal.aborted, false, 'exactly the limit must not stop the child')
    emitCalls(host, 'child-9', 1)
    assert.equal(runSignal.aborted, true, 'the crossing call aborts the run signal')
    settle({ stopReason: 'aborted', output: [{ type: 'text', text: 'half done' }] })
    const value = await pending
    assert.equal(value.kind, 'budget-exceeded')
    assert.equal(value.status, 'tool-call-budget-exceeded')
    assert.equal(value.reason, 'tool-call-budget')
    assert.equal(value.used, 3)
    assert.equal(value.limit, 2)
    assert.equal(value.scope, 'delegation')
    assert.equal(value.mode, 'interrupt')
    assert.equal(value.partialOutput, 'half done')
    assert.equal(host.calls.interrupts.length, 0, 'a one-shot run is never interrupted through the runtime')
  })

  test('the budget stop is logged with the pinned wording', async () => {
    const host = budgeted({ maxToolCalls: 1, onToolCallBudget: 'interrupt' })
    let settle
    host.ctx.subagents.start = async () => ({ id: 'child-log', result: new Promise((resolve) => { settle = resolve }), dispose: async () => {} })
    const pending = tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    await armed(host, 'the child to be tracked')
    emitCalls(host, 'child-log', 2)
    settle({ stopReason: 'aborted', output: [] })
    await pending
    assert.match(host.calls.warnings.join('\n'), /\[subagent-roles\] role=web-verifier tool-call budget exceeded: used=2 limit=1 scope=delegation mode=interrupt/)
  })

  test('a continuable child is interrupted through the runtime with ancestor authority', async () => {
    const host = budgeted({ maxToolCalls: 2, onToolCallBudget: 'interrupt' })
    const execution = exec()
    const value = await tool(host, { backgroundMode: 'continuable' })
      .execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, execution)
    assert.deepEqual(value, { kind: 'continuable', subagentId: 'durable-1' })
    emitCalls(host, 'durable-1', 3)
    assert.equal(host.calls.interrupts.length, 1)
    assert.equal(host.calls.interrupts[0].targetSessionId, 'durable-1')
    assert.equal(host.calls.interrupts[0].authority.kind, 'ancestor')
    assert.equal(host.calls.interrupts[0].authority.agent, execution.agent)
  })

  test('a background one-shot child aborts its controller and says why the job stopped', async () => {
    const host = budgeted({ maxToolCalls: 1, onToolCallBudget: 'interrupt' })
    host.ctx.get = ((original) => (name) => (name === 'jobs'
      ? { start: (spec) => { host.calls.jobs.push(spec); return 'job-9' } }
      : original(name)))(host.ctx.get)
    let settle
    let runSignal
    host.ctx.subagents.start = async (providerName, request) => {
      runSignal = request.signal
      return { id: 'child-bg', result: new Promise((resolve) => { settle = resolve }), dispose: async () => {} }
    }
    const value = await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd', run_in_background: true }, exec())
    assert.deepEqual(value, { kind: 'background', jobId: 'job-9' })
    const handle = host.calls.jobs[0].run()
    await armed(host, 'the background child to be tracked')
    emitCalls(host, 'child-bg', 2)
    assert.equal(runSignal.aborted, true)
    settle({ stopReason: 'aborted', output: [] })
    // `killed` alone cannot be told apart from a user kill; the budget names itself.
    assert.deepEqual(await handle.done, {
      status: 'failed',
      detail: 'tool-call budget exceeded: used=2 limit=1 scope=delegation mode=interrupt',
    })
  })

  test('the wrap-up notice is plugin-attributed and never impersonates the user', async () => {
    const injected = []
    const localAgent = { id: 'child-w', inject: (message) => injected.push(message) }
    const host = budgeted({ maxToolCalls: 1, onToolCallBudget: 'wrap-up', graceToolCalls: 1 })
    let settle
    host.ctx.subagents.start = async () => ({ id: 'child-w', localAgent, result: new Promise((resolve) => { settle = resolve }), dispose: async () => {} })
    const pending = tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    await armed(host, 'the child to be tracked')
    emitCalls(host, 'child-w', 2)
    assert.equal(injected.length, 1, 'the notice is injected exactly once')
    assert.equal(injected[0].role, 'user')
    // An omitted source resolves to `user`, which would let a machine-generated
    // instruction inherit human authority; the explicit plugin source forbids it.
    assert.equal(injected[0].source.kind, 'plugin')
    assert.equal(injected[0].source.plugin, 'subagent-roles')
    assert.equal(injected[0].source.form, 'notice')
    assert.match(injected[0].content[0].text, /budget exhausted/i)
    settle({ stopReason: 'completed', output: [{ type: 'text', text: 'wrapped up' }] })
    const value = await pending
    assert.equal(value.kind, 'foreground', 'a child that wraps up in time is not stopped')
    assert.equal(value.output[0].text, 'wrapped up')
  })

  test('a continuable child is told to wrap up through its live agent', async () => {
    const injected = []
    const liveAgent = { id: 'durable-1', inject: (message) => injected.push(message) }
    const host = budgeted({ maxToolCalls: 1, onToolCallBudget: 'wrap-up', graceToolCalls: 1 })
    host.ctx.get = ((original) => (name) => (name === 'agents' ? { get: (id) => (id === 'durable-1' ? liveAgent : undefined) } : original(name)))(host.ctx.get)
    await tool(host, { backgroundMode: 'continuable' }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    emitCalls(host, 'durable-1', 2)
    assert.equal(injected.length, 1)
    assert.equal(injected[0].source.kind, 'plugin')
    emitCalls(host, 'durable-1', 1)
    assert.equal(host.calls.interrupts.length, 1, 'the grace call is the last one')
  })

  test('an upstream timeout is never reported as a budget breach', async () => {
    // The core's deadline and the budget are orthogonal guards; the one that
    // fired owns the report, so a timed-out delegation keeps the official
    // cancellation message instead of claiming a budget stop.
    const deadline = new AbortController()
    const host = budgeted({ maxToolCalls: 1, onToolCallBudget: 'interrupt' })
    let settle
    host.ctx.subagents.start = async () => {
      deadline.abort('TOOL_TIMEOUT')
      return { id: 'child-t', result: new Promise((resolve) => { settle = resolve }), dispose: async () => {} }
    }
    const pending = tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec({ signal: deadline.signal }))
    await armed(host, 'the child to be tracked')
    emitCalls(host, 'child-t', 3)
    settle({ stopReason: 'aborted', output: [{ type: 'text', text: 'partial' }] })
    await assert.rejects(pending, /subagent run was cancelled/)
  })

  test('a remote child with no local agent degrades wrap-up to a warned stop', async () => {
    const host = budgeted({ maxToolCalls: 1, onToolCallBudget: 'wrap-up', graceToolCalls: 0 })
    let settle
    host.ctx.subagents.start = async () => ({ id: 'child-r', result: new Promise((resolve) => { settle = resolve }), dispose: async () => {} })
    const pending = tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    await armed(host, 'the child to be tracked')
    emitCalls(host, 'child-r', 2)
    assert.match(host.calls.warnings.join('\n'), /wrap-up notice could not be delivered/)
    settle({ stopReason: 'aborted', output: [] })
    assert.equal((await pending).kind, 'budget-exceeded')
  })

  test('an unobservable (remote) child is announced, not left silently unguarded', async () => {
    // A remote run publishes no local child, so its Session events never reach
    // this process. Arming a record that can never fire while staying quiet is
    // the exact "looks enforced, is not" failure this feature exists to remove.
    const host = budgeted({ maxToolCalls: 5, onToolCallBudget: 'interrupt' })
    host.ctx.subagents.start = async () => ({
      id: 'remote-child',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }),
      dispose: async () => {},
    })
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.match(host.calls.warnings.join('\n'), /declares a tool-call budget of 5, but transport "spawn" publishes no local child agent/)
  })

  test('an observable child is not warned about', async () => {
    const localAgent = { id: 'child-1', inject: () => {} }
    const host = budgeted({ maxToolCalls: 5, onToolCallBudget: 'interrupt' })
    host.ctx.subagents.start = async () => ({ id: 'child-1', localAgent, result: new Promise(() => {}), dispose: async () => {} })
    void tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    await armed(host)
    assert.doesNotMatch(host.calls.warnings.join('\n'), /publishes no local child agent/)
  })

  test('an interrupted child still gets the durable notice, so the stop is replayable', async () => {
    // Spec: the same fact goes into the child Session. A host log line alone cannot
    // answer "where did it stop, and how much was left" for an interrupted child.
    const injected = []
    const localAgent = { id: 'child-i', inject: (message) => injected.push(message) }
    const host = budgeted({ maxToolCalls: 1, onToolCallBudget: 'interrupt' })
    let settle
    host.ctx.subagents.start = async () => ({ id: 'child-i', localAgent, result: new Promise((resolve) => { settle = resolve }), dispose: async () => {} })
    const pending = tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    await armed(host)
    emitCalls(host, 'child-i', 2)
    assert.equal(injected.length, 1)
    assert.equal(injected[0].source.kind, 'plugin')
    assert.match(injected[0].content[0].text, /2 of 1 tool calls/)
    settle({ stopReason: 'aborted', output: [] })
    assert.equal((await pending).kind, 'budget-exceeded')
  })

  test('a budget-first stop still wins while a timeout is configured', async () => {
    // Spec 8.6 asks for both orders; only the timeout-first order was covered. The
    // deadline here never fires, so the budget result must reach the delegating
    // agent untouched.
    const host = budgeted({ maxToolCalls: 1, onToolCallBudget: 'interrupt' })
    let settle
    host.ctx.subagents.start = async () => ({ id: 'child-to', result: new Promise((resolve) => { settle = resolve }), dispose: async () => {} })
    const pending = tool(host, { timeoutMs: 60000 }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    await armed(host)
    emitCalls(host, 'child-to', 2)
    settle({ stopReason: 'aborted', output: [{ type: 'text', text: 'partial' }] })
    const value = await pending
    assert.equal(value.reason, 'tool-call-budget')
    assert.equal(tool(host, { timeoutMs: 60000 }).timeoutMs, 60000, 'the deadline is still declared on the tool')
  })

  test('a session-scoped continuable child is stopped again on its next wake', async () => {
    // Regression: the reported latch used to double as the enforcement latch, so
    // only the first wake of a `session`-scoped child was ever stopped.
    const host = budgeted({ maxToolCalls: 1, maxToolCallsScope: 'session', onToolCallBudget: 'interrupt' })
    await tool(host, { backgroundMode: 'continuable' }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    emitCalls(host, 'durable-1', 2, 1)
    assert.equal(host.calls.interrupts.length, 1)
    emit(host, 'durable-1', { type: 'turn/start', data: { turn: 2 } })
    emitCalls(host, 'durable-1', 1, 2)
    assert.equal(host.calls.interrupts.length, 2, 'the over-budget child is stopped on the wake too')
  })

  test('disposing a child session releases its record instead of leaving it to evict a live one', async () => {
    const host = budgeted({ maxToolCalls: 2, onToolCallBudget: 'interrupt' })
    await tool(host, { backgroundMode: 'continuable' }).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    assert.equal(host.budgetMonitor.size, 1)
    emitDisposed(host, 'durable-1')
    assert.equal(host.budgetMonitor.size, 0)
  })

  test('an unlimited role leaves the run signal untouched', async () => {
    const host = fakeHost()
    let runSignal
    host.ctx.subagents.start = async (providerName, request) => {
      runSignal = request.signal
      return run()
    }
    const execution = exec()
    await tool(host).execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, execution)
    assert.equal(runSignal, execution.signal, 'an unbudgeted delegation keeps the caller signal verbatim')
  })

  test('the row default budgets a role that declares none', async () => {
    const host = fakeHost()
    let runSignal
    host.ctx.subagents.start = async (providerName, request) => {
      runSignal = request.signal
      return { id: 'child-d', result: new Promise(() => {}), dispose: async () => {} }
    }
    const pending = tool(host, { defaultMaxToolCalls: 1, onToolCallBudget: 'interrupt' })
      .execute({ role: 'web-verifier', prompt: 'x', description: 'd' }, exec())
    await armed(host, 'the child to be tracked')
    emitCalls(host, 'child-d', 2)
    assert.equal(runSignal.aborted, true)
    void pending
  })

  test('the diagnostic tool reports each budget and its provenance', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, maxToolCalls: 30 }] })
    const text = await createRoleListTool({ ctx: host.ctx, config: new Config({}), loader: host.loader }).execute({}, exec())
    assert.match(text, /tool-call budget: 30 \(role, scope delegation, mode wrap-up, grace 1\)/)
  })

  test('the diagnostic tool distinguishes a row default from unlimited', async () => {
    const withDefault = await createRoleListTool({
      ctx: fakeHost().ctx,
      config: new Config({ defaultMaxToolCalls: 15 }),
      loader: fakeHost().loader,
    }).execute({}, exec())
    assert.match(withDefault, /tool-call budget: 15 \(row-default, scope delegation, mode wrap-up, grace 1\)/)

    const unlimited = await createRoleListTool({
      ctx: fakeHost().ctx,
      config: new Config({}),
      loader: fakeHost().loader,
    }).execute({}, exec())
    assert.match(unlimited, /tool-call budget: unlimited/)
  })

  test('the diagnostic tool marks a hard-cap-clamped role budget and says why', async () => {
    const host = fakeHost({ roles: [{ ...ROLE, maxToolCalls: 999 }] })
    const text = await createRoleListTool({ ctx: host.ctx, config: new Config({ maxToolCallsHardCap: 40 }), loader: host.loader }).execute({}, exec())
    assert.match(text, /tool-call budget: 40 \(role, scope delegation, mode wrap-up, grace 1\)/)
    // A clamped number shown silently would hide why it is not the declared one.
    assert.match(text, /warning: role "web-verifier" asked for maxToolCalls 999/)
  })
})
