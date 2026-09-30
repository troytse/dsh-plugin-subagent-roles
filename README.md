# dsh-plugin-subagent-roles

English | [中文](README.zh.md) | [Changelog (中文)](CHANGELOG.md)

[![npm](https://img.shields.io/npm/v/dsh-plugin-subagent-roles)](https://www.npmjs.com/package/dsh-plugin-subagent-roles)
[![CI](https://github.com/troytse/dsh-plugin-subagent-roles/actions/workflows/ci.yml/badge.svg)](https://github.com/troytse/dsh-plugin-subagent-roles/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Summary

`dsh-plugin-subagent-roles` defines subagent roles as files. A role is one Markdown file: YAML frontmatter carries a display name, a routing description, an optional LLM route, a tool policy, and an optional tool-call budget; the body is the persona the child runs with. Project roles live in `<project>/.dsh/roles/`, global roles in `~/.dsh/roles/`, and a project role wins when the same id exists in both.

The plugin registers one delegation tool and advertises the roles found for the current workspace with a compact catalog line. When a role is delegated to, the child starts with that role's persona and only the tools its policy allows — the delegating agent never carries the persona text, and a project without role files sees no catalog at all. A role may also cap how many tool calls its child gets: the cap is a hard, observable limit counted from the framework's own `tool/call` events, so a child that will not stop is stopped.

## Install

**DSH desktop app** — install it from the app's own **Plugins** page (sidebar → Plugins): paste the package name to pull it from npm, or an **absolute path** to install a local checkout.

```
dsh-plugin-subagent-roles
# or a local checkout
/path/to/dsh-plugin-subagent-roles
```

The `desktop` profile belongs to the application — `dsh plugin --profile desktop …` is refused on purpose (`profile "desktop" is managed exclusively by the Electron application`) — so the Plugins page is the supported channel there. It installs the package, appends the bundle to the profile, and the row then appears in the Settings inventory. Host-side rows load immediately; client-side surfaces — this plugin's Settings card, or another plugin's sidebar, task or usage pages — need one page refresh before they show up.

**CLI profiles (`dsh web`, TUI, headless)** — install into that profile by name, or link a checkout:

```sh
# from npm
dsh plugin --profile web add dsh-plugin-subagent-roles

# or a local checkout
dsh plugin --profile web add link:/path/to/dsh-plugin-subagent-roles
```

Restart the profile afterwards (`dsh web`). The package ships a bundle patch, so it inserts its single row without any composition edit. Requires Node.js 20 or newer, together with a DSH deployment that provides `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-subagent`.

Both dependency lines are supported. On the **0.1.5** line the Settings → Plugins card tunes the row; on the **0.2.0** line that card never mounts — 0.2.0 removed plugin-registered settings namespaces — and the row's `config` is the channel instead (see [Settings](#settings)).

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
| `maxToolCalls` | no | Hard cap on the child's tool calls: a whole number. Omit it to inherit the row's `defaultMaxToolCalls`; set `0` for explicitly unlimited, which **overrides** the row default. |
| `maxToolCallsScope` | no | `delegation` (default) restarts the count at each delegation — and at each `turn/start` of a continuable child, which is what a background wake opens. `session` accumulates for the child's whole life. |
| `onToolCallBudget` | no | What happens at the cap: `wrap-up` (default), `interrupt`, or `off`. |
| `graceToolCalls` | no | Extra calls `wrap-up` tolerates after its notice; defaults to `1`, and `0` stops on the crossing call itself. |

`tools` and `toolFilter` are mutually exclusive. Unknown frontmatter keys are rejected rather than ignored, so a typo cannot silently widen a role's tools.

The `maxToolCalls` family requires **plugin ≥ 0.4.0**. An older version knows none of those keys and refuses the whole file, so a role file and the plugin version are bound together: adding a budget to a role means every machine running that workspace needs the newer plugin.

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
| `defaultMaxToolCalls` | `0` | Tool-call budget for a role whose file declares none. `0` means unlimited, which stays the default on purpose: a 2,277-file repository and a small project disagree about what a reasonable call count is, so the number belongs in the role file. |
| `maxToolCallsHardCap` | `0` | Ceiling a role file cannot exceed, so a project cannot open a budget to a meaningless size. `0` disables the ceiling, and never clamps an explicit `maxToolCalls: 0` — "unlimited" is a sentinel, not the number zero. |
| `onToolCallBudget` | `wrap-up` | Row default for the exhaustion posture; a role file overrides it. |
| `graceToolCalls` | `1` | Row default for the grace calls; a role file overrides it. |
| `enableListTool` | `false` | Register the diagnostic tool. |
| `listToolName` | `subagent_roles` | Name of the diagnostic tool, so a second row can coexist with the first. |
| `childPromptTrim` | `full` | Trim a SUBAGENT's prompt: `full` drops tool guidance the child cannot use PLUS the named prompt parts, `tools` keeps the named parts, `off` disables the listener. A top-level agent's prompt is never touched. |
| `childPromptTrimNames` | `['harness:source', 'app:web-surface', 'ui:deliverable-file-references', 'context:file-reference']` | Prompt parts `full` mode drops, matched against sections AND contexts. Empty the list to keep them all. |

## Tool policy

A role's policy decides which tools its child can see and call. `tools` (and `toolFilter.allow`) is an allow list: everything not listed disappears from the child — schema and prompt guidance together — and calls to it are refused. `toolFilter.deny` removes named tools while keeping the rest. Entries accept the glob characters `*` and `?`, e.g. `mcp__demo__*`.

Globs are expanded at delegation time against the tool names visible to the delegating agent, so a name that is not registered yet cannot fail the delegation. An unavailable literal name is dropped with a warning; `onMissingTool: 'error'` turns that into a refusal instead. An allow list that expands to nothing is passed through as an empty allow list, which hides every inherited tool rather than granting everything.

Two cases are handled explicitly:

- `run_code`, the presentation transport for PTC deployments, is never passed to a policy: the tool registry can list it, but the core refuses to restrict by that name.
- Tools that the delegating agent registers in its own scope are inherited by the parent but are not part of a child's scope chain. Naming one makes the core reject the child. The plugin drops those names, retries the delegation once, and warns.

## Tool-call budget

A role file's `maxToolCalls` is a **hard** cap the plugin enforces; it never relies on the child cooperating. The count comes from the framework's own `tool/call` events, never from the child's self-report and never from parsing its output.

### What counts as one call

The unit is **calls, not turns** — the ambiguity that made an earlier verbal "8 steps" guard meaningless in practice:

| Situation | Counts as |
|---|---|
| Parallel calls inside one step | one each |
| A call the scheduler appended before a policy/guard denial | 1 |
| A call skipped because the run was cancelled mid-step | 1 |
| The wrap-up notice itself (a message, not a tool call) | 0 |
| A child's own sub-delegations | only the child's own calls; each grandchild is budgeted separately |

`used === limit` is **not** a breach. The call that crosses the limit is, and enforcement is reactive: that call is already in the session log, so the child is stopped before it finishes. The guarantee is "the child stops", not "the crossing call never starts".

### What happens at the cap

| Posture | Behaviour |
|---|---|
| `wrap-up` (default) | Deliver the plugin-attributed notice ("budget exhausted — produce your partial conclusions"), then tolerate `graceToolCalls` further calls before stopping the child. |
| `interrupt` | Deliver the same notice and stop the child on the crossing call itself. |
| `off` | Warn once and never stop — and therefore write nothing durable into the child session. |

`graceToolCalls: 0` is exactly `interrupt`: the same notice and the same stop, on the same call.

The stop mechanism depends on how the delegation runs, and this is a core detail worth knowing: `SubagentRuntime.interrupt()` is an accepted **no-op for a one-shot run**, so a foreground or background one-shot child is stopped through the signal its run was started with, and only a `continuable` child is interrupted through the runtime. A remote transport that publishes no local child agent runs its child outside this process, so its tool calls are neither counted nor stopped — the plugin warns at delegation time instead of pretending the role is guarded.

### How the child is told, and how the parent is told

The notice is a `user`-role message carrying an explicit `plugin` source, delivered through `Agent.inject()` so it lands at the next step boundary **without waking an idle child into a fresh turn**. The explicit source matters: an omitted source resolves to `user`, which would let a machine-generated instruction impersonate human input.

That same notice is the **durable record of the stop**: it carries `used`/`limit`/`scope`/`mode` into the child session's own log, so a stopped delegation can be replayed — *where did it stop, and how much was left*. It is therefore delivered on **every** stop, `interrupt` included, not only under `wrap-up`; a bare host log line cannot answer that question for a child that was killed. `off` is the one posture that never stops anything and so writes no child-session record.

A stopped **foreground** delegation returns a normal, structured result — `status: 'tool-call-budget-exceeded'`, plus `reason`, `role`, `used`, `limit`, `scope`, `mode`, and any `partialOutput`. It is deliberately not an error: a thrown error reads as a retriable tool fault, whereas what the delegating agent should choose is a narrower task, a raised budget, or the partial result. A **background** delegation settles its job with a detail naming the budget stop, so it cannot be mistaken for a user kill.

`timeoutMs` and the budget are orthogonal guards. Whichever fires first owns the report: a budget stop is the structured result above, while a deadline keeps the core's own `TOOL_TIMEOUT` error. The two are never merged into one failure.

## Diagnostics

Enable `enableListTool` to register `subagent_roles`, which reports every role with its source, file path, bound route, persona size, the expanded policy, its schema-character budget, and its **tool-call budget with its provenance** (role file / row default / unlimited), plus any file that was skipped and why.

To inspect a finished delegation, read the child's session log:

```sh
node scripts/inspect-session-budget.mjs --project <project-dir>
node scripts/inspect-session-budget.mjs <session-dir> --all --grep "You are a code reviewer"
```

The script decodes a session log read-only and prints the system-prompt size, the tool schemas the session requested, and whether the role catalog reached that session.

## Settings

> **On DSH 0.2.0+ the card stands down and the row `config` is the channel.** 0.2.0 removed the client `settingsScope` service together with plugin-registered settings namespaces, so the card described below does not mount there; the plugin logs a single `settings card skipped: …` line instead. That is deliberate: a REQUIRED-but-absent service leaves the row `pending`, and one unactivated row fails the entire web boot. The Host half is unaffected — set the same keys on the plugin's mount row `config` in the profile patch (see below). Pre-0.2.0 builds behave exactly as before.

The trim policy **and the tool-call budget** are published as one host settings namespace (`subagent-roles`) and paired with a card in **Settings → Plugins**, so a deployment can retune them without editing files. The row config is the namespace's `base` layer; on pre-0.2.0 builds the card writes the user layer to `~/.dsh/settings.yaml`, and the change applies to the next child turn (`applies: live`) with no restart. The budget knobs are `defaultMaxToolCalls`, `maxToolCallsHardCap`, `onToolCallBudget`, and `graceToolCalls` — the same names the row config takes. A role file's own `maxToolCalls` still wins; the settings layer supplies the default a role file omitted.

The card draws its own chrome, which the host requires of any browser half, following the host's `PluginCard`: a collapsible header (title, description, rotating chevron), an unsaved badge, the staged form, and Reset / Discard / Save in the footer, styled with the host's own rules and the same `--dsw-alias-*` tokens as the bash, agent-loop, subagent-model-selection, and web-search cards. Two deliberate deviations: the badge is hand-drawn instead of the host's `Tag` primitive, and the failure line uses `--dsw-alias-state-error-primary` (the host's own `--dsw-alias-label-error` is not defined in the installed theme).

Editing follows the host's card conventions: every control renders staged text, nothing is written before Save (the settings scope fences the write with the revision the draft read), Discard drops the drafts, and a reset only STAGES the composed default — the write it performs is a clear, so the field re-inherits the deployment config instead of pinning today's default as an override. A field whose staged text still equals the resolved value is not written at all, so editing one field never pins the other. Editing a field cancels a reset staged for it. A clean save collapses the card; a failed save stays open with the drafts intact and the header's unsaved badge visible.

All copy follows the **Language** setting: the card registers its own locale dictionaries (`zh` / `en`, identical keys) and declares `locale: <namespace>` on the registration, so the renderer binds `t` for it. With no locale service it falls back to its own binding, then to the English dictionary — never to hard-coded bilingual labels.

The card edits the same keys the row config takes. Two pairing rules come from the host, not from this plugin: the Plugins tab dispatches one slot key per served namespace and renders only the cards registered under those keys, which is why the plugin ships a browser half (`lib/client.js`, declared through `dsh.client` and `exports["./client"]`); and a card whose namespace the deployment does not serve is never dispatched. A deployment that mounts a second row under a renamed tool gets the namespace `subagent-roles-<tool>` — that one has no card (the browser half binds the default key), so tune it in that row's `config` directly (pre-0.2.0: `settings.yaml`).

A deployment without a settings provider keeps the row config as the sole authority; a namespace that refuses to register (an invalid stored section, a duplicate from another row) is logged and degrades to the row config rather than costing the trim.

## How it works

- **Catalog.** One prompt section, rendered per assembly, lists the roles of the assembling agent's workspace: a framing line plus `- <id> (<displayName>): <description>` per role. It renders empty — and costs nothing — when a project has no roles, when the catalog is switched off, when the agent is a subagent, or when the delegation tool is not visible to that agent.
- **Delegation.** `subagent_role` resolves the role against the delegating agent's working directory, then starts a child through `ctx.subagents` with the role's persona, route, and tool filter. The model-facing wording follows the transport provider: a fork provider already seeds the child with this conversation's completed turns, so the tool says to build on them instead of demanding a fully self-contained prompt. The route is preflighted through `llm.resolveCallConfig()` before the child exists, so a typo in a role's `model` or `reasoningEffort` is reported to the delegating agent rather than thrown from inside child creation.
- **Multiple rows.** The catalog section and the diagnostic tool are named after the row (`<toolName>:catalog`, `listToolName`), so a profile can mount a second row for another transport provider (`toolName: subagent_role_fork`) without either registration colliding.
- **Child prompt trim.** Core registers most tool-guidance sections as plain text — only `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-web`, and `dsh-file-reference-local` evaluate the scope — so a child keeps paying for guidance whose tool the role's policy hid from it, plus the Web GUI, harness-checkout, and deliverable instructions it can never act on. One host-plane `system-prompt/assemble` listener drops exactly that dead text: `tool:<name>` guidance for a registered tool the child cannot see, group guidance (`tool:jobs`, `tool:goal`) when every tool its own text names is invisible, and — in `full` mode, the default — the named prompt parts. The rule-derived part needs no maintenance; the named part is per-row overridable because whether a child should still see the harness-checkout or deliverable line is a deployment judgement, not a fact. One list covers both arrays on purpose: the installed core registers `context:file-reference` as a SECTION despite its name, which a contexts-only list silently let through. Measured on a real delegation: a role child's prompt went from 5,765 to 1,904 characters (−67%) while the parent's stayed byte-identical.
- **Inheritance.** A child joins its parent's agent preset, so it keeps the parent's prompt and tools except where the role's policy removes them. The role persona shadows the deployment persona prefix for that child only.
- **Tool-call budget.** One host-plane `session/event` observer per row counts the committed `tool/call` events of every child Session the row started, plus a `session/disposed` release so a finished child's record does not linger. A delegation arms a record when it starts — `0` (unlimited) arms nothing, so an unbudgeted role pays nothing. Crossing the limit delivers one plugin-attributed notice through `Agent.inject()` (which doubles as the durable audit record), and a stopping posture then ends the child either through its run signal (one-shot) or `SubagentRuntime.interrupt()` (continuable). Enforcement is gated to once per turn, so the calls a stopped batch never started cannot repeat one stop. The count is keyed by child session id, so parents, siblings, and grandchildren never share one.

## Limitations

- Tools registered into a child's own scope are not affected by a role's tool policy; the core applies restrictions to inherited tools only. The delegation runtime and some tool plugins register per agent, so a child can end up with a small number of tools beyond its allow list.
- Hiding a tool removes its schema and any scope-aware prompt guidance. Prompt sections with static text stay in the child's prompt — which is what `childPromptTrim` removes, and why `tools` mode needs no maintenance while `full` mode matches section names that a future core release may rename (a renamed section stops being trimmed; nothing breaks).
- A role persona replaces the deployment persona prefix for the child. The persona suffix, such as the working-directory line, is kept.
- `respectModelSelection` prefers the policy a Session captured (the same durable projection the official delegation tool writes) and falls back to the live `subagent-model-selection` setting, which is what seeds a fresh Session. A change therefore applies to Sessions that have not captured a policy yet.
- The plugin contributes one card (Settings → Plugins → Plugin configuration) and no Settings navigation group of its own. A card is the host convention for plugin configuration; a dedicated section like the plugin market's exists because that plugin owns a whole browsing page.
- `childPromptTrim: 'off'` in the row config unmounts the Settings card with the trim: no namespace is registered, so the Plugins tab has no key to dispatch (deliberate — an operator's `off` is a kill switch the UI must not be able to flip back). The tool-call budget rides that same namespace, so `off` also removes the budget knobs from Settings; budgets then come from role files and the row config only. To stop trimming while keeping the card, set the CARD's mode to `off`, or use `tools` in the row config.
- The Settings card covers the default row's namespace (`subagent-roles`). A second row renamed through `toolName` owns a different namespace and therefore shows no card.
- `childPromptTrim` applies to EVERY subagent assembly the host plane observes, not only to children this plugin started: the runtime records no role marker on a child, so `subagent` and counterpart rows benefit too. Tools registered in an agent's own scope (`subagent`, `list_agents`) are absent from the registry's global view, so their guidance is never trimmed — a child that really can call one keeps its instructions.
- The delegation tool declares no `timeoutMs` unless you set one; an unbounded foreground delegation can outlive the conversation that started it. Bound long runs with `timeoutMs`, `maxDepth`, or the dispatch prompt.
- The tool-call budget is enforced **reactively**: the call that crosses the limit is already in the session log, so the child is stopped before that call finishes rather than being prevented from starting it. The count itself is exact.
- A remote transport that publishes no local child agent (`SubagentRun.localAgent` is undefined, as with an out-of-process provider) runs its child outside this process, so its `tool/call` events never reach the guard: the budget can neither count nor stop that child, and the notice cannot be delivered. The plugin warns at delegation time rather than reporting a role as guarded when it is not. In-process transports are unaffected.
- `timeoutMs` and the budget are independent, and so are the ways they surface — but if a budget stop has already begun and the tool-call deadline then expires while the stopped run is still being torn down, the core's own timeout wrapper replaces the result with its `TOOL_TIMEOUT` error. The child is stopped either way; only the report can be the later guard's.
- `scope: session` enforcement is gated to once per turn: an over-budget continuable child that a parent wakes again is stopped again, but the calls a stopped batch never started do not each repeat the stop.
- Conversely, per-turn gating means a `scope: delegation` budget that has already fired stays quiet for the REST of that turn even if `used` keeps rising; the next turn starts a fresh count (and a fresh stop).
- The monitor's record table is bounded (256 entries) and evicts by **insertion order, not by use** — it is a leak backstop, not the lifecycle. Records are normally released when their child session is disposed or their delegation settles, so an eviction should only ever reach an abandoned entry; a live entry evicted under extreme churn would lose its cap silently.
- `maxToolCallsHardCap` does not bound an explicit `maxToolCalls: 0` / `defaultMaxToolCalls: 0`. `0` is the "unlimited" sentinel rather than a count, so the escape hatch outranks the ceiling by design — use the ceiling to scale back a declared number, not to forbid "unlimited".
- A role's budget is counted per child session. Two concurrent delegations of one role never share a count, and `scope: session` keeps counting across the wakes of a continuable child until the row unloads or the bounded record table evicts it.
- The per-role budget is **not** advertised in the role catalog — only `subagent_roles` reports it, so the prompt cost of a budgeted role is unchanged.
- Discovery caches are bounded (512 entries), so a very large number of distinct projects in one host process re-stats files more often than it otherwise would. Results are unaffected.
- The diagnostic script needs Node.js 22.15 or newer for multi-frame zstd decoding; the plugin itself runs on Node.js 20.

## Development

```sh
npm test                                      # unit tests (node --test)
npm run lint                                  # node --check over lib/, scripts/, test/
node --test --experimental-test-coverage      # per-file coverage
```

The runtime lives in `lib/`: `roles.js` (discovery and parsing), `catalog.js` (catalog text), `policy.js` (tool policies), `route.js` (LLM route), `budget.js` (tool-call budget resolution and counting), `tool.js` (delegation and diagnostic tools), `config.js` (row options), `settings.js` (the settings namespace), and `index.js` (plugin wiring).

CI runs `npm run lint` and `npm test` on Node.js 20, 22, and 24.

### Releasing

1. Add a `## [<version>]` entry to `CHANGELOG.md` (written in Chinese). The publish workflow refuses to ship a version the changelog does not document.
2. `npm version <patch|minor|major>` commits the bump and creates the tag; push the commit and the tag.
3. `.github/workflows/publish.yml` then runs the tests, checks that the tag matches `package.json`, checks the changelog entry, and publishes through npm trusted publishing (OIDC) with a provenance attestation, so no long-lived token is stored in the repository.

Register `publish.yml` as a trusted publisher on the package's npm settings page before the first automated release.

## License

MIT
