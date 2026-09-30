/**
 * Child-prompt trimming.
 *
 * Every mounted tool plugin contributes one guidance section to the system
 * prompt, and the core only makes SOME of them scope-aware (`dsh-tool-fs`,
 * `dsh-tool-fs-search`, `dsh-tool-web`, `dsh-file-reference-local`); the rest —
 * `tool:goal`, `tool:ralph`, `tool:jobs`, `tool:workflow`, `app:web-surface`,
 * `harness:source`, `ui:deliverable-file-references` — render in EVERY scope.
 * A role that hides a tool therefore still pays for its guidance inside the
 * child, and a child keeps reading the Web GUI, harness-checkout, and
 * deliverable instructions it can never act on.
 *
 * This module registers ONE host-plane `system-prompt/assemble` listener. The
 * scope-filtered dispatch of that waterfall admits a listener owned by an
 * enclosing scope for every descendant scope's assembly (`@deepseek-ai/dsh-scope`),
 * so a host-plane plugin sees each subagent assembly and the returned assembly
 * is authoritative — trimming here changes the child's real prompt.
 *
 * Three rules, decided per assembly:
 *  - `tool:<name>` guidance for a tool that is registered but NOT visible in
 *    that scope (the root-cause rule: dead guidance is dead weight);
 *  - group guidance (`tool:jobs`, `tool:goal`) whose section name is a label
 *    rather than a tool name, dropped only when EVERY tool its own text names
 *    is invisible there;
 *  - in `full` mode (the default), named prompt parts no child can act on —
 *    matched against sections and contexts alike.
 */
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { LOG_PREFIX } from './tool.js'

/**
 * Prompt parts a subagent never acts on, dropped by name in `full` mode.
 *
 * Registered without a scope guard by `dsh-app-boot` (`harness:source`),
 * `dsh-web-app` (`app:web-surface`), `dsh-client-ui-deliverables`
 * (`ui:deliverable-file-references`), and `dsh-file-reference-local`
 * (`context:file-reference`).
 *
 * ONE list, matched against sections AND contexts, because the kind is a core
 * implementation detail that moves: `context:file-reference` is a SECTION in the
 * installed core despite its name (verified live — a contexts-only list let it
 * through). Name matching is version-sensitive on purpose: a renamed part is
 * simply not trimmed, which is the safe direction.
 */
export const DEFAULT_CHILD_NAMES = Object.freeze([
  'harness:source',
  'app:web-surface',
  'ui:deliverable-file-references',
  'context:file-reference',
])

/** Bound on remembered child sessions, mirroring the discovery cache bound. */
const REPORTED_LIMIT = 512

/** Insertion-ordered, size-bounded set used to report one line per child. */
function boundedSet(limit) {
  const set = new Set()
  return {
    add(value) {
      if (set.has(value)) return false
      set.add(value)
      if (set.size > limit) set.delete(set.values().next().value)
      return true
    },
  }
}

/** Whole-word test per tool name, compiled once. Bounded like every other cache. */
const TOOL_PATTERNS = new Map()

/** The compiled whole-word pattern for one tool name. */
function patternFor(name) {
  let pattern = TOOL_PATTERNS.get(name)
  if (pattern === undefined) {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
    pattern = new RegExp(`\\b${escaped}\\b`)
    TOOL_PATTERNS.set(name, pattern)
    if (TOOL_PATTERNS.size > REPORTED_LIMIT) TOOL_PATTERNS.delete(TOOL_PATTERNS.keys().next().value)
  }
  return pattern
}

/**
 * Whether one section text mentions a tool name as a WHOLE word.
 *
 * A plain `includes` is not good enough: `'already'.includes('read')` is true,
 * which would make the group-label rule treat an unrelated sentence as naming
 * the `read` tool and keep guidance it should drop.
 * @param text - the section text.
 * @param name - a registered tool name.
 * @returns whether the name appears as a whole word.
 */
export function mentionsTool(text, name) {
  return patternFor(name).test(text)
}

