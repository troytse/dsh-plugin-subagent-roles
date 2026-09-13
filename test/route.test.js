import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isRouteAllowed, resolveRoleRoute } from '../lib/route.js'

describe('authorized route list', () => {
  test('an absent or empty list admits everything', () => {
    assert.equal(isRouteAllowed({ provider: 'p', model: 'm' }, undefined), true)
    assert.equal(isRouteAllowed({ provider: 'p', model: 'm' }, []), true)
  })

  test('with a list only an exact pair is admitted', () => {
    const allowed = [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }]
    assert.equal(isRouteAllowed({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, allowed), true)
    assert.equal(isRouteAllowed({ provider: 'deepseek-official', model: 'other' }, allowed), false)
    assert.equal(isRouteAllowed({ provider: 'deepseek-official' }, allowed), false)
  })
})

describe('role route resolution', () => {
  test('a role route passes through when nothing constrains it', () => {
    const result = resolveRoleRoute({
      role: { id: 'r', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
    })
    assert.deepEqual(result.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
    assert.equal(result.layer, 'role')
    assert.deepEqual(result.warnings, [])
  })

  test('a role with no route inherits the parent', () => {
    const result = resolveRoleRoute({ role: { id: 'r' } })
    assert.equal(result.agentOptions, undefined)
    assert.equal(result.layer, 'inherit')
  })

  test('an unauthorized route is dropped with its effort and warns', () => {
    const result = resolveRoleRoute({
      role: { id: 'r', provider: 'local', model: 'Qwen3.6-35B-A3B', reasoningEffort: 'low' },
      allowedRoutes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    })
    assert.equal(result.agentOptions, undefined)
    assert.equal(result.layer, 'inherit')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /not in the authorized model list/)
  })

  test('an authorized role route survives the list', () => {
    const result = resolveRoleRoute({
      role: { id: 'r', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      allowedRoutes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    })
    assert.deepEqual(result.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  test('a partial route cannot be admitted by a list', () => {
    const result = resolveRoleRoute({
      role: { id: 'r', provider: 'deepseek-official' },
      allowedRoutes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    })
    assert.equal(result.agentOptions, undefined)
    assert.equal(result.warnings.length, 1)
  })

  test('a bare reasoningEffort without a route still applies', () => {
    const result = resolveRoleRoute({ role: { id: 'r', reasoningEffort: 'low' } })
    assert.deepEqual(result.agentOptions, { reasoningEffort: 'low' })
    assert.equal(result.layer, 'inherit')
  })
})
