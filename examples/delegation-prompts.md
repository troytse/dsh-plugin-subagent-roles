# Role delegation prompts (web verifier)

English | [中文](delegation-prompts.zh.md)

> This is a template: replace the angle-bracket placeholders with your own values.
> Roles are defined in `<project>/.dsh/roles/<id>.md` (frontmatter: `provider` / `model` / `reasoningEffort` / `tools` / `maxToolCalls`; body: persona).
> Editing a role file takes effect immediately — no `dsh web` restart.

---

## 0. What you say to the main agent

**Natural trigger** — the main agent picks the role from the catalog itself:

```text
Use web-verifier to verify the changes to "<page/feature>": run <your E2E command> and report against the full-coverage criteria in <your verification SOP>. Do not drive the browser yourself.
```

**Add boundaries when they matter:**

```text
The verifier only verifies: it does not modify files and does not touch the backend. If a service needs a restart, you (the main agent) do that first.
```

---

## 1. Dispatch template (main agent → subagent)

```text
TASK — state it first: verify with a real browser that <page/feature> still works, and report full coverage.

TARGET
- Project root: <project root>
- Frontend directory: <frontend directory> (dev URL <dev URL>)
- Backend: <backend URL> — read-only for you; do not start or stop it
- Verification SOP (read it first): <project root>/.dsh/skills/<your verification skill>/SKILL.md

STEPS
1. If the project has a lease or mutex convention for shared resources (dev servers, devices): take the lock, refresh its heartbeat after every step, and release it when done. Read-only probes need no lock.
2. Read the project's own instructions (AGENTS.md and friends) and the SOP above, then confirm service state: <status command>.
3. Run the cases: cd <frontend directory> && <E2E command>. Credentials come from the project docs.
4. If the SOP asks for a "feature list → test cases" mapping table, complete it before running, and cover every interactive control on the page: search, filter and reset, every row action, and every control inside drawers and dialogs.
5. Console guard: a [Global Error] or an uncaught exception fails the run. Rate-limit noise (for example 429) may be filtered, but report it when it affects an assertion.
6. If the project is localized: switch language with the real control, assert that the interface text changes, then switch back.

ACCEPTANCE
- The result of <E2E command>, plus a per-item coverage verdict (covered / not covered) in the project's own terms.
- Anything you could not cover must be listed as an explicit "not covered" item with status WAITING; "N passed" on its own is not acceptance.
- On failure, attach reproducible evidence: DOM state, logs, screenshots, or a trace path.

FORBIDDEN
- Modifying any project file — edit/write and shell redirection are out; only the lease directory may be created.
- Starting or stopping the backend, running migrations or database resets, reading or writing the database, seeding data through curl or API calls.
- Starting another dev server or changing ports; do not bypass the project's own start script.
- Calling tools unrelated to the task (other MCP tools, delegation tools, and so on).

REPORT: 1 what you did (start with the tool name and the target path) 2 what you observed (case names, pass/fail, coverage verdict) 3 problems and suggestions 4 status: DONE or WAITING
```

---

## 2. Budgeting a role (plugin >= 0.4.0)

A role file may cap how many tool calls its child gets. Give a read-only explorer
enough to finish the inventory, and a run-time verifier far less — it mostly waits
on commands:

```yaml
---
description: Inventory a cross-cutting change (read-only)
tools: [read, grep, glob, bash]
maxToolCalls: 30          # measured in CALLS, not turns: parallel calls each count
maxToolCallsScope: delegation
onToolCallBudget: wrap-up # inject "wrap up now", then tolerate graceToolCalls more
graceToolCalls: 1
---

You are a read-only explorer. Never modify a file; report findings and open questions.
```

Rules of thumb, from real runs (a 19-call inventory and a 25-call review both blew
through a verbal "8 steps" guard that nothing enforced):

| Role type | Suggested `maxToolCalls` |
|---|---|
| Read-only exploration (>= 5 files) | 30–40 |
| Static review | 40–60 |
| Run-time verification (mostly commands) | 15–20 |
| Omitted or `0` | unlimited — the escape hatch for a very large repository |

Two things worth knowing:

- **The unit is calls, not turns.** Three parallel reads in one step are three calls,
  and a call refused by policy still counts — the child already spent the decision.
- **Crossing the limit triggers**, not reaching it, and that call is stopped before it
  finishes. `graceToolCalls: 0` makes `wrap-up` behave exactly like `interrupt`.
