import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  createRoleLoader,
  findUnsupportedPersonaVariable,
  normalizeRoleToolFilter,
  parseRoleDocument,
  splitRoleDocument,
} from '../lib/roles.js'

const roots = []
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-roles-'))
  roots.push(dir)
  return dir
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('frontmatter splitting', () => {
  test('splits frontmatter and keeps the body', () => {
    const { frontmatter, body } = splitRoleDocument('---\ndescription: hi\n---\nBODY\nline2\n')
    assert.equal(frontmatter, 'description: hi')
    assert.equal(body, 'BODY\nline2\n')
  })

  test('no frontmatter means the whole text is the body', () => {
    const { frontmatter, body } = splitRoleDocument('just a persona')
    assert.equal(frontmatter, undefined)
    assert.equal(body, 'just a persona')
  })

  test('an unterminated block is treated as body', () => {
    const { frontmatter, body } = splitRoleDocument('---\ndescription: hi\n')
    assert.equal(frontmatter, undefined)
    assert.equal(body, '---\ndescription: hi\n')
  })
})

describe('persona variables', () => {
  test('accepts the registered variables', () => {
    assert.equal(findUnsupportedPersonaVariable('cwd {{cwd}} model {{model}} p {{provider}}'), undefined)
  })

  test('a lone open brace is literal prose', () => {
    assert.equal(findUnsupportedPersonaVariable('see {{ not closed'), undefined)
  })

  test('rejects an unregistered variable', () => {
    assert.equal(findUnsupportedPersonaVariable('hello {{user}}'), 'user')
  })

  test('matches the core exactly: no trimming, lowercase names only', () => {
    // The core interpolates section text AFTER the provider returns, so a
    // reference this check waves through becomes a thrown error per turn.
    assert.equal(findUnsupportedPersonaVariable('见 {{cwd }}'), 'cwd ')
    assert.equal(findUnsupportedPersonaVariable('见 {{ cwd}}'), ' cwd')
    assert.equal(findUnsupportedPersonaVariable('见 {{CWD}}'), 'CWD')
    assert.equal(findUnsupportedPersonaVariable('见 {{a{b}}'), 'a{b')
  })
})

describe('tool policy normalization', () => {
  test('tools shorthand becomes an allow list', () => {
    assert.deepEqual(normalizeRoleToolFilter({ tools: ['bash', 'read'] }), { filter: { allow: ['bash', 'read'] } })
  })

  test('an explicit empty allow list is preserved (hide every inherited tool)', () => {
    assert.deepEqual(normalizeRoleToolFilter({ tools: [] }), { filter: { allow: [] } })
    assert.deepEqual(normalizeRoleToolFilter({ toolFilter: { allow: [] } }), { filter: { allow: [] } })
    // The dangerous case: dropping the empty allow would leave deny-only, which
    // hands the child every other tool.
    assert.deepEqual(normalizeRoleToolFilter({ toolFilter: { allow: [], deny: ['write'] } }), {
      filter: { allow: [], deny: ['write'] },
    })
  })

  test('an empty toolFilter declaration is still refused', () => {
    assert.match(normalizeRoleToolFilter({ toolFilter: {} }).error, /no usable entries/)
    assert.match(normalizeRoleToolFilter({ toolFilter: { deny: [] } }).error, /no usable entries/)
  })

  test('deny-only filters are kept and empty deny is dropped', () => {
    assert.deepEqual(normalizeRoleToolFilter({ toolFilter: { deny: ['write'] } }), { filter: { deny: ['write'] } })
    assert.deepEqual(normalizeRoleToolFilter({ toolFilter: { allow: ['read'], deny: [] } }), { filter: { allow: ['read'] } })
  })

  test('declare either tools or toolFilter, not both', () => {
    assert.match(normalizeRoleToolFilter({ tools: ['read'], toolFilter: { deny: ['write'] } }).error, /not both/)
  })
})

