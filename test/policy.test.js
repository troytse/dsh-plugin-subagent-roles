import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  dropToolFilterNames,
  expandToolFilter,
  globToRegExp,
  isGlobPattern,
  isUnrestrictableToolName,
  parseUnrestrictableToolNames,
  sumSchemaChars,
} from '../lib/policy.js'

const visible = ['bash', 'read', 'grep', 'glob', 'read_image', 'todo_write', 'skill', 'mcp__demo__alpha', 'mcp__demo__beta']

describe('glob compilation', () => {
  test('recognizes glob entries', () => {
    assert.equal(isGlobPattern('bash'), false)
    assert.equal(isGlobPattern('mcp__demo__*'), true)
    assert.equal(isGlobPattern('read_?mage'), true)
  })

  test('compiles whole-name matchers without regex injection', () => {
    assert.equal(globToRegExp('mcp__demo__*').test('mcp__demo__beta'), true)
    assert.equal(globToRegExp('mcp__demo__*').test('mcp__other__gamma'), false)
    assert.equal(globToRegExp('read_?mage').test('read_image'), true)
    assert.equal(globToRegExp('a.b').test('axb'), false)
  })
})

describe('tool policy expansion', () => {
  test('keeps literal names and expands globs to concrete matches', () => {
    const result = expandToolFilter({ allow: ['bash', 'mcp__demo__*'] }, visible)
    assert.deepEqual(result.filter, {
      allow: ['bash', 'mcp__demo__alpha', 'mcp__demo__beta'],
    })
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.unmatched, [])
  })

  test('drops unavailable literal names with a report by default', () => {
    const result = expandToolFilter({ allow: ['bash', 'nope'] }, visible)
    assert.deepEqual(result.filter, { allow: ['bash'] })
    assert.deepEqual(result.missing, ['nope'])
    assert.deepEqual(result.dropped, ['nope'])
  })

  test('refuses unavailable names in error mode', () => {
    assert.throws(
      () => expandToolFilter({ allow: ['bash', 'nope'] }, visible, { onMissing: 'error' }),
      /unavailable tool "nope"/,
    )
    assert.throws(
      () => expandToolFilter({ allow: ['mcp__nope__*'] }, visible, { onMissing: 'error' }),
      /glob matched nothing/,
    )
  })

  test('an allow list that expands to nothing fails closed', () => {
    const result = expandToolFilter({ allow: ['mcp__other__*'] }, visible)
    assert.deepEqual(result.filter, { allow: [] })
    assert.deepEqual(result.unmatched, ['mcp__other__*'])
  })

  test('deny-only policies keep deny and drop an empty deny', () => {
    assert.deepEqual(expandToolFilter({ deny: ['bash'] }, visible).filter, { deny: ['bash'] })
    assert.equal(expandToolFilter({ deny: ['gone'] }, visible).filter, undefined)
  })

  test('an empty visible set hides everything an allow list asks for', () => {
    const result = expandToolFilter({ allow: ['bash'] }, [])
    assert.deepEqual(result.filter, { allow: [] })
  })
})

describe('schema budget', () => {
  test('sums the named tools only', () => {
    const chars = { bash: 100, read: 50, grep: 25 }
    assert.equal(sumSchemaChars(chars, ['bash', 'read', 'unknown']), 150)
  })
})

describe('unrestrictable names', () => {
  test('run_code is flagged (visible to schemas(), rejected by restrict())', () => {
    assert.equal(isUnrestrictableToolName('run_code'), true)
    assert.equal(isUnrestrictableToolName('read'), false)
  })

  test('parses the core unknown-name complaint', () => {
    const error = new Error('tools.restrict() names unknown global tools "subagent", "list_subagent_models"; known global tools: read, grep')
    assert.deepEqual(parseUnrestrictableToolNames(error), ['subagent', 'list_subagent_models'])
    assert.deepEqual(
      parseUnrestrictableToolNames(new Error('tools.restrict() names unknown global tool "subagent"; known global tools: read')),
      ['subagent'],
    )
  })

  test('parses the reserved-transport complaint', () => {
    const error = new Error('tools.restrict() cannot name reserved PTC mode presentation transport "run_code"; restrict end-capability tools instead')
    assert.deepEqual(parseUnrestrictableToolNames(error), ['run_code'])
  })

  test('unrelated errors yield no names', () => {
    assert.deepEqual(parseUnrestrictableToolNames(new Error('subagent run failed')), [])
    assert.deepEqual(parseUnrestrictableToolNames(undefined), [])
  })

  test('dropping names keeps an explicit allow list even when it empties', () => {
    assert.deepEqual(dropToolFilterNames({ allow: ['read', 'subagent'] }, ['subagent']), { allow: ['read'] })
    assert.deepEqual(dropToolFilterNames({ allow: ['subagent'] }, ['subagent']), { allow: [] })
    assert.deepEqual(dropToolFilterNames({ allow: ['read'], deny: ['write'] }, ['write']), { allow: ['read'] })
    assert.equal(dropToolFilterNames({ deny: ['write'] }, ['write']), undefined)
  })
})
