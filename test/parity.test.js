/**
 * Contrast test against the OFFICIAL delegation tool.
 *
 * `lib/tool.js` is a deliberate clone of `@deepseek-ai/dsh-tool-subagent` plus
 * role files. A clone drifts, and drift here is silent: it shows up months later
 * as a worse error message or a schema that no longer matches, never as a test
 * failure. So the official tool is mounted on the same kind of stub host and both
 * are driven with the same fake child run — every contract-level output that is
 * MEANT to be identical is asserted identical, and the one deliberate difference
 * (the background render line names this plugin's tool) is pinned explicitly.
 *
 * The official package is a devDependency. If it cannot be resolved the suite
 * skips with a reason rather than failing, so a checkout without it still runs.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Config } from '../lib/config.js'
import { createRoleTool } from '../lib/tool.js'

let official
try {
  official = await import('@deepseek-ai/dsh-tool-subagent')
} catch {
  official = undefined
}

const ROLE = {
  id: 'worker',
  displayName: 'worker',
  description: 'do the work',
  path: '/p/.dsh/roles/worker.md',
  source: 'project',
}
const PARENT_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

/** An agent shaped the way `parentAgentOptionsForDelegation` reads one. */
function parentAgent() {
  return {
    options: { ...PARENT_ROUTE },
    session: { header: { cwd: '/p' }, requestHeader: () => ({ config: { ...PARENT_ROUTE } }) },
  }
}

function providerStub(inheritsParentContext, result) {
  return {
    name: 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext,
    prepareContinuable: () => Promise.resolve({}),
    start: async () => childRun(result),
  }
}

/** A child run that ends with `result`. */
function childRun(result, id = 'run-1') {
  return { id, result: Promise.resolve(result), dispose: async () => {} }
}

/** Mount the OFFICIAL tool on a stub host and return its definition. */
function officialDefinition(options = {}) {
  const provider = providerStub(options.inheritsParentContext === true, options.result)
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on: () => () => {},
    get: () => undefined,
    sessionProjections: { register() {} },
    tools: { register: (definition) => { registered.push(definition); return () => {} }, get: () => undefined },
    subagents: { getProvider: () => provider, start: provider.start },
  }
  official.apply(ctx, { provider: 'spawn' })
  assert.equal(registered.length, 1, 'the official tool did not register exactly one definition')
  return registered[0]
}

/** Mount THIS plugin's tool on the same shape of host. */
function roleDefinition(options = {}) {
  const provider = providerStub(options.inheritsParentContext === true, options.result)
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    tools: { schemas: () => [{ name: 'read' }] },
    subagents: { start: provider.start },
  }
  const loader = { loadSync: () => ({ roles: [ROLE], diagnostics: [] }), projectRootFor: () => '/p' }
  return createRoleTool({ ctx, config: new Config({}), provider, loader })
}

const OFFICIAL_ARGS = { prompt: 'do it', description: 'do it' }
const ROLE_ARGS = { role: 'worker', prompt: 'do it', description: 'do it' }
const toolExec = () => ({ agent: parentAgent(), signal: new AbortController().signal })

/** The message of a rejection, or a failure if the promise resolved. */
async function rejectionMessage(promise) {
  let value
  try {
    value = await promise
  } catch (error) {
    return error.message
  }
  throw new Error(`expected a rejection, but the call resolved with ${JSON.stringify(value)}`)
}

describe('parity with the official delegation tool', {
  skip: official === undefined ? 'the official @deepseek-ai/dsh-tool-subagent is not installed' : false,
}, () => {
  test('the model-facing output schema is identical', () => {
    assert.deepEqual(roleDefinition().output.schema, officialDefinition().output.schema)
  })

  test('foreground output renders identically', () => {
    const value = { kind: 'foreground', runId: 'r', output: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }
    assert.deepEqual(
      roleDefinition().output.render(OFFICIAL_ARGS, value),
      officialDefinition().output.render(OFFICIAL_ARGS, value),
    )
  })

  test('continuable output renders identically', () => {
    const value = { kind: 'continuable', subagentId: 's1' }
    assert.deepEqual(
      roleDefinition().output.render(OFFICIAL_ARGS, value),
      officialDefinition().output.render(OFFICIAL_ARGS, value),
    )
  })

  test('the background line is the ONE deliberate divergence, and it is pinned', () => {
    const value = { kind: 'background', jobId: 'j1' }
    const ours = roleDefinition().output.render(OFFICIAL_ARGS, value)[0].text
    const theirs = officialDefinition().output.render(OFFICIAL_ARGS, value)[0].text
    assert.equal(ours, 'started background subagent_role task j1')
    assert.equal(theirs, 'started background subagent job j1')
  })

  test('every non-completed stop reason yields the identical message', async () => {
    const cases = ['aborted', 'error', 'max-tokens', 'refusal', 'something-new']
    for (const stopReason of cases) {
      const result = {
        stopReason,
        diagnostic: 'adapter said no',
        output: [{ type: 'text', text: 'partial answer' }],
      }
      const ours = await rejectionMessage(roleDefinition({ result }).execute(ROLE_ARGS, toolExec()))
      const theirs = await rejectionMessage(officialDefinition({ result }).execute(OFFICIAL_ARGS, toolExec()))
      assert.equal(ours, theirs, `stop reason "${stopReason}" diverged from the official tool`)
    }
  })

  test('a fresh transport produces the identical prompt parameter description', () => {
    assert.equal(
      roleDefinition().parameters.properties.prompt.description,
      officialDefinition().parameters.properties.prompt.description,
    )
  })

  test('a fork transport produces the identical prompt parameter description', () => {
    assert.equal(
      roleDefinition({ inheritsParentContext: true }).parameters.properties.prompt.description,
      officialDefinition({ inheritsParentContext: true }).parameters.properties.prompt.description,
    )
    // …and it really is the fork wording, not the same string twice.
    assert.match(roleDefinition({ inheritsParentContext: true }).parameters.properties.prompt.description, /already sees this conversation/)
  })

  test('run_in_background is advertised identically for a one-shot row', () => {
    const ours = roleDefinition().parameters.properties.run_in_background
    const theirs = officialDefinition().parameters.properties.run_in_background
    assert.deepEqual(ours, theirs)
  })

  test('both declare the same concurrency safety and no tool-level timeout', () => {
    assert.equal(roleDefinition().isConcurrencySafe(), officialDefinition().isConcurrencySafe())
    assert.equal(roleDefinition().timeoutMs, undefined)
    assert.equal(officialDefinition().timeoutMs, undefined)
  })
})