describe('role documents', () => {
  const valid = [
    '---',
    'displayName: 浏览器操作员',
    'description: 浏览器调试与验证',
    'whenToUse: E2E',
    'provider: deepseek-official',
    'model: deepseek-v4-flash',
    'reasoningEffort: low',
    'tools: [bash, read, "mcp__demo__*"]',
    '---',
    '你是操作员。',
    '第二行。',
  ].join('\n')

  test('parses a complete role', () => {
    const { role, error } = parseRoleDocument('web-operator', valid)
    assert.equal(error, undefined)
    assert.equal(role.id, 'web-operator')
    assert.equal(role.displayName, '浏览器操作员')
    assert.equal(role.description, '浏览器调试与验证')
    assert.equal(role.whenToUse, 'E2E')
    assert.equal(role.provider, 'deepseek-official')
    assert.equal(role.model, 'deepseek-v4-flash')
    assert.equal(role.reasoningEffort, 'low')
    assert.deepEqual(role.toolFilter, { allow: ['bash', 'read', 'mcp__demo__*'] })
    assert.equal(role.persona, '你是操作员。\n第二行。')
  })

  test('displayName defaults to the id', () => {
    const { role } = parseRoleDocument('worker', '---\ndescription: d\n---\npersona')
    assert.equal(role.displayName, 'worker')
  })

  test('requires a description', () => {
    assert.match(parseRoleDocument('worker', '---\nmodel: deepseek-flash\n---\np').error, /`description` is required/)
  })

  test('rejects a non-kebab id', () => {
    assert.match(parseRoleDocument('Web_Operator', '---\ndescription: d\n---\np').error, /not kebab-case/)
  })

  test('rejects a mismatched name field', () => {
    assert.match(parseRoleDocument('worker', '---\nname: other\ndescription: d\n---\np').error, /must equal the file id/)
  })

  test('rejects an unregistered persona variable', () => {
    assert.match(parseRoleDocument('worker', '---\ndescription: d\n---\nx {{secret}}').error, /only \{\{cwd\}\}/)
  })

  test('rejects an oversized persona body', () => {
    const big = 'x'.repeat(64)
    assert.match(parseRoleDocument('worker', `---\ndescription: d\n---\n${big}`, { maxBodyBytes: 10 }).error, /over the 10-byte limit/)
  })

  test('a role without a persona is still usable', () => {
    const { role, error } = parseRoleDocument('worker', '---\ndescription: d\n---\n')
    assert.equal(error, undefined)
    assert.equal(role.persona, undefined)
  })

  test('catalog fields must not carry {{ (the core interpolates them)', () => {
    // Unknown name → the turn would throw; registered name → silent leak.
    assert.match(parseRoleDocument('worker', '---\ndescription: 编辑 Vue 模板 {{ item.name }}\n---\np').error, /must not contain/)
    assert.match(parseRoleDocument('worker', '---\ndescription: uses {{cwd}}\n---\np').error, /must not contain/)
    assert.match(parseRoleDocument('worker', '---\ndescription: d\ndisplayName: "{{x}}"\n---\np').error, /must not contain/)
    assert.match(parseRoleDocument('worker', '---\ndescription: d\nwhenToUse: "a {{b}}"\n---\np').error, /must not contain/)
  })

  test('unknown frontmatter keys are refused (a typo must not silently widen tools)', () => {
    assert.match(parseRoleDocument('worker', '---\ndescription: d\ntoolfilter:\n  allow: [read]\n---\np').error, /unknown frontmatter key `toolfilter`/)
    assert.match(parseRoleDocument('worker', '---\ndescription: d\nowner: troy\n---\np').error, /unknown frontmatter key `owner`/)
  })

  test('provider and model must be declared together', () => {
    assert.match(parseRoleDocument('worker', '---\ndescription: d\nprovider: p\n---\np').error, /must be set together/)
    assert.match(parseRoleDocument('worker', '---\ndescription: d\nmodel: m\n---\np').error, /must be set together/)
    const ok = parseRoleDocument('worker', '---\ndescription: d\nprovider: p\nmodel: m\nreasoningEffort: low\n---\np')
    assert.equal(ok.error, undefined)
    assert.deepEqual([ok.role.provider, ok.role.model, ok.role.reasoningEffort], ['p', 'm', 'low'])
  })

  test('empty frontmatter values are rejected', () => {
    assert.match(parseRoleDocument('worker', '---\ndescription: "  "\n---\np').error, /`description` is required/)
  })
})

