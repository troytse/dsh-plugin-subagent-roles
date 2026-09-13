/**
 * Tool-policy normalization for ONE delegation.
 *
 * A role declares a tool policy (`tools` shorthand or `toolFilter`). Before it
 * reaches `subagents.start()` the entries are expanded against the delegating
 * agent's CURRENTLY VISIBLE tool names, because the core's `tools.restrict()`
 * rejects an unknown name by throwing inside the child's creation window —
 * an MCP server that has not finished registering yet would otherwise turn
 * every delegation into a hard failure.
 *
 * Glob entries (`*`, `?`) expand to the concrete matches; literal entries that
 * are not visible are reported so the caller can warn (`onMissingTool: 'drop'`)
 * or refuse (`'error'`). An `allow` list that expands to nothing is passed
 * through as an explicit empty allow list — fail closed, never silently widen.
 */

/** Whether a policy entry is a glob rather than a literal tool name. */
export function isGlobPattern(entry) {
  return entry.includes('*') || entry.includes('?')
}

/**
 * Names the registry can expose but `tools.restrict()` refuses to accept.
 * `run_code` is the PTC presentation transport: `schemas()` lists it, while
 * `restrict()` throws on it by name.
 */
const UNRESTRICTABLE_TOOL_NAMES = new Set(['run_code'])

/**
 * Whether a visible tool name must be kept out of every role policy.
 * @param name - tool name from the registry view.
 * @returns whether `tools.restrict()` would reject it outright.
 */
export function isUnrestrictableToolName(name) {
  return UNRESTRICTABLE_TOOL_NAMES.has(name)
}

/**
 * Extract the tool names the core complained about, so one delegation can drop
 * them and retry instead of failing with an error the model cannot act on.
 * @param error - the thrown value from `subagents.start` / `restrict()`.
 * @returns the offending names, deduplicated (empty when unrelated).
 */
export function parseUnrestrictableToolNames(error) {
  const text = String(error?.message ?? error ?? '')
  const names = []
  const unknown = /names unknown global tools? ((?:"[^"]+"(?:,\s*)?)+)/.exec(text)
  if (unknown !== null) for (const match of unknown[1].matchAll(/"([^"]+)"/g)) names.push(match[1])
  const reserved = /cannot name reserved PTC mode presentation transport "([^"]+)"/.exec(text)
  if (reserved !== null) names.push(reserved[1])
  return [...new Set(names)]
}

/**
 * Copy a normalized filter without the named entries. An explicit `allow` list
 * is preserved even when it becomes empty (that still means "no tools").
 * @param filter - normalized filter.
 * @param names - names to remove.
 * @returns the reduced filter, or undefined when nothing effective remains.
 */
export function dropToolFilterNames(filter, names) {
  const drop = new Set(names)
  const next = {}
  if (filter?.allow !== undefined) next.allow = filter.allow.filter((name) => !drop.has(name))
  if (filter?.deny !== undefined) {
    const deny = filter.deny.filter((name) => !drop.has(name))
    if (deny.length > 0) next.deny = deny
  }
  if (next.allow === undefined && next.deny === undefined) return undefined
  return next
}

function escapeRegExp(character) {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile one glob entry into a whole-name regular expression.
 * @param pattern - glob text.
 * @returns the compiled matcher.
 */
export function globToRegExp(pattern) {
  let source = '^'
  for (const character of pattern) {
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += escapeRegExp(character)
  }
  return new RegExp(`${source}$`)
}

/**
 * Expand one role tool policy against the visible tool names.
 * @param filter - `{ allow?, deny? }` as declared by the role.
 * @param visibleNames - tool names visible to the delegating agent.
 * @param options - `onMissing`: `drop` (default) or `error`.
 * @returns `{ filter?, missing, unmatched, dropped }`; `filter` is undefined
 *   when nothing effective remains.
 * @throws when `onMissing` is `error` and any entry could not be resolved.
 */
export function expandToolFilter(filter, visibleNames, options = {}) {
  const visible = visibleNames instanceof Set ? visibleNames : new Set(visibleNames ?? [])
  const missing = []
  const unmatched = []
  const dropped = []
  const expand = (entries) => {
    const names = []
    for (const entry of entries ?? []) {
      if (!isGlobPattern(entry)) {
        if (visible.has(entry)) {
          if (!names.includes(entry)) names.push(entry)
        } else {
          missing.push(entry)
          dropped.push(entry)
        }
        continue
      }
      const matcher = globToRegExp(entry)
      const matches = [...visible].filter((name) => matcher.test(name)).sort()
      if (matches.length === 0) {
        unmatched.push(entry)
        dropped.push(entry)
        continue
      }
      for (const name of matches) if (!names.includes(name)) names.push(name)
    }
    return names
  }
  const hasAllow = filter?.allow !== undefined
  const hasDeny = filter?.deny !== undefined
  const expanded = {}
  if (hasAllow) expanded.allow = expand(filter.allow)
  if (hasDeny) {
    const deny = expand(filter.deny)
    if (deny.length > 0) expanded.deny = deny
  }
  if (options.onMissing === 'error' && (missing.length > 0 || unmatched.length > 0)) {
    const known = [...visible].sort().join(', ') || '(none)'
    const problems = [...missing.map((name) => `"${name}"`), ...unmatched.map((name) => `"${name}" (glob matched nothing)`)]
    throw new Error(`subagent-roles: tool policy names unavailable tool${problems.length > 1 ? 's' : ''} ${problems.join(', ')}; visible tools: ${known}`)
  }
  if (expanded.allow === undefined && expanded.deny === undefined) return { missing, unmatched, dropped }
  return { filter: expanded, missing, unmatched, dropped }
}

/**
 * Sum the schema characters of the named tools, for budget diagnostics.
 * @param schemaCharsByName - tool name to serialized-schema length.
 * @param names - the names to sum.
 * @returns the total character count.
 */
export function sumSchemaChars(schemaCharsByName, names) {
  let total = 0
  for (const name of names) total += schemaCharsByName[name] ?? 0
  return total
}
