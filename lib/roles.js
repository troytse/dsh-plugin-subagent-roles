/**
 * Role discovery: two roots, one file form.
 *
 *   <projectRoot>/.dsh/roles/<id>.md   project roles (win on id collision)
 *   ~/.dsh/roles/<id>.md               global roles
 *
 * `<projectRoot>` is the nearest ancestor of the session cwd carrying a
 * project-root marker (`.git` by default); without one the cwd itself is the
 * project root.
 *
 * Discovery is SYNCHRONOUS on purpose: the system-prompt section provider that
 * renders the role catalog is called synchronously during assembly, so the
 * catalog path cannot await filesystem work. Results are cached per absolute
 * path and invalidated by `mtimeMs`, so a step re-reads only files that
 * changed. Nothing here throws: a malformed file becomes a diagnostic and is
 * skipped, because throwing inside prompt assembly would fail every turn.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Role-id grammar; also the file-stem grammar. */
const ROLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Project-relative role directory (the only one). */
const PROJECT_ROLE_DIR = ['.dsh', 'roles']
/** Prompt variables a role persona may reference (strict interpolation). */
const PERSONA_VARIABLES = ['cwd', 'model', 'provider']
/** Frontmatter keys this format accepts; anything else is a typo. */
const ROLE_FRONTMATTER_KEYS = [
  'name',
  'displayName',
  'description',
  'whenToUse',
  'provider',
  'model',
  'reasoningEffort',
  'tools',
  'toolFilter',
]
/**
 * The core's own rules, copied verbatim from `@deepseek-ai/dsh-system-prompt`
 * (`VARIABLE_NAME` / `GROUP_AT`): variable names are lowercase and the
 * reference must be one complete simple group — no trimming, no whitespace.
 */
const CORE_VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
const CORE_GROUP_AT = /^\{\{([^{}]*)\}\}/
const DEFAULT_MAX_BODY_BYTES = 65536
/** How long a resolved project root is trusted before re-walking the tree. */
const PROJECT_ROOT_TTL_MS = 5000

/**
 * Resolve the harness home holding the global role directory.
 * @param configured - the row's `dshHome`, when set.
 * @param env - environment (injectable for tests).
 * @returns an absolute path.
 */
function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.DSH_HOME
  const raw = configured !== undefined && configured !== null && configured !== ''
    ? configured
    : typeof fromEnv === 'string' && fromEnv.trim().length > 0
      ? fromEnv
      : join(homedir(), '.dsh')
  return resolve(raw)
}

/**
 * Split one role document into frontmatter text and persona body.
 * EOLs are normalized to `\n`; the body is everything after the closing
 * delimiter with no leading newline and trailing content preserved.
 * @param raw - the file text.
 * @returns the frontmatter text (undefined without a block) and the body.
 */
export function splitRoleDocument(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines[0]?.trimEnd() !== '---') return { frontmatter: undefined, body: text }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trimEnd() === '---') {
      end = index
      break
    }
  }
  if (end < 0) return { frontmatter: undefined, body: text }
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  }
}

/**
 * Return the first persona `{{variable}}` reference the CORE would reject, or
 * undefined when every reference is one of {@link PERSONA_VARIABLES}.
 *
 * This mirrors `dsh-system-prompt`'s scanner exactly rather than approximating
 * it: interpolate() runs AFTER a section provider returns, so a reference this
 * check lets through becomes a thrown error on every turn instead of a
 * contained plugin failure.
 * @param text - the persona body.
 * @returns the offending reference name, or undefined.
 */
export function findUnsupportedPersonaVariable(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = CORE_GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // A lone `{{` without any later `}}` is literal prose for the core…
      if (text.indexOf('}}', open + 2) >= 0) return text.slice(open + 2, text.indexOf('}}', open + 2))
      // …and scanning continues past it, exactly like the core does.
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!CORE_VARIABLE_NAME.test(name)) return name
    if (!PERSONA_VARIABLES.includes(name)) return name
    last = open + group[0].length
  }
  return undefined
}