describe('role loader', () => {
  function fixture() {
    const project = sandbox()
    const home = sandbox()
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(join(project, '.dsh', 'roles'), { recursive: true })
    mkdirSync(join(project, 'sub', 'deep'), { recursive: true })
    mkdirSync(join(home, 'roles'), { recursive: true })
    return { project, home, cwd: join(project, 'sub', 'deep') }
  }

  test('project roles are found from a nested cwd and win over global ones', () => {
    const { project, home, cwd } = fixture()
    writeFileSync(join(home, 'roles', 'shared.md'), '---\ndescription: global variant\n---\nglobal body')
    writeFileSync(join(home, 'roles', 'only-global.md'), '---\ndescription: global only\n---\nbody')
    writeFileSync(join(project, '.dsh', 'roles', 'shared.md'), '---\ndescription: project variant\n---\nproject body')
    const loader = createRoleLoader({ dshHome: home })
    const { roles, diagnostics } = loader.loadSync(cwd)
    assert.deepEqual(roles.map((role) => role.id), ['shared', 'only-global'])
    assert.equal(roles[0].description, 'project variant')
    assert.equal(roles[0].source, 'project')
    assert.equal(roles[1].source, 'global')
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].reason, /shadowed/)
  })

  test('without a project marker the cwd itself is the project root', () => {
    const project = sandbox()
    const cwd = join(project, 'work')
    mkdirSync(join(cwd, '.dsh', 'roles'), { recursive: true })
    writeFileSync(join(cwd, '.dsh', 'roles', 'local.md'), '---\ndescription: local\n---\nbody')
    const loader = createRoleLoader({ dshHome: sandbox() })
    assert.equal(loader.projectRootFor(cwd), cwd)
    assert.deepEqual(loader.loadSync(cwd).roles.map((role) => role.id), ['local'])
  })

  test('a malformed file is skipped with a diagnostic, never thrown', () => {
    const { project, home, cwd } = fixture()
    writeFileSync(join(project, '.dsh', 'roles', 'good.md'), '---\ndescription: ok\n---\nbody')
    writeFileSync(join(project, '.dsh', 'roles', 'bad.md'), '---\nmodel: x\n---\nbody')
    writeFileSync(join(project, '.dsh', 'roles', 'Bad-Id.md'), '---\ndescription: x\n---\nbody')
    writeFileSync(join(project, '.dsh', 'roles', 'README.txt'), 'ignored')
    const loader = createRoleLoader({ dshHome: home })
    const { roles, diagnostics } = loader.loadSync(cwd)
    assert.deepEqual(roles.map((role) => role.id), ['good'])
    assert.equal(diagnostics.length, 2)
  })

  test('missing roots are silent', () => {
    const project = sandbox()
    const loader = createRoleLoader({ dshHome: join(project, 'nope') })
    const { roles, diagnostics } = loader.loadSync(join(project, 'nope', 'deeper'))
    assert.deepEqual(roles, [])
    assert.deepEqual(diagnostics, [])
  })

  test('the mtime cache returns the same role object until the file changes', () => {
    const { project, home, cwd } = fixture()
    const path = join(project, '.dsh', 'roles', 'cached.md')
    writeFileSync(path, '---\ndescription: first\n---\nbody')
    const loader = createRoleLoader({ dshHome: home })
    const first = loader.loadSync(cwd).roles[0]
    const second = loader.loadSync(cwd).roles[0]
    assert.equal(first, second)
    writeFileSync(path, '---\ndescription: second\n---\nbody')
    const third = loader.loadSync(cwd).roles[0]
    assert.equal(third.description, 'second')
  })

  test('a session without a cwd still reads global roles', () => {
    const home = sandbox()
    mkdirSync(join(home, 'roles'), { recursive: true })
    writeFileSync(join(home, 'roles', 'global.md'), '---\ndescription: g\n---\nb')
    const loader = createRoleLoader({ dshHome: home })
    assert.deepEqual(loader.loadSync(undefined).roles.map((role) => role.id), ['global'])
  })

  test('a symlinked role file is discovered', () => {
    const { project, home, cwd } = fixture()
    const real = join(project, 'real-role.md')
    writeFileSync(real, '---\ndescription: linked\n---\nbody')
    symlinkSync(real, join(project, '.dsh', 'roles', 'linked.md'))
    const loader = createRoleLoader({ dshHome: home })
    assert.deepEqual(loader.loadSync(cwd).roles.map((role) => role.id), ['linked'])
  })

  test('a fixed role file is picked up even when its mtime is unchanged', () => {
    const { project, home, cwd } = fixture()
    const path = join(project, '.dsh', 'roles', 'flaky.md')
    writeFileSync(path, '---\nmodel: m\n---\nbody')
    const loader = createRoleLoader({ dshHome: home })
    assert.equal(loader.loadSync(cwd).roles.length, 0)
    const before = statSync(path)
    writeFileSync(path, '---\ndescription: fixed\n---\nbody')
    // Force the exact same mtime and size class: a failure cache would hide the fix.
    utimesSync(path, before.atime, before.mtime)
    assert.deepEqual(loader.loadSync(cwd).roles.map((role) => role.id), ['flaky'])
  })

  test('adding a file invalidates the directory listing cache', () => {
    const { project, home, cwd } = fixture()
    const loader = createRoleLoader({ dshHome: home })
    assert.equal(loader.loadSync(cwd).roles.length, 0)
    writeFileSync(join(project, '.dsh', 'roles', 'late.md'), '---\ndescription: late\n---\nbody')
    assert.deepEqual(loader.loadSync(cwd).roles.map((role) => role.id), ['late'])
  })

  test('a project root that appears later is noticed after the cache TTL', () => {
    const project = sandbox()
    const cwd = join(project, 'work')
    mkdirSync(join(cwd, '.dsh', 'roles'), { recursive: true })
    const loader = createRoleLoader({ dshHome: sandbox(), projectRootTtlMs: 0 })
    assert.equal(loader.projectRootFor(cwd), cwd)
    mkdirSync(join(project, '.git'), { recursive: true })
    assert.equal(loader.projectRootFor(cwd), project)
  })

  test('a project root whose .dsh IS the harness home is not scanned twice', () => {
    // Collision case: project root = parent of $DSH_HOME (e.g. cwd = ~ with a
    // ~/.git), so <root>/.dsh/roles === <dshHome>/roles.
    const parent = sandbox()
    const home = join(parent, '.dsh')
    mkdirSync(join(home, 'roles'), { recursive: true })
    mkdirSync(join(parent, '.git'), { recursive: true })
    writeFileSync(join(home, 'roles', 'shared.md'), '---\ndescription: g\n---\nb')
    const loader = createRoleLoader({ dshHome: home })
    const { roles, diagnostics, roots } = loader.loadSync(parent)
    assert.deepEqual(roles.map((role) => role.id), ['shared'])
    assert.equal(roots.length, 1)
    assert.deepEqual(diagnostics, [])
  })

  test('per-step diagnostics are reported once with freshDiagnostics', () => {
    const { project, home, cwd } = fixture()
    writeFileSync(join(project, '.dsh', 'roles', 'bad.md'), '---\nmodel: x\n---\nbody')
    const loader = createRoleLoader({ dshHome: home })
    assert.equal(loader.loadSync(cwd, { freshDiagnostics: true }).diagnostics.length, 1)
    assert.equal(loader.loadSync(cwd, { freshDiagnostics: true }).diagnostics.length, 0)
    // A full read still sees it, so the diagnostic tool stays accurate.
    assert.equal(loader.loadSync(cwd).diagnostics.length, 1)
  })

  test('the persona limit counts UTF-8 bytes, not code units', () => {
    const body = '中'.repeat(20)
    const { error } = parseRoleDocument('worker', `---\ndescription: d\n---\n${body}`, { maxBodyBytes: 30 })
    assert.match(error, /60 bytes, over the 30-byte limit/)
  })
})
