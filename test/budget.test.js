/**
 * Tool-call budget: role-file parsing, precedence, counting, and the exact
 * threshold rules.
 *
 * The counting rules are the whole contract of this feature — "8 steps" was
 * ambiguous enough that two real roles blew through it silently — so every
 * boundary is pinned here: exactly the limit is not a breach, the crossing call
 * is, parallel calls in one step each count, and a delegation-scoped count is
 * reset only by a `turn/start`.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  TOOL_CALL_BUDGET_REASON,
  TOOL_CALL_BUDGET_STATUS,
  createToolCallBudgetMonitor,
  resolveToolCallBudget,
  toolCallBudgetFailure,
} from '../lib/budget.js'
import { parseRoleDocument } from '../lib/roles.js'

/** A frontmatter block for a minimal valid role. */
function roleFile(frontmatter) {
  return `---\ndescription: d\n${frontmatter}---\npersona\n`
}

/** The parsed role, or a failure if the file was rejected. */
function parsed(frontmatter) {
  const result = parseRoleDocument('worker', roleFile(frontmatter))
  assert.equal(result.error, undefined, `expected a valid role, got: ${result.error}`)
  return result.role
}

/** The rejection message of a role file. */
function rejection(frontmatter) {
  const result = parseRoleDocument('worker', roleFile(frontmatter))
  assert.notEqual(result.error, undefined, 'expected the role file to be rejected')
  return result.error
}

const CHILD = { id: 'child-1' }
const OTHER = { id: 'child-2' }

/** Arm one budgeted delegation and record what the monitor did. */
function harness(policy, hooks = {}) {
  const warnings = []
  const monitor = createToolCallBudgetMonitor({ log: (message) => warnings.push(String(message)) })
  const seen = { enforce: 0, wrapUp: [] }
  const record = monitor.arm({
    childSessionId: hooks.childSessionId ?? CHILD.id,
    roleId: 'explore',
    policy,
    enforce: () => {
      seen.enforce += 1
      if (hooks.enforceThrows === true) throw new Error('enforcement exploded')
    },
    injectNotice: (used) => {
      seen.wrapUp.push(used)
      if (hooks.wrapUpThrows === true) throw new Error('injection exploded')
      return hooks.injectable ?? true
    },
    isTornDown: hooks.isTornDown,
  })
  return { monitor, record, warnings, seen }
}

/**
 * Feed `count` committed tool calls to the monitor.
 *
 * `turn` matters: enforcement is gated per turn, so a call emitted with the wrong
 * turn would look like it belonged to an already-stopped batch.
 */
function feed(monitor, count, session = CHILD, turn = 1) {
  for (let index = 0; index < count; index += 1) {
    monitor.observe(session, { type: 'tool/call', data: { turn, step: index + 1, callId: `c${index}`, name: 'read', arguments: {} } })
  }
}

const poll = (limit, mode, grace = 1, scope = 'delegation') => ({ limit, mode, grace, scope, source: 'role', warnings: [] })

