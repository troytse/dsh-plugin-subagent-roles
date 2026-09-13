# dsh-plugin-subagent-roles

English | [中文](README.zh.md) | [Changelog (中文)](CHANGELOG.md)

[![npm](https://img.shields.io/npm/v/dsh-plugin-subagent-roles)](https://www.npmjs.com/package/dsh-plugin-subagent-roles)
[![CI](https://github.com/troytse/dsh-plugin-subagent-roles/actions/workflows/ci.yml/badge.svg)](https://github.com/troytse/dsh-plugin-subagent-roles/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Summary

`dsh-plugin-subagent-roles` defines subagent roles as files. A role is one Markdown file: YAML frontmatter carries a display name, a routing description, an optional LLM route, and a tool policy; the body is the persona the child runs with. Project roles live in `<project>/.dsh/roles/`, global roles in `~/.dsh/roles/`, and a project role wins when the same id exists in both.

The plugin registers one delegation tool and advertises the roles found for the current workspace with a compact catalog line. When a role is delegated to, the child starts with that role's persona and only the tools its policy allows — the delegating agent never carries the persona text, and a project without role files sees no catalog at all.

## Install

```sh
# from npm
dsh plugin --profile web add dsh-plugin-subagent-roles

# or a local checkout
dsh plugin --profile web add link:/path/to/dsh-plugin-subagent-roles
```

Restart the profile afterwards (`dsh web`). The package ships a bundle patch, so it inserts its single row without any composition edit. Requires Node.js 20 or newer, together with a DSH deployment that provides `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-subagent`.

## Quick start

Create a role file in the project:

```markdown
---
displayName: Code Reviewer
description: Reviews a diff for correctness, security, and missing tests, and reports findings by severity.
provider: deepseek-official
model: deepseek-v4-flash
reasoningEffort: low
tools: [read, grep, glob]
---
You are a code reviewer. Read the diff before judging it, separate blocking
issues from suggestions, and cite file and line for every finding.
```

Then ask the agent to delegate — “have the code-reviewer role review this diff” — or call the tool directly:

```js
subagent_role({ role: "code-reviewer", prompt: "Review the staged diff.", description: "review staged diff" })
```

Roles are read when the prompt is assembled and again when a delegation starts, so editing a role file takes effect without restarting DSH. `examples/delegation-prompts.md` has dispatch prompts in the same style ([中文](examples/delegation-prompts.zh.md)).

## Role files

### Where roles are read from

| Precedence | Path | Notes |
|---|---|---|
| 1 | `<project>/.dsh/roles/<id>.md` | `<project>` is the nearest ancestor of the session working directory that contains a project marker (`.git` by default); the working directory itself when no marker is found. |
| 2 | `~/.dsh/roles/<id>.md` | Shared across projects. `dshHome` overrides the location. |

A role file may be a symlink. Files are read by name, so the id is the file stem and must be kebab-case.

### File format

The frontmatter is a YAML mapping; the body is the persona.

| Field | Required | Meaning |
|---|---|---|
| `description` | yes | One line shown in the catalog; the delegating agent routes on it. |
| `name` | no | Must equal the file id when present; a guard against renaming a file without its declaration. |
| `displayName` | no | Human-readable name; defaults to the id. |
| `whenToUse` | no | Extra routing hint appended to the catalog line. |
| `provider`, `model` | no | LLM route for the child. Declare both or neither; omitting them inherits the parent's route. |
| `reasoningEffort` | no | Effort for the child; applies together with the route. |
| `tools` | no | Allow list shorthand, e.g. `[read, grep, glob]`. |
| `toolFilter` | no | Explicit policy: `{ allow: [...], deny: [...] }`. |

`tools` and `toolFilter` are mutually exclusive. Unknown frontmatter keys are rejected rather than ignored, so a typo cannot silently widen a role's tools.

The persona body may reference the prompt variables `{{cwd}}`, `{{model}}`, and `{{provider}}` — exactly the three the agent loop registers; they are interpolated by the harness for the child. A deployment that registers more can list them in `personaVariables`; a reference to anything else is rejected when the file is read, because an unknown variable throws on *every* turn of the child that uses it. References are matched exactly (no spaces inside the braces), and the catalog fields — `description`, `displayName`, `whenToUse` — must not contain `{{` at all, because catalog text passes through the same interpolation before it reaches the model.

## Configuration

The row accepts these options; pass them by overriding the row by id in the profile patch:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: subagent-roles
  name: dsh-plugin-subagent-roles
  config:
    catalogDescriptionMaxLength: 120
```

| Option | Default | Meaning |
|---|---|---|
| `toolName` | `subagent_role` | Model-facing delegation tool name. |
| `subagentProvider` | `spawn` | Subagent transport provider. |
| `backgroundMode` | `one-shot` | `one-shot` or `continuable`. |
| `enableRunInBackground` | `true` | Expose `run_in_background` on the tool. |
| `maxDepth` | unset | Numeric delegation-depth cap; unset leaves it to the provider. `0` refuses every delegation. |
| `defaultRole` | unset | Role used when a call omits `role`. |
| `catalog` | `compact` | `compact` renders the role catalog; `off` renders nothing. |
| `catalogScope` | `main` | `main` advertises roles to top-level agents; `all` includes subagents. |
| `catalogDescriptionMaxLength` | `160` | Per-role description cap in the catalog line. |
| `projectRootMarkers` | `['.git']` | Markers searched upward from the session working directory. |
| `projectRootTtlMs` | `5000` | How long a resolved project root is trusted before the tree is re-walked, so a `git init` under a live session is noticed. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Location of the global `roles/` directory. |
| `maxBodyBytes` | `65536` | Persona size limit, counted in UTF-8 bytes. A file larger than this plus 64 KiB of frontmatter is refused before it is read. |
| `personaVariables` | `['cwd', 'model', 'provider']` | Prompt variables a persona may reference. Extend only for variables the deployment really registers. |
| `respectModelSelection` | `true` | Honor the official `subagent-model-selection` allow list: a Session's captured policy first, otherwise the live setting. |
| `onMissingTool` | `drop` | Unavailable tool names: `drop` warns and continues, `error` refuses the delegation. |
| `timeoutMs` | unset | Tool-call deadline for one foreground delegation. Unset leaves it unbounded. |
| `enableListTool` | `false` | Register the diagnostic tool. |
| `listToolName` | `subagent_roles` | Name of the diagnostic tool, so a second row can coexist with the first. |

## Tool policy

A role's policy decides which tools its child can see and call. `tools` (and `toolFilter.allow`) is an allow list: everything not listed disappears from the child — schema and prompt guidance together — and calls to it are refused. `toolFilter.deny` removes named tools while keeping the rest. Entries accept the glob characters `*` and `?`, e.g. `mcp__demo__*`.

Globs are expanded at delegation time against the tool names visible to the delegating agent, so a name that is not registered yet cannot fail the delegation. An unavailable literal name is dropped with a warning; `onMissingTool: 'error'` turns that into a refusal instead. An allow list that expands to nothing is passed through as an empty allow list, which hides every inherited tool rather than granting everything.

Two cases are handled explicitly:

- `run_code`, the presentation transport for PTC deployments, is never passed to a policy: the tool registry can list it, but the core refuses to restrict by that name.
- Tools that the delegating agent registers in its own scope are inherited by the parent but are not part of a child's scope chain. Naming one makes the core reject the child. The plugin drops those names, retries the delegation once, and warns.

## Diagnostics

Enable `enableListTool` to register `subagent_roles`, which reports every role with its source, file path, bound route, persona size, the expanded policy, and its schema-character budget, plus any file that was skipped and why.

To inspect a finished delegation, read the child's session log:

```sh
node scripts/inspect-session-budget.mjs --project <project-dir>
node scripts/inspect-session-budget.mjs <session-dir> --all --grep "You are a code reviewer"
```

The script decodes a session log read-only and prints the system-prompt size, the tool schemas the session requested, and whether the role catalog reached that session.

## How it works

- **Catalog.** One prompt section, rendered per assembly, lists the roles of the assembling agent's workspace: a framing line plus `- <id> (<displayName>): <description>` per role. It renders empty — and costs nothing — when a project has no roles, when the catalog is switched off, when the agent is a subagent, or when the delegation tool is not visible to that agent.
- **Delegation.** `subagent_role` resolves the role against the delegating agent's working directory, then starts a child through `ctx.subagents` with the role's persona, route, and tool filter. The model-facing wording follows the transport provider: a fork provider already seeds the child with this conversation's completed turns, so the tool says to build on them instead of demanding a fully self-contained prompt. The route is preflighted through `llm.resolveCallConfig()` before the child exists, so a typo in a role's `model` or `reasoningEffort` is reported to the delegating agent rather than thrown from inside child creation.
- **Multiple rows.** The catalog section and the diagnostic tool are named after the row (`<toolName>:catalog`, `listToolName`), so a profile can mount a second row for another transport provider (`toolName: subagent_role_fork`) without either registration colliding.
- **Inheritance.** A child joins its parent's agent preset, so it keeps the parent's prompt and tools except where the role's policy removes them. The role persona shadows the deployment persona prefix for that child only.

## Limitations

- Tools registered into a child's own scope are not affected by a role's tool policy; the core applies restrictions to inherited tools only. The delegation runtime and some tool plugins register per agent, so a child can end up with a small number of tools beyond its allow list.
- Hiding a tool removes its schema and any scope-aware prompt guidance. Prompt sections with static text stay in the child's prompt.
- A role persona replaces the deployment persona prefix for the child. The persona suffix, such as the working-directory line, is kept.
- `respectModelSelection` prefers the policy a Session captured (the same durable projection the official delegation tool writes) and falls back to the live `subagent-model-selection` setting, which is what seeds a fresh Session. A change therefore applies to Sessions that have not captured a policy yet.
- The delegation tool declares no `timeoutMs` unless you set one; an unbounded foreground delegation can outlive the conversation that started it. Bound long runs with `timeoutMs`, `maxDepth`, or the dispatch prompt.
- Discovery caches are bounded (512 entries), so a very large number of distinct projects in one host process re-stats files more often than it otherwise would. Results are unaffected.
- The diagnostic script needs Node.js 22.15 or newer for multi-frame zstd decoding; the plugin itself runs on Node.js 20.

## Development

```sh
npm test                                      # unit tests (node --test)
npm run lint                                  # node --check over lib/, scripts/, test/
node --test --experimental-test-coverage      # per-file coverage
```

The runtime lives in `lib/`: `roles.js` (discovery and parsing), `catalog.js` (catalog text), `policy.js` (tool policies), `route.js` (LLM route), `tool.js` (delegation and diagnostic tools), `config.js` (row options), and `index.js` (plugin wiring).

CI runs `npm run lint` and `npm test` on Node.js 20, 22, and 24.

### Releasing

1. Add a `## [<version>]` entry to `CHANGELOG.md` (written in Chinese). The publish workflow refuses to ship a version the changelog does not document.
2. `npm version <patch|minor|major>` commits the bump and creates the tag; push the commit and the tag.
3. `.github/workflows/publish.yml` then runs the tests, checks that the tag matches `package.json`, checks the changelog entry, and publishes through npm trusted publishing (OIDC) with a provenance attestation, so no long-lived token is stored in the repository.

Register `publish.yml` as a trusted publisher on the package's npm settings page before the first automated release.

## License

MIT