/** Whether catalog text carries a `{{` at all (it is rendered through interpolation). */
function hasVariableSyntax(text) {
  return typeof text === 'string' && text.includes('{{')
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeNameList(value, field) {
  if (!Array.isArray(value)) return { error: `${field} must be an array of tool names` }
  const names = []
  for (const entry of value) {
    const name = nonEmptyString(entry)
    if (name === undefined) return { error: `${field} entries must be non-empty strings` }
    if (!names.includes(name)) names.push(name)
  }
  return { names }
}

/**
 * Validate and normalize the `toolFilter` shape (including the `tools`
 * allow-list shorthand).
 *
 * An EXPLICITLY declared `allow` is always preserved, even when empty: the core
 * accepts `{ allow: [] }` and reads it as "hide every inherited tool", so
 * dropping it (which would leave a bare `deny` and hand the child everything
 * else) is a silent fail-open. Only a declaration with nothing effective —
 * `{}` or a lone empty `deny` — is refused.
 * @param value - parsed frontmatter.
 * @returns the normalized filter, or an error string.
 */
export function normalizeRoleToolFilter(value) {
  const hasTools = value.tools !== undefined
  const hasFilter = value.toolFilter !== undefined
  if (hasTools && hasFilter) return { error: 'declare either `tools` or `toolFilter`, not both' }
  if (hasTools) {
    const list = normalizeNameList(value.tools, 'tools')
    if (list.error !== undefined) return { error: list.error }
    // `tools: []` is legal and means "no inherited tool at all".
    return { filter: { allow: list.names } }
  }
  if (!hasFilter) return {}
  const raw = value.toolFilter
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '`toolFilter` must be an object with optional `allow` and/or `deny` arrays' }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'allow' && key !== 'deny') return { error: `\`toolFilter.${key}\` is not supported (use allow/deny)` }
  }
  const filter = {}
  if (raw.allow !== undefined) {
    const list = normalizeNameList(raw.allow, 'toolFilter.allow')
    if (list.error !== undefined) return { error: list.error }
    filter.allow = list.names
  }
  if (raw.deny !== undefined) {
    const list = normalizeNameList(raw.deny, 'toolFilter.deny')
    if (list.error !== undefined) return { error: list.error }
    if (list.names.length > 0) filter.deny = list.names
  }
  if (filter.allow === undefined && filter.deny === undefined) {
    return { error: '`toolFilter` has no usable entries; omit the field to grant all tools, or set `allow: []` to grant none' }
  }
  return { filter }
}

/**
 * Parse and validate one role document.
 * @param id - the role id (the file stem).
 * @param raw - the file text.
 * @param options - `maxBodyBytes` guard.
 * @returns `{ role }` on success or `{ error }` with a human-readable reason.
 */