describe('role file: tool-call budget fields', () => {
  test('a positive integer is accepted and carried on the role', () => {
    assert.equal(parsed('maxToolCalls: 30\n').maxToolCalls, 30)
    assert.equal(parsed('graceToolCalls: 0\n').graceToolCalls, 0)
  })

  test('zero is accepted: it is the unlimited sentinel, not a count', () => {
    assert.equal(parsed('maxToolCalls: 0\n').maxToolCalls, 0)
  })

  test('an omitted budget leaves the role without one, so the row default applies', () => {
    assert.equal(parsed('').maxToolCalls, undefined)
  })

  test('the scope and mode enums are carried through', () => {
    const role = parsed('maxToolCalls: 5\nmaxToolCallsScope: session\nonToolCallBudget: interrupt\n')
    assert.equal(role.maxToolCallsScope, 'session')
    assert.equal(role.onToolCallBudget, 'interrupt')
  })

  test('a negative, fractional, or non-numeric count is refused', () => {
    assert.match(rejection('maxToolCalls: -1\n'), /`maxToolCalls` must be an integer >= 0/)
    assert.match(rejection('maxToolCalls: 2.5\n'), /`maxToolCalls` must be an integer >= 0/)
    assert.match(rejection('maxToolCalls: "30"\n'), /`maxToolCalls` must be an integer >= 0/)
    assert.match(rejection('graceToolCalls: -2\n'), /`graceToolCalls` must be an integer >= 0/)
  })

  test('an unknown enum value is refused rather than silently disabling the guard', () => {
    assert.match(rejection('maxToolCallsScope: turn\n'), /`maxToolCallsScope` must be one of delegation, session/)
    assert.match(rejection('onToolCallBudget: wrapup\n'), /`onToolCallBudget` must be one of interrupt, wrap-up, off/)
  })

  test('a misspelled key is still an unknown-key rejection', () => {
    assert.match(rejection('maxToolCall: 30\n'), /unknown frontmatter key `maxToolCall`/)
  })
})

describe('resolving the effective budget', () => {
  test('a role-file value wins over the default, and records its provenance', () => {
    const budget = resolveToolCallBudget({ role: { id: 'r', maxToolCalls: 30 }, defaults: { maxToolCalls: 12 }, hardCap: 0 })
    assert.equal(budget.limit, 30)
    assert.equal(budget.source, 'role')
    assert.deepEqual(budget.warnings, [])
  })

  test('a role without a value falls back to the row/settings default', () => {
    const budget = resolveToolCallBudget({ role: { id: 'r' }, defaults: { maxToolCalls: 12, onToolCallBudget: 'interrupt', graceToolCalls: 3 }, hardCap: 0 })
    assert.equal(budget.limit, 12)
    assert.equal(budget.source, 'row-default')
    assert.equal(budget.mode, 'interrupt')
    assert.equal(budget.grace, 3)
  })

  test('no value anywhere means unlimited', () => {
    const budget = resolveToolCallBudget({ role: { id: 'r' }, defaults: {}, hardCap: 0 })
    assert.equal(budget.limit, 0)
    assert.equal(budget.source, 'unlimited')
  })

  test('a role file cannot exceed the hard cap, and the clamp is reported', () => {
    const budget = resolveToolCallBudget({ role: { id: 'r', maxToolCalls: 999 }, defaults: {}, hardCap: 40 })
    assert.equal(budget.limit, 40)
    assert.equal(budget.warnings.length, 1)
    assert.match(budget.warnings[0], /asked for maxToolCalls 999.*maxToolCallsHardCap 40.*using 40/)
  })

  test('the hard cap never clamps the unlimited sentinel', () => {
    // `0` is "no limit", not the number zero; clamping it would turn the escape
    // hatch into the very number the operator was trying to permit.
    const budget = resolveToolCallBudget({ role: { id: 'r', maxToolCalls: 0 }, defaults: {}, hardCap: 40 })
    assert.equal(budget.limit, 0)
    assert.equal(budget.source, 'unlimited')
    assert.deepEqual(budget.warnings, [])
  })

  test('scope defaults to delegation and mode to wrap-up', () => {
    const budget = resolveToolCallBudget({ role: { id: 'r', maxToolCalls: 5 }, defaults: {}, hardCap: 0 })
    assert.equal(budget.scope, 'delegation')
    assert.equal(budget.mode, 'wrap-up')
    assert.equal(budget.grace, 1)
  })
})

