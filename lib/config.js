/**
 * Cordis composition-entry Config for `subagent-roles`.
 *
 * Every knob is a plugin-row concern; per-role facts (route, tools, persona)
 * live in the role FILES, never here. Defaults are the recommended values, so
 * a deployment normally mounts the row with no config at all.
 */
import z from '@deepseek-ai/schemastery'
import { PERSONA_VARIABLES } from './roles.js'

/** Schemastery schema for the row config. */
export const Config = z.object({
  /** Model-facing delegation tool name (kept as `subagent_role` for compatibility). */
  toolName: z.string().min(1).default('subagent_role'),
  /** Subagent transport provider registered on `ctx.subagents`. */
  subagentProvider: z.string().min(1).default('spawn'),
  /** Background mode: one-shot runs through `subagents.start`, continuable through `startContinuable`. */
  backgroundMode: z.union(['one-shot', 'continuable']).default('one-shot'),
  /** Whether the tool exposes `run_in_background`. */
  enableRunInBackground: z.boolean().default(true),
  /**
   * Optional numeric delegation-depth cap; omit for provider-managed. Note that
   * `0` is accepted and means "no delegation at all": a child's depth starts at
   * 1, so the core rejects every start with a depth error.
   */
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')]),
  /** Role id used when a call omits `role`. */
  defaultRole: z.string(),
  /** `compact` renders the role catalog section; `off` renders nothing. */
  catalog: z.union(['compact', 'off']).default('compact'),
  /** `main` advertises roles to top-level agents only; `all` includes subagents. */
  catalogScope: z.union(['main', 'all']).default('main'),
  /** Per-role description cap inside the catalog line. */
  catalogDescriptionMaxLength: z.natural().min(16).default(160),
  /** Project-root markers searched upward from the session cwd. */
  projectRootMarkers: z.array(z.string()).default(['.git']),
  /**
   * How long a resolved project root is trusted before the tree is re-walked, in
   * milliseconds. Bounded so a `git init` under a live session is noticed.
   */
  projectRootTtlMs: z.natural().default(5000),
  /** Harness home holding the global `roles/` directory. */
  dshHome: z.string(),
  /** Persona size guard, in bytes. */
  maxBodyBytes: z.natural().min(1).default(65536),
  /**
   * Prompt variables a persona body may reference. Defaults to the three the
   * agent loop registers (`cwd`, `model`, `provider`); extend this only when the
   * deployment really registers more, because an unknown reference throws on
   * EVERY turn of the child that uses it.
   */
  personaVariables: z.array(z.string()).default([...PERSONA_VARIABLES]),
  /** Honor the official `subagent-model-selection` authorized model list. */
  respectModelSelection: z.boolean().default(true),
  /** Unknown-filter-name posture: `drop` warns and continues, `error` refuses before starting. */
  onMissingTool: z.union(['drop', 'error']).default('drop'),
  /**
   * Tool-call deadline for one foreground delegation, in milliseconds. Unset
   * leaves the call unbounded; a background delegation returns immediately and is
   * never subject to it.
   */
  timeoutMs: z.natural().min(1),
  /** Opt-in `subagent_roles` diagnostic tool. */
  enableListTool: z.boolean().default(false),
  /** Name of the diagnostic tool, so a second row can coexist with the first. */
  listToolName: z.string().min(1).default('subagent_roles'),
})