export function parseRoleDocument(id, raw, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!ROLE_ID_PATTERN.test(id)) {
    return { error: `role id "${id}" is not kebab-case (lowercase letters, digits, single hyphens)` }
  }
  const { frontmatter, body } = splitRoleDocument(raw)
  let value = {}
  if (frontmatter !== undefined && frontmatter.trim().length > 0) {
    let parsed
    try {
      parsed = parseYaml(frontmatter)
    } catch (error) {
      return { error: `frontmatter is not valid YAML: ${String(error?.message ?? error)}` }
    }
    if (parsed === null || parsed === undefined) value = {}
    else if (typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'frontmatter must be a YAML mapping' }
    else value = parsed
  }
  // Reject typos instead of silently ignoring them: a misspelled `tools` key
  // would otherwise grant the child every inherited tool.
  const unknownKeys = Object.keys(value).filter((key) => !ROLE_FRONTMATTER_KEYS.includes(key))
  if (unknownKeys.length > 0) {
    return { error: `unknown frontmatter key${unknownKeys.length > 1 ? 's' : ''} ${unknownKeys.map((key) => `\`${key}\``).join(', ')}; supported: ${ROLE_FRONTMATTER_KEYS.join(', ')}` }
  }
  if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
    return { error: `persona body is ${Buffer.byteLength(body, 'utf8')} bytes, over the ${maxBodyBytes}-byte limit (raise maxBodyBytes to allow it)` }
  }
  if (value.name !== undefined) {
    const declared = nonEmptyString(value.name)
    if (declared === undefined) return { error: '`name` must be a non-empty string when set' }
    if (declared !== id) {
      return { error: `\`name: ${declared}\` must equal the file id "${id}" or be omitted (the file name is the role id)` }
    }
  }
  const description = nonEmptyString(value.description)
  if (description === undefined) return { error: '`description` is required and must be non-empty' }
  const displayName = value.displayName === undefined ? undefined : nonEmptyString(value.displayName)
  if (value.displayName !== undefined && displayName === undefined) {
    return { error: '`displayName` must be a non-empty string when set' }
  }
  const whenToUse = value.whenToUse === undefined ? undefined : nonEmptyString(value.whenToUse)
  if (value.whenToUse !== undefined && whenToUse === undefined) {
    return { error: '`whenToUse` must be a non-empty string when set' }
  }
  // Catalog text reaches the model through the SAME strict interpolation as the
  // persona, but it is assembled OUTSIDE this plugin's try/catch — an unknown
  // reference there would throw on every turn of every agent that sees the
  // catalog. Any `{{` is therefore refused, including the silently-substituted
  // registered ones (a description must not leak {{cwd}}).
  for (const [field, text] of [['description', description], ['displayName', displayName], ['whenToUse', whenToUse]]) {
    if (hasVariableSyntax(text)) {
      return { error: `\`${field}\` must not contain \`{{\` (catalog text is interpolated strictly; write plain text)` }
    }
  }
  const route = {}
  for (const field of ['provider', 'model', 'reasoningEffort']) {
    if (value[field] === undefined) continue
    const text = nonEmptyString(value[field])
    if (text === undefined) return { error: `\`${field}\` must be a non-empty string when set` }
    route[field] = text
  }
  // A route is a pair: a lone provider/model is merged over the parent's other
  // half by the core, silently producing a route nobody declared.
  if ((route.provider === undefined) !== (route.model === undefined)) {
    return { error: '`provider` and `model` must be set together (or both omitted to inherit the parent route)' }
  }
  const filterResult = normalizeRoleToolFilter(value)
  if (filterResult.error !== undefined) return { error: filterResult.error }
  const badVariable = findUnsupportedPersonaVariable(body)
  if (badVariable !== undefined) {
    return { error: `persona references {{${badVariable}}}; only ${PERSONA_VARIABLES.map((name) => `{{${name}}}`).join(', ')} are available (no spaces inside the braces)` }
  }
  const persona = body.trim().length > 0 ? body : undefined
  return {
    role: {
      id,
      displayName: displayName ?? id,
      description,
      ...(whenToUse !== undefined ? { whenToUse } : {}),
      ...route,
      ...(filterResult.filter !== undefined ? { toolFilter: filterResult.filter } : {}),
      ...(persona !== undefined ? { persona } : {}),
    },
  }
}

/**
 * Create a cached role loader. One loader per plugin instance; the cache is
 * keyed by absolute path and invalidated by `mtimeMs`.
 * @param options - resolved discovery config.
 * @returns the loader.
 */