describe('counting: what is one call', () => {
  test('exactly the limit is NOT a breach; the next call is', () => {
    const { monitor, seen } = harness(poll(3, 'interrupt'))
    feed(monitor, 3)
    assert.equal(seen.enforce, 0, 'the limit itself must not breach')
    feed(monitor, 1)
    assert.equal(seen.enforce, 1)
  })

  test('parallel calls inside one step each count', () => {
    const { monitor, seen } = harness(poll(2, 'interrupt'))
    // One step, three calls: "calls", not "rounds".
    monitor.observe(CHILD, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'a', name: 'read', arguments: {} } })
    monitor.observe(CHILD, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'b', name: 'read', arguments: {} } })
    assert.equal(seen.enforce, 0)
    monitor.observe(CHILD, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'read', arguments: {} } })
    assert.equal(seen.enforce, 1)
  })

  test('a tool/result or an unrelated event is not a call', () => {
    const { monitor, seen } = harness(poll(1, 'interrupt'))
    monitor.observe(CHILD, { type: 'tool/result', data: { turn: 1, step: 1 } })
    monitor.observe(CHILD, { type: 'step/start', data: { turn: 1, step: 1 } })
    monitor.observe(CHILD, { type: 'user/message', data: {} })
    assert.equal(seen.enforce, 0)
    feed(monitor, 2)
    assert.equal(seen.enforce, 1)
  })

  test('an event for a session this plugin did not start is ignored', () => {
    const { monitor, seen } = harness(poll(1, 'interrupt'))
    feed(monitor, 5, OTHER)
    assert.equal(seen.enforce, 0)
    feed(monitor, 2, CHILD)
    assert.equal(seen.enforce, 1)
  })

  test('an unlimited role counts and enforces nothing', () => {
    const { monitor, seen } = harness(poll(0, 'interrupt'))
    feed(monitor, 50)
    assert.equal(seen.enforce, 0)
    assert.equal(seen.wrapUp.length, 0)
  })
})

describe('the three postures', () => {
  test('interrupt tells the child AND stops it on the crossing call', () => {
    // The notice is the durable audit record, so it is delivered on every stop —
    // an interrupted child is exactly the case a host log line cannot answer
    // "where did it stop, and how much was left".
    const { monitor, seen } = harness(poll(2, 'interrupt'))
    feed(monitor, 3)
    assert.deepEqual(seen.wrapUp, [3])
    assert.equal(seen.enforce, 1)
  })

  test('wrap-up injects once at the crossing call and tolerates grace calls', () => {
    const { monitor, seen } = harness(poll(2, 'wrap-up', 1))
    feed(monitor, 3)
    assert.deepEqual(seen.wrapUp, [3], 'the notice names the count that crossed the limit')
    assert.equal(seen.enforce, 0, 'the crossing call is tolerated')
    feed(monitor, 1)
    assert.equal(seen.enforce, 1, 'the grace call is the last one')
    feed(monitor, 1)
    assert.equal(seen.enforce, 1, 'enforcement is latched and never repeats')
  })

  test('a larger grace tolerates exactly that many calls', () => {
    const { monitor, seen } = harness(poll(2, 'wrap-up', 2))
    feed(monitor, 3)
    assert.equal(seen.enforce, 0)
    feed(monitor, 1)
    assert.equal(seen.enforce, 0, 'the first grace call passes')
    feed(monitor, 1)
    assert.equal(seen.enforce, 1, 'the second grace call is the last')
  })

  test('grace 0 is exactly interrupt, injecting and stopping on the same call', () => {
    const { monitor, seen } = harness(poll(2, 'wrap-up', 0))
    feed(monitor, 3)
    assert.deepEqual(seen.wrapUp, [3])
    assert.equal(seen.enforce, 1)
  })

  test('off warns once and never stops the child', () => {
    const { monitor, seen, warnings } = harness(poll(1, 'off'))
    feed(monitor, 5)
    assert.equal(seen.enforce, 0)
    assert.equal(warnings.filter((line) => line.includes('mode=off')).length, 1)
  })

  test('the breach log line carries role, used, limit, scope and mode', () => {
    const { monitor, warnings } = harness(poll(2, 'interrupt', 1, 'session'))
    feed(monitor, 3)
    assert.match(warnings.join('\n'), /\[subagent-roles\] role=explore tool-call budget exceeded: used=3 limit=2 scope=session mode=interrupt/)
  })
})

