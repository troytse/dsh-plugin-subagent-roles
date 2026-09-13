#!/usr/bin/env node
/**
 * One-shot migration: `subagent-director` settings roles -> `.dsh/roles` files.
 *
 * Reads the two operator roles from `$DSH_HOME/settings.yaml` (namespace
 * `subagent-director`), writes them as PROJECT-level role files under
 * `<project>/.dsh/roles/`, removes the now-dead settings namespace (text-level,
 * so comments survive), and drops the marketplace discovery-cache entry for the
 * retired plugin.
 *
 * The two tool whitelists below are the ones this deployment actually needs;
 * review them before running against another project.
 *
 * Run:  node scripts/migrate-roles.mjs --project /path/to/project [--dry-run]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const argv = process.argv.slice(2)
const projectFlag = argv.indexOf('--project')
if (projectFlag < 0 || argv[projectFlag + 1] === undefined) {
  console.error('usage: migrate-roles.mjs --project <project-dir> [--dry-run]')
  process.exit(2)
}
const PROJECT = resolve(argv[projectFlag + 1])
const DRY_RUN = argv.includes('--dry-run')
const DSH_HOME = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const SETTINGS = join(DSH_HOME, 'settings.yaml')
const BACKUP = join(DSH_HOME, 'settings.yaml.bak-before-roles-migration')
const ROLES_DIR = join(PROJECT, '.dsh', 'roles')
const MARKET = join(DSH_HOME, 'profiles', 'web', '.dsh-market', 'discovery-compatibility-v1.json')
const RETIRED = 'dsh-plugin-subagent-director'

const COMMON_TOOLS = ['bash', 'read', 'grep', 'glob', 'read_image', 'todo_write', 'skill']
const WECHAT_TOOLS = [
  'mcp__haymony__wechat_project_info',
  'mcp__haymony__wechat_page_list',
  'mcp__haymony__wechat_open_project',
  'mcp__haymony__wechat_close_project',
  'mcp__haymony__wechat_automation_start',
  'mcp__haymony__wechat_runtime_diagnose',
  'mcp__haymony__wechat_self_test',
  'mcp__haymony__wechat_ready_check',
  'mcp__haymony__wechat_diagnose',
  'mcp__haymony__wechat_build_npm',
  'mcp__haymony__wechat_config_validate',
  'mcp__haymony__wechat_dependency_check',
  'mcp__haymony__wechat_cache_clean',
  'mcp__haymony__wechat_reset_fileutils',
]
const DESCRIPTIONS = {
  'web-operator': '浏览器/Web 端（管理后台、后端服务、网页应用）的调试与验证执行者：浏览器 E2E、前端 dev/build、服务启停与状态、页面/日志/截图验证。这类验证交给本角色执行，主代理不要亲自做。',
  'mp-operator': '微信小程序构建诊断与 UI 验证执行者：DevTools 编译诊断、页面与组件 UI 验证、UI 自动化、运行时探针、截图回报。这类 DevTools 操作交给本角色执行，主代理不要亲自做。',
}
const NOISE_BULLET = /^\s*-\s*系统提示中「Subagent Director roles/

/** Quote one YAML scalar compactly (double-quoted, so CJK and `*` survive). */
const scalar = (value) => JSON.stringify(value)

/** Drop the now-obsolete "ignore the Subagent Director section" bullet. */
function stripRetiredGuidance(persona, roleId) {
  const lines = persona.split('\n')
  const kept = lines.filter((line) => !NOISE_BULLET.test(line))
  const removed = lines.length - kept.length
  if (removed !== 1) throw new Error(`${roleId}: expected exactly 1 obsolete guidance bullet, removed ${removed}`)
  return kept.join('\n').replace(/^\n+|\n+$/g, '')
}

const settingsText = readFileSync(SETTINGS, 'utf8')
const settings = parseYaml(settingsText)
const section = settings?.['subagent-director']
if (section === null || typeof section !== 'object') throw new Error('settings.yaml has no `subagent-director` section; nothing to migrate')
const roles = section.roles ?? {}
const ids = Object.keys(roles).sort()
if (ids.join(',') !== 'mp-operator,web-operator') throw new Error(`unexpected role set in settings: ${ids.join(', ')}`)

if (!DRY_RUN) mkdirSync(ROLES_DIR, { recursive: true })
const written = []
for (const roleId of ['web-operator', 'mp-operator']) {
  const role = roles[roleId]
  const persona = stripRetiredGuidance(role.persona, roleId)
  const tools = [...COMMON_TOOLS, ...(roleId === 'mp-operator' ? WECHAT_TOOLS : [])]
  const frontmatter = [
    '---',
    `displayName: ${scalar(role.displayName)}`,
    `description: ${scalar(DESCRIPTIONS[roleId])}`,
    `provider: ${scalar(role.provider)}`,
    `model: ${scalar(role.model)}`,
    `reasoningEffort: ${scalar(role.reasoningEffort)}`,
    'tools:',
    ...tools.map((tool) => `  - ${scalar(tool)}`),
    '---',
  ]
  const target = join(ROLES_DIR, `${roleId}.md`)
  if (!DRY_RUN) writeFileSync(target, `${frontmatter.join('\n')}\n${persona}\n`, 'utf8')
  written.push(`${target} (${tools.length} tools, persona ${persona.length} chars)`)
}

// --- settings.yaml cleanup -------------------------------------------------
const lines = settingsText.split('\n')
const start = lines.findIndex((line) => line.startsWith('subagent-director:'))
let cleanup
if (start >= 0) {
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].length > 0 && !/^\s/.test(lines[index])) {
      end = index
      break
    }
  }
  lines.splice(start, end - start)
  if (!DRY_RUN) {
    if (!existsSync(BACKUP)) copyFileSync(SETTINGS, BACKUP)
    writeFileSync(SETTINGS, lines.join('\n'), 'utf8')
  }
  cleanup = `removed \`subagent-director:\` from settings.yaml (backup: ${BACKUP})`
} else {
  cleanup = 'settings.yaml already clean'
}

// --- marketplace discovery cache ------------------------------------------
let marketNote = 'market cache already clean'
if (existsSync(MARKET)) {
  const data = JSON.parse(readFileSync(MARKET, 'utf8'))
  if (data?.entries !== null && typeof data?.entries === 'object' && RETIRED in data.entries) {
    delete data.entries[RETIRED]
    if (!DRY_RUN) writeFileSync(MARKET, JSON.stringify(data), 'utf8')
    marketNote = `dropped \`${RETIRED}\` from ${MARKET}`
  }
}

console.log(DRY_RUN ? 'wrote (dry run — nothing changed):' : 'wrote:')
for (const line of written) console.log(`  ${line}`)
console.log(`${cleanup}${DRY_RUN ? ' (dry run)' : ''}`)
console.log(`${marketNote}${DRY_RUN ? ' (dry run)' : ''}`)
