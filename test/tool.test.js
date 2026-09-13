/**
 * Tool-level decisions that must match the official delegation tool's matrix:
 * the background flag, and which capabilities a resolved feature demands.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { assertDelegationCapabilities, resolveDelegationMode } from '../lib/tool.js'

describe('delegation mode', () => {
  test('one-shot waits by default and backgrounds only when asked', () => {
    assert.deepEqual(resolveDelegationMode({}, { backgroundEnabled: true, continuable: false }), { runInBackground: false, route: 'foreground' })
    assert.deepEqual(resolveDelegationMode({ run_in_background: false }, { backgroundEnabled: true, continuable: false }), { runInBackground: false, route: 'foreground' })
    assert.deepEqual(resolveDelegationMode({ run_in_background: true }, { backgroundEnabled: true, continuable: false }), { runInBackground: true, route: 'background' })
  })

  test('continuable backgrounds by default and an explicit false waits', () => {
    assert.deepEqual(resolveDelegationMode({}, { backgroundEnabled: true, continuable: true }), { runInBackground: true, route: 'continuable' })
    assert.deepEqual(resolveDelegationMode({ run_in_background: true }, { backgroundEnabled: true, continuable: true }), { runInBackground: true, route: 'continuable' })
    assert.deepEqual(resolveDelegationMode({ run_in_background: false }, { backgroundEnabled: true, continuable: true }), { runInBackground: false, route: 'foreground' })
  })

  test('a row that disables background never runs in the background', () => {
    assert.deepEqual(resolveDelegationMode({}, { backgroundEnabled: false, continuable: true }), { runInBackground: false, route: 'foreground' })
    assert.throws(
      () => resolveDelegationMode({ run_in_background: true }, { backgroundEnabled: false, continuable: false }),
      /run_in_background is disabled/,
    )
  })
})

describe('capability gate', () => {
  const full = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

  test('passes when the provider supports everything requested', () => {
    assert.doesNotThrow(() => assertDelegationCapabilities({
      providerName: 'spawn',
      persona: 'p',
      toolFilter: { allow: ['read'] },
      agentOptions: { provider: 'x', model: 'y' },
      capabilities: full,
      maxDepth: 2,
    }))
  })

  test('a missing capability names the feature and the provider', () => {
    const cases = [
      [{ persona: 'p' }, { ...full, persona: false }, /persona/],
      [{ toolFilter: { allow: [] } }, { ...full, toolFilter: false }, /toolFilter/],
      [{ agentOptions: { provider: 'x', model: 'y' } }, { ...full, agentOptions: false }, /agentOptions/],
      [{ maxDepth: 1 }, { ...full, depthLimit: false }, /maxDepth/],
    ]
    for (const [extra, capabilities, pattern] of cases) {
      assert.throws(
        () => assertDelegationCapabilities({ providerName: 'fork', capabilities, ...extra }),
        pattern,
      )
    }
  })

  test('nothing requested means nothing to check', () => {
    assert.doesNotThrow(() => assertDelegationCapabilities({ providerName: 'spawn', capabilities: {} }))
  })
})