export function createRoleLoader(options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const projectRootTtlMs = typeof options.projectRootTtlMs === 'number' ? options.projectRootTtlMs : PROJECT_ROOT_TTL_MS
  const markers = Array.isArray(options.projectRootMarkers) && options.projectRootMarkers.length > 0
    ? options.projectRootMarkers
    : ['.git']
  const dshHome = resolveDshHome(options.dshHome)
  const fileCache = new Map()
  const projectRootCache = new Map()
  const dirCache = new Map()
  /** Diagnostic identities already logged, so a per-step read warns once. */
  const reportedDiagnostics = new Set()

  /**
   * Nearest ancestor carrying a project-root marker (or the cwd itself).
   *
   * The answer is cached with a TTL because the tree can change under a live
   * session (`git init` in a project that had no marker) and a permanent cache
   * would keep serving the old root for the rest of the process.
   */
  function projectRootFor(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    const start = resolve(cwd)
    const now = Date.now()
    const cached = projectRootCache.get(start)
    if (cached !== undefined && now - cached.at < projectRootTtlMs) return cached.root
    let current = start
    let found = start
    for (;;) {
      let hit = false
      for (const marker of markers) {
        if (existsSync(join(current, marker))) {
          hit = true
          break
        }
      }
      if (hit) {
        found = current
        break
      }
      const parent = resolve(current, '..')
      if (parent === current) break
      current = parent
    }
    projectRootCache.set(start, { root: found, at: now })
    return found
  }

  function loadRecord(path, id, source) {
    let stats
    try {
      stats = statSync(path)
    } catch (error) {
      return { error: `cannot stat role file: ${String(error?.code ?? error)}` }
    }
    const cached = fileCache.get(path)
    // Size joins mtime so a same-millisecond rewrite is still noticed.
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.record
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      return { error: `cannot read role file: ${String(error?.code ?? error)}` }
    }
    const parsed = parseRoleDocument(id, raw, { maxBodyBytes })
    if (parsed.error !== undefined) {
      // Failures are deliberately NOT cached: fixing a file must take effect
      // even when its mtime did not move.
      return { error: parsed.error }
    }
    const record = { role: { ...parsed.role, path, source } }
    fileCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, record })
    return record
  }

  /** List one role directory, cached by the directory's own mtime. */
  function listRoleFiles(root) {
    let stats
    try {
      stats = statSync(root.path)
    } catch {
      return []
    }
    const cached = dirCache.get(root.path)
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs) return cached.files
    let entries
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
    } catch {
      return []
    }
    const files = entries
      // A symlinked role file counts: the stats below follow the link.
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && extname(entry.name) === '.md')
      .map((entry) => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    dirCache.set(root.path, { mtimeMs: stats.mtimeMs, files })
    return files
  }

  /**
   * Resolve the roots for one session cwd, lowest precedence last.
   * @param cwd - the session working directory (may be undefined).
   * @returns ordered roots.
   */
  function rootsFor(cwd) {
    const roots = []
    const projectRoot = projectRootFor(cwd)
    const globalPath = join(dshHome, 'roles')
    if (projectRoot !== undefined) {
      const projectPath = join(projectRoot, ...PROJECT_ROLE_DIR)
      roots.push({ source: 'project', path: projectPath })
      // A repository rooted at the harness home would otherwise be scanned
      // twice, reporting every global role as shadowed by itself.
      if (resolve(projectPath) === resolve(globalPath)) return roots
    }
    roots.push({ source: 'global', path: globalPath })
    return roots
  }

  /**
   * Load the merged role catalog for one cwd. Never throws.
   * @param cwd - the session working directory.
   * @param options - `freshDiagnostics` returns each distinct diagnostic only
   *   once per cause (for per-step logging); the default returns them all.
   * @returns `{ roles, diagnostics, roots }` with project roles winning on id.
   */
  function loadSync(cwd, options = {}) {
    const roles = []
    const byId = new Set()
    const diagnostics = []
    const roots = rootsFor(cwd)
    for (const root of roots) {
      for (const file of listRoleFiles(root)) {
        const id = basename(file, '.md')
        const path = join(root.path, file)
        const record = loadRecord(path, id, root.source)
        const push = (reason) => {
          const identity = `${path}\u0000${reason}`
          if (options.freshDiagnostics === true) {
            if (reportedDiagnostics.has(identity)) return
            reportedDiagnostics.add(identity)
          }
          diagnostics.push({ id, path, source: root.source, reason })
        }
        if (record.error !== undefined) {
          push(record.error)
          continue
        }
        if (byId.has(id)) {
          push('shadowed by a higher-precedence role of the same id')
          continue
        }
        byId.add(id)
        roles.push(record.role)
      }
    }
    return { roles, diagnostics, roots }
  }

  return { loadSync, rootsFor, projectRootFor, dshHome }
}
