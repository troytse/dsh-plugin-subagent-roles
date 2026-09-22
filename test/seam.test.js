/**
 * Seam test: the budget monitor against the REAL cordis event bus and the REAL
 * Session store.
 *
 * Every unit test in `budget.test.js` calls `observe()` directly, so they cannot
 * see the one assumption the whole guard rests on: that a `session/event`
 * subscription registered with `{ global: true }` actually receives committed
 * events from a CHILD session — a different context than the plugin row's.
 * Cordis filters listeners by context, so getting that wrong would leave the
 * feature silently counting nothing, which is the failure mode this repository
 * already suffered once with a verbal "8 steps" guard.
 *
 * The packages are devDependencies. If they cannot be resolved the suite skips
 * with a reason rather than failing, so a checkout without them still runs.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createToolCallBudgetMonitor } from '../lib/budget.js'

let cordis
let sessionPackage
try {
  cordis = await import('@deepseek-ai/cordis')
  sessionPackage = await import('@deepseek-ai/dsh-session')
} catch {
  cordis = undefined
  sessionPackage = undefined
}

/** A real Context with a real SessionStore, plus a public-API spy on `ctx.on`. */
function realHost() {
  const ctx = new cordis.Context()
  new sessionPackage.SessionStore(ctx)
  const subscriptions = []
  const originalOn = ctx.on.bind(ctx)
  ctx.on = (name, listener, options) => {
    subscriptions.push({ name, options })
    return originalOn(name, listener, options)
  }
  return { ctx, subscriptions }
}

const POLICY = { limit: 2, scope: 'delegation', mode: 'interrupt', grace: 1, source: 'role', warnings: [] }

describe('budget monitor: the real session/event seam', {
  skip: cordis === undefined || sessionPackage === undefined
    ? 'the real @deepseek-ai/cordis / dsh-session packages are not installed'
    : false,
}, () => {
  test('a child session committed to the real store is counted, and only it', () => {
    const { ctx, subscriptions } = realHost()
    const warnings = []
    const monitor = createToolCallBudgetMonitor({ ctx, log: (message) => warnings.push(String(message)) })

    // The context filter would otherwise hide a CHILD session's events from this
    // host-plane row; `global: true` is what makes the observers see them at all.
    assert.deepEqual(subscriptions, [
      { name: 'session/event', options: { global: true } },
      { name: 'session/disposed', options: { global: true } },
    ])

    const childId = sessionPackage.SessionId('seam-child')
    const child = ctx.sessions.create(childId, { meta: { cwd: process.cwd(), origin: 'subagent' } })
    let enforced = 0
    monitor.arm({
      childSessionId: childId,
        roleId: 'explore',
      policy: POLICY,
      enforce: () => { enforced += 1 },
      injectNotice: () => true,
    })

    child.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: {} })
    child.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: {} })
    assert.equal(enforced, 0, 'exactly the limit must not stop the child')
    child.append('tool/call', { turn: 1, step: 2, callId: 'c3', name: 'read', arguments: {} })
    assert.equal(enforced, 1, 'the crossing call must stop the child')
    assert.match(warnings.join('\n'), /role=explore tool-call budget exceeded: used=3 limit=2 scope=delegation mode=interrupt/)

    // A Session this row never started is not governed by it.
    const other = ctx.sessions.create(sessionPackage.SessionId('seam-other'), { meta: { cwd: process.cwd() } })
    other.append('tool/call', { turn: 1, step: 1, callId: 'x', name: 'read', arguments: {} })
    assert.equal(enforced, 1, 'an unrelated session must not be counted')

    monitor.dispose()
  })

  test('a turn boundary from the real store resets a delegation-scoped count', () => {
    const { ctx } = realHost()
    const monitor = createToolCallBudgetMonitor({ ctx, log: () => {} })
    const childId = sessionPackage.SessionId('seam-child-turns')
    const child = ctx.sessions.create(childId, { meta: { cwd: process.cwd(), origin: 'subagent' } })
    let enforced = 0
    monitor.arm({
      childSessionId: childId,
        roleId: 'explore',
      policy: POLICY,
      enforce: () => { enforced += 1 },
      injectNotice: () => true,
    })

    child.append('turn/start', { turn: 1 })
    child.append('tool/call', { turn: 1, step: 1, callId: 'a', name: 'read', arguments: {} })
    child.append('tool/call', { turn: 1, step: 1, callId: 'b', name: 'read', arguments: {} })
    assert.equal(enforced, 0)
    // A wake opens a new turn, which is "one count per background wake".
    child.append('turn/start', { turn: 2 })
    child.append('tool/call', { turn: 2, step: 1, callId: 'c', name: 'read', arguments: {} })
    child.append('tool/call', { turn: 2, step: 1, callId: 'd', name: 'read', arguments: {} })
    assert.equal(enforced, 0, 'the second turn starts a fresh count')
    child.append('tool/call', { turn: 2, step: 1, callId: 'e', name: 'read', arguments: {} })
    assert.equal(enforced, 1)

    monitor.dispose()
  })
})