describe('counting scope', () => {
  test('delegation scope restarts the count at each turn boundary', () => {
    const { monitor, seen } = harness(poll(2, 'interrupt', 1, 'delegation'))
    feed(monitor, 2)
    monitor.observe(CHILD, { type: 'turn/start', data: { turn: 2 } })
    feed(monitor, 2)
    assert.equal(seen.enforce, 0, 'the second turn starts a fresh count')
    feed(monitor, 1)
    assert.equal(seen.enforce, 1)
  })

  test('session scope accumulates across turn boundaries', () => {
    const { monitor, seen } = harness(poll(2, 'interrupt', 1, 'session'))
    feed(monitor, 2)
    monitor.observe(CHILD, { type: 'turn/start', data: { turn: 2 } })
    feed(monitor, 1)
    assert.equal(seen.enforce, 1, 'a continuable child keeps one budget for its whole life')
  })

  test('a turn boundary re-arms enforcement, not just the count', () => {
    // Regression: the latch used to survive the reset, so only the FIRST wake of a
    // continuable child could ever be stopped and every later one ran unbounded.
    const { monitor, seen } = harness(poll(1, 'interrupt', 1, 'delegation'))
    feed(monitor, 2)
    assert.equal(seen.enforce, 1)
    monitor.observe(CHILD, { type: 'turn/start', data: { turn: 2 } })
    feed(monitor, 2)
    assert.equal(seen.enforce, 2, 'the next wake is guarded on its own count')
  })

  test('session scope keeps counting and stops the child again on every later wake', () => {
    // Regression: the reported latch used to double as the enforcement latch, so a
    // `session` budget stopped the child once and every later wake ran unbounded.
    const { monitor, record, seen } = harness(poll(1, 'interrupt', 1, 'session'))
    feed(monitor, 2)
    assert.equal(seen.enforce, 1)
    assert.equal(record.usedAtBreach, 2)
    monitor.observe(CHILD, { type: 'turn/start', data: { turn: 2 } })
    feed(monitor, 5, CHILD, 2)
    assert.equal(seen.enforce, 2, 'a new turn means the over-budget child is stopped again')
    assert.equal(record.usedAtBreach, 2, 'the first crossing still owns the reported facts')
  })

  test('a stopped batch cannot re-enforce within the same turn', () => {
    // Once the child is stopped the scheduler appends the calls it skipped, and
    // each of those is a `tool/call` too; re-enforcing on them would just repeat
    // one stop.
    const { monitor, seen } = harness(poll(1, 'interrupt', 1, 'session'))
    feed(monitor, 5)
    assert.equal(seen.enforce, 1)
  })

  test('a turn boundary re-arms the wrap-up notice under delegation scope', () => {
    const { monitor, seen } = harness(poll(1, 'wrap-up', 0))
    feed(monitor, 2)
    assert.deepEqual(seen.wrapUp, [2])
    assert.equal(seen.enforce, 1)
    monitor.observe(CHILD, { type: 'turn/start', data: { turn: 2 } })
    feed(monitor, 2)
    assert.deepEqual(seen.wrapUp, [2, 2], 'each turn may be told once')
    assert.equal(seen.enforce, 2, 'and each turn may be stopped on its own count')
  })
})

