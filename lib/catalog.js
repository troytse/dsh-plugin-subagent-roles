/**
 * The role catalog line — the ONLY role text that ever reaches a delegating
 * agent's context. Role personas stay on disk until a delegation needs them.
 *
 * Kept deliberately small: one framing line naming the delegation tool, plus
 * one `- id (displayName): description` line per role with the description
 * capped. Every extra line here is re-sent on every request of every agent that
 * sees the catalog, so the catalog spends its budget on routing information
 * only.
 */

/** Default per-role description cap inside the catalog line. */
export const DEFAULT_DESCRIPTION_MAX_LENGTH = 160

/**
 * Collapse whitespace and truncate one description for a catalog line.
 * @param value - the raw description.
 * @param maxLength - the cap in characters.
 * @returns the normalized, capped text.
 */
export function catalogDescription(value, maxLength = DEFAULT_DESCRIPTION_MAX_LENGTH) {
  const normalized = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

/**
 * Render the role catalog section text.
 * @param roles - the merged role records.
 * @param options - `toolName` (the configured delegation tool name) and
 *   `descriptionMaxLength`.
 * @returns the section text, or '' when there are no roles (the section is
 *   then dropped by the prompt registry and costs nothing).
 */
export function renderRoleCatalog(roles, options = {}) {
  const list = Array.isArray(roles) ? roles : []
  if (list.length === 0) return ''
  const descriptionMaxLength = options.descriptionMaxLength ?? DEFAULT_DESCRIPTION_MAX_LENGTH
  // The framing line must name the CONFIGURED tool: a renamed tool would
  // otherwise send the model after a name that does not exist. The global role
  // directory is described generically because `dshHome` is configurable.
  const toolName = options.toolName ?? 'subagent_role'
  const lines = [
    `Roles come from role files: \`.dsh/roles\` in this project, plus a global \`roles/\` directory. Delegate with \`${toolName}\`, not the generic \`subagent\`: only it applies the role persona and tool policy.`,
  ]
  for (const role of list) {
    const named = role.displayName !== undefined && role.displayName !== role.id
    // Collapse whitespace: a display name with a newline would break the
    // one-line-per-role invariant of the catalog.
    const label = named ? ` (${String(role.displayName).replaceAll(/\s+/g, ' ').trim()})` : ''
    const extra = role.whenToUse !== undefined ? ` ${catalogDescription(role.whenToUse, descriptionMaxLength)}` : ''
    lines.push(`- \`${role.id}\`${label}: ${catalogDescription(role.description, descriptionMaxLength)}${extra}`)
  }
  return lines.join('\n')
}
