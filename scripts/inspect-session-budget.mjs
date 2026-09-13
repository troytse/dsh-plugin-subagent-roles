#!/usr/bin/env node
/**
 * Print the sys+tools budget of ONE session log, plus which role plugin owns
 * the delegation tool. Read-only: it decompresses the session log and reports.
 *
 * Usage:
 *   node scripts/inspect-session-budget.mjs <session-dir>
 *   node scripts/inspect-session-budget.mjs --project <project-dir> [--newest]
 *
 * `--project` picks the newest session directory under
 * ~/.dsh/sessions/<slug-of-project-dir>/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

function sessionRootFor(projectDir) {
  const slug = `--${projectDir.replace(/^\/+|\/+$/g, '').replaceAll('/', '-')}--`
  return join(homedir(), '.dsh', 'sessions', slug)
}

function newestSessionDir(root) {
  const entries = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    })
  if (entries.length === 0) throw new Error(`no session directories under ${root}`)
  return entries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

/**
 * Locate the byte ranges of every complete Zstandard frame. Session logs are
 * appended frame by frame, and Node's one-shot decoder only reads the first,
 * so the ranges are scanned here (same frame-header walk the host uses).
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    let complete = true
    for (;;) {
      if (buffer.length - offset < 3) {
        complete = false
        break
      }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      offset += blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < 0) {
        complete = false
        break
      }
      if (lastBlock) break
    }
    if (!complete) break
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/** Session logs are appended as concatenated zstd frames; decode every frame. */
async function readLog(sessionDir) {
  const path = join(sessionDir, 'session.v3.jsonl.zstd')
  const raw = readFileSync(path)
  let text
  if (raw.subarray(0, 4).toString('hex') === '28b52ffd') {
    const frames = scanZstdFrames(raw)
    text = frames.map((frame) => zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString('utf8')).join('')
  } else {
    text = raw.toString('utf8')
  }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function textOf(node) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.type === 'text' && typeof node.text === 'string') return node.text
  for (const value of Object.values(node)) {
    const found = textOf(value)
    if (found !== undefined) return found
  }
  return undefined
}

const argv = process.argv.slice(2)
let sessionDir
const projectFlag = argv.indexOf('--project')
if (projectFlag >= 0) {
  sessionDir = newestSessionDir(sessionRootFor(argv[projectFlag + 1]))
} else if (argv[0] !== undefined) {
  sessionDir = argv[0]
} else {
  console.error('usage: inspect-session-budget.mjs <session-dir> | --project <project-dir>')
  process.exit(2)
}

const events = await readLog(sessionDir)
const header = [...events].reverse().find((event) => event.type === 'request/header')
const system = [...events].reverse().find((event) => event.type === 'system/message')
const descriptor = events.find((event) => event.type === 'subagent/descriptor')
const meta = events.find((event) => event.type === 'session')

console.log(`session      : ${sessionDir}`)
if (meta?.data?.cwd !== undefined) console.log(`cwd          : ${meta.data.cwd}`)
if (descriptor !== undefined) console.log(`subagent     : provider=${descriptor.data.provider} mode=${descriptor.data.mode} label=${JSON.stringify(descriptor.data.label)}`)

const systemText = system === undefined ? undefined : textOf(system.data?.message ?? system.data)
if (systemText !== undefined) {
  console.log(`system prompt: ${systemText.length} chars`)
  const catalog = systemText.includes('Roles come from role files')
  console.log(`role catalog : ${catalog ? 'present (new plugin)' : 'absent'}`)
  if (systemText.includes('Subagent Director roles')) console.log('WARNING      : legacy Subagent Director section still present')
  const grepFlag = argv.indexOf('--grep')
  if (grepFlag >= 0) {
    const needle = argv[grepFlag + 1]
    const at = systemText.indexOf(needle)
    console.log(`contains ${JSON.stringify(needle)}: ${at >= 0 ? 'YES' : 'no'}`)
    if (at >= 0) console.log(`  …${systemText.slice(Math.max(0, at - 60), at + needle.length + 60).replaceAll('\n', ' / ')}…`)
  }
  if (systemText.includes('Check the [exit code: N] marker')) console.log('bash guidance: present')
  if (systemText.includes('Use the read tool — not shell commands like cat')) console.log('read guidance: present')
}

const tools = header?.data?.header?.tools ?? []
const sizes = tools
  .map((tool) => ({ name: tool.name, chars: JSON.stringify(tool).length }))
  .sort((left, right) => right.chars - left.chars)
const total = sizes.reduce((sum, entry) => sum + entry.chars, 0)
console.log(`tools        : ${tools.length} (${total} schema chars)`)
if (argv.includes('--all')) {
  console.log(`  ${sizes.map((entry) => `${entry.name}(${entry.chars})`).join(', ')}`)
}
const role = tools.find((tool) => tool.name === 'subagent_role')
if (role !== undefined) {
  const owner = String(role.description).startsWith('Delegate a self-contained task to a role defined by a role file')
    ? 'subagent-roles (new)'
    : 'subagent-director (old)'
  console.log(`subagent_role: ${JSON.stringify(role).length} chars — owner: ${owner}`)
}
console.log(`close_subagent: ${tools.some((tool) => tool.name === 'close_subagent') ? 'present (old plugin)' : 'absent'}`)
console.log('largest tools:')
for (const entry of sizes.slice(0, 8)) console.log(`  ${String(entry.chars).padStart(6)}  ${entry.name}`)