/** The registry's known tool names (the global view), or undefined when unreadable. */
export function knownToolNames(ctx) {
  try {
    const schemas = ctx.tools.schemas()
    return Array.isArray(schemas)
      ? new Set(schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string'))
      : undefined
  } catch {
    return undefined
  }
}

/** Visible tool names for one scope, or undefined when the registry cannot answer. */
export function visibleToolNames(ctx, agent) {
  try {
    const schemas = ctx.tools.schemas(agent)
    return Array.isArray(schemas)
      ? new Set(schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string'))
      : undefined
  } catch {
    return undefined
  }
}

/** The tool a `tool:<name>` section name claims, or undefined for another section. */
function claimedTool(sectionName) {
  return sectionName.startsWith('tool:') ? sectionName.slice('tool:'.length) : undefined
}

/**
 * Character count for one prompt part, treating absent text as empty.
 *
 * A section or context without a string `text` used to throw on `.length`, and
 * the outer catch then skipped trimming the WHOLE assembly for that turn. Counting
 * it as 0 keeps the degradation local and identical in meaning: no content-based
 * rule can fire for that part and nothing is counted as saved, while every other
 * part is still trimmed. It is a no-trim, never an error.
 * @param text - the part's text, possibly missing on a hand-built assembly.
 * @returns the length, or 0 when there is no string to measure.
 */
function textLength(text) {
  return typeof text === 'string' ? text.length : 0
}

/**
 * Apply the trim rules to one assembly.
 *
 * Pure: it returns the surviving sections and contexts plus a report, and never
 * mutates its input. A registry that could not be read (`known`/`visible`
 * undefined) disables the tool rules instead of guessing a tool away — an
 * unreadable registry must never cost the child its guidance.
 * @param assembly - `sections` and `contexts` of one assembly.
 * @param policy - `mode` (`tools` or `full`), the known and visible tool-name
 *   sets, and the prompt-part names `full` mode drops.
 * @returns the surviving parts and the dropped names with the characters saved.
 */
export function trimChildPrompt(assembly, policy) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : []
  const mode = policy?.mode ?? 'full'
  // `off` means OFF: the switch exists to stop touching a child's prompt, so it
  // must not fall through to the tool rules (it silently behaved like `tools`
  // before this guard existed).
  if (mode === 'off') {
    return { sections, contexts, droppedSections: [], droppedContexts: [], saved: 0, changed: false }
  }
  const known = policy?.known
  const visible = policy?.visible
  const canJudgeTools = known !== undefined && visible !== undefined
  const invisible = (name) => canJudgeTools && known.has(name) && !visible.has(name)
  const droppedSections = []
  const droppedContexts = []
  let saved = 0

  const survivor = (section) => {
    const tool = claimedTool(section.name)
    let drop = false
    if (tool !== undefined && canJudgeTools) {
      if (invisible(tool)) {
        // R1 — per-tool guidance for a registered tool this scope cannot call.
        drop = true
      } else if (!known.has(tool) && textLength(section.text) > 0) {
        // R1b — a group label: drop only when every tool it names is invisible.
        const named = [...known].filter((name) => mentionsTool(section.text, name))
        drop = named.length > 0 && named.every((name) => !visible.has(name))
      }
    }
    if (!drop && mode === 'full') {
      drop = policy.dropNames?.has(section.name) === true
    }
    if (!drop) return true
    // An already-empty (or non-string) section costs nothing; report only real removals.
    const length = textLength(section.text)
    if (length > 0) {
      droppedSections.push(`${section.name}(${length})`)
      saved += length
    }
    return false
  }

  const survivors = sections.filter(survivor)
  const survivingContexts = mode === 'full'
    ? contexts.filter((entry) => {
      if (policy.dropNames?.has(entry.name) !== true) return true
      const length = textLength(entry.text)
      if (length > 0) {
        droppedContexts.push(`${entry.name}(${length})`)
        saved += length
      }
      return false
    })
    : contexts

  return {
    sections: survivors,
    contexts: survivingContexts,
    droppedSections,
    droppedContexts,
    saved,
    changed: survivors.length !== sections.length || survivingContexts.length !== contexts.length,
  }
}

/**
 * Register the child-prompt trim on a plugin context.
 *
 * Trimming applies to subagent assemblies only: a top-level agent is the one
 * talking to the user, so its prompt is left exactly as the deployment composed
 * it. A failure inside the listener is logged and the assembly passes through
 * untouched — prompt assembly must never fail because a trim hiccuped.
 * @param options - the plugin `ctx` and the live `source` the policy is read
 *   from on each assembly (the host settings namespace when one is served, the
 *   row config otherwise), so a Settings edit applies to the next child turn.
 * @returns the exact disposer that removes the listener.
 */
export function registerChildPromptTrim(options) {
  const { ctx, source } = options
  const reported = boundedSet(REPORTED_LIMIT)

  return ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const resolved = await next()
    try {
      const agent = context?.agent
      if (agent === undefined || agent === null) return resolved
      if (delegationDepthOf(agent) <= 0) return resolved
      const policy = source.read()
      const result = trimChildPrompt(resolved, {
        mode: policy.mode,
        known: knownToolNames(ctx),
        visible: visibleToolNames(ctx, agent),
        dropNames: policy.dropNames,
      })
      if (result.changed) {
        resolved.sections = result.sections
        resolved.contexts = result.contexts
      }
      if (result.saved === 0) return resolved
      const detail = `-${result.saved} chars (${[...result.droppedSections, ...result.droppedContexts].join(', ')})`
      // One line per child, not per turn: a long child re-assembles every step.
      const sessionId = agent.session?.header?.id ?? agent.session?.header?.parentSession ?? '(unknown)'
      if (reported.add(String(sessionId))) {
        ctx.logger?.info?.(`[${LOG_PREFIX}] child prompt trimmed: ${detail}`)
      } else {
        ctx.logger?.debug?.(`[${LOG_PREFIX}] child prompt trimmed: ${detail}`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`[${LOG_PREFIX}] child prompt trim skipped: ${String(error?.message ?? error)}`)
    }
    return resolved
  })
}
