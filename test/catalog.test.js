import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { catalogDescription, renderRoleCatalog } from '../lib/catalog.js'

const roles = [
  { id: 'web-operator', displayName: '浏览器操作员', description: '浏览器/Web 端调试与验证执行者' },
  { id: 'plain', displayName: 'plain', description: 'no display name branch' },
]

describe('catalog rendering', () => {
  test('renders one framing line plus one line per role', () => {
    const text = renderRoleCatalog(roles)
    const lines = text.split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0], /subagent_role/)
    assert.match(lines[1], /^- `web-operator` \(浏览器操作员\): 浏览器/)
    assert.match(lines[2], /^- `plain`: no display name branch$/)
  })

  test('does not leak persona text', () => {
    const withPersona = [{ ...roles[0], persona: 'SECRET PERSONA' }]
    assert.equal(renderRoleCatalog(withPersona).includes('SECRET'), false)
  })

  test('an empty catalog renders nothing at all', () => {
    assert.equal(renderRoleCatalog([]), '')
    assert.equal(renderRoleCatalog(undefined), '')
  })

  test('caps descriptions and appends whenToUse', () => {
    const text = renderRoleCatalog([{ id: 'r', displayName: 'r', description: 'x'.repeat(500), whenToUse: 'use me' }], { descriptionMaxLength: 20 })
    assert.match(text, /x{17}\.\.\. use me/)
  })

  test('collapse of whitespace keeps lines single-line', () => {
    assert.equal(catalogDescription('a\n\nb\tc'), 'a b c')
  })

  test('the framing line names the configured tool, not a hard-coded one', () => {
    const text = renderRoleCatalog(roles, { toolName: 'role_delegate' })
    assert.match(text, /Delegate with `role_delegate`/)
    assert.equal(text.includes('`subagent_role`'), false)
  })

  test('the default tool name is used when none is configured', () => {
    assert.match(renderRoleCatalog(roles), /Delegate with `subagent_role`/)
  })

  test('the framing line does not hard-code a global roles path', () => {
    assert.equal(renderRoleCatalog(roles).includes('~/.dsh/roles'), false)
  })

  test('a display name with newlines cannot break the one-line invariant', () => {
    const text = renderRoleCatalog([{ id: 'r', displayName: 'a\nb', description: 'd' }])
    assert.equal(text.split('\n').length, 2)
    assert.match(text, /^- `r` \(a b\): d$/m)
  })
})