describe('robustness', () => {
  test('a delegation already being torn down is not reported as a budget breach', () => {
    // The core's own deadline and the budget are orthogonal guards: whichever
    // fired first owns the report, and mislabelling a timeout as a budget stop
    // would send the delegating agent down the wrong recovery path.
    const { monitor, record, seen } = harness(poll(1, 'interrupt'), { isTornDown: () => true })
    feed(monitor, 3)
    assert.equal(seen.enforce, 0)
    assert.equal(record.breached, false)
  })

  test('a throwing enforcement action never escapes the session commit path', () => {
    const { monitor, warnings } = harness(poll(1, 'interrupt'), { enforceThrows: true })
    assert.doesNotThrow(() => feed(monitor, 2))
    assert.match(warnings.join('\n'), /could not enforce the tool-call budget/)
  })

  test('a throwing injection is reported and the stop still happens', () => {
    const { monitor, seen, warnings } = harness(poll(1, 'wrap-up', 0), { wrapUpThrows: true })
    assert.doesNotThrow(() => feed(monitor, 2))
    assert.match(warnings.join('\n'), /could not inject the wrap-up notice/)
    assert.equal(seen.enforce, 1)
  })

  test('an undeliverable wrap-up notice is announced, not assumed', () => {
    const { monitor, warnings } = harness(poll(1, 'wrap-up', 1), { injectable: false })
    feed(monitor, 2)
    assert.match(warnings.join('\n'), /wrap-up notice could not be delivered/)
  })

  test('release forgets a delegation, so a late event cannot breach it', () => {
    const { monitor, record, seen } = harness(poll(1, 'interrupt'))
    feed(monitor, 2)
    assert.equal(seen.enforce, 1)
    monitor.release(record.childSessionId)
    assert.equal(monitor.size, 0)
    feed(monitor, 3)
    assert.equal(seen.enforce, 1)
  })

  test('the record table is bounded, evicting the oldest delegation', () => {
    const monitor = createToolCallBudgetMonitor({ log: () => {}, maxRecords: 2 })
    for (const id of ['a', 'b', 'c']) {
      monitor.arm({ childSessionId: id, roleId: 'r', policy: poll(1, 'interrupt') })
    }
    assert.equal(monitor.size, 2)
  })
})

describe('the structured failure value', () => {
  const record = {
    roleId: 'explore',
    policy: { limit: 30, scope: 'delegation', mode: 'wrap-up', grace: 1 },
    used: 31,
    usedAtBreach: 31,
  }

  test('carries the status, reason and counters the delegating agent routes on', () => {
    const value = toolCallBudgetFailure(record, '')
    assert.equal(value.kind, 'budget-exceeded')
    assert.equal(value.status, TOOL_CALL_BUDGET_STATUS)
    assert.equal(value.reason, TOOL_CALL_BUDGET_REASON)
    assert.equal(value.role, 'explore')
    assert.equal(value.used, 31)
    assert.equal(value.limit, 30)
    assert.equal(value.scope, 'delegation')
    assert.equal(value.mode, 'wrap-up')
    assert.match(value.note, /used 31 of its 30 tool calls/)
  })

  test('omits partialOutput when the child produced no text', () => {
    assert.equal('partialOutput' in toolCallBudgetFailure(record, ''), false)
    assert.equal('partialOutput' in toolCallBudgetFailure(record, undefined), false)
  })

  test('carries partialOutput when there is some', () => {
    assert.equal(toolCallBudgetFailure(record, 'half an answer').partialOutput, 'half an answer')
  })
})

describe('the hard-cap warning names the real source', () => {
  test('a clamped role declaration blames the role file', () => {
    const budget = resolveToolCallBudget({ role: { id: 'explore', maxToolCalls: 999 }, defaults: {}, hardCap: 40 })
    assert.match(budget.warnings[0], /^role "explore" asked for maxToolCalls 999/)
  })

  test('a clamped row/Settings default does not blame the role', () => {
    // Regression: a role that declared nothing was reported as having asked for
    // the row default it merely inherited.
    const budget = resolveToolCallBudget({ role: { id: 'explore' }, defaults: { maxToolCalls: 50 }, hardCap: 40 })
    assert.match(budget.warnings[0], /^the row\/Settings default asked for maxToolCalls 50/)
    assert.equal(budget.limit, 40)
    assert.equal(budget.source, 'row-default')
  })
})
