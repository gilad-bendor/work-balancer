# Copilot Instructions — `work-balancer`

This file is loaded into **every** Copilot session in this repo. It holds the stable knowledge:
**why** the project exists, **how** it is built, and **how sessions must behave**.
The volatile knowledge — what is done, what is next, decisions, open questions — lives in
[ledger.md](./ledger.md).

> **Session start checklist (mandatory, every session, even trivial ones):**
> 1. Read this file fully (you are doing it).
> 2. Read [ledger.md](./ledger.md) fully — it is the source of truth for status, requirements and decisions.
> 3. Read any topic file under `.github/*.md` that the ledger or the [Topic index](#11-topic-index) marks as relevant to your task.
> 4. For any non-trivial task: open your **session tmp-folder** (see [§8](#8-session-tmp-folder)).
>
> **Session end checklist:** update [ledger.md](./ledger.md) (see [§9](#9-the-ledger-protocol)) — a session that changed the
> project but not the ledger is **not done**.

---

## 1. Why this project exists (the intent — read this, it drives every design choice)

The owner is a software engineer whose work is now done almost entirely by prompting AI agents
(Copilot / Claude) in VS Code. He has diagnosed ADHD and some perfectionist / OCD-like tendencies.
The resulting pattern:

- He works **too many hours**, very **intensely**, and is absorbed — "the next prompt is burning inside me".
- AI removed the natural pauses of work (compiles, reviews, waiting for colleagues); the agent never tires.
- The prompt → result loop is a **variable-reward loop** (ADHD-sensitive); "it looks nice but is it really good?" adds
  verification loops; a background "I am not good enough" feeling adds "one more prompt".
- Outcome: exhausted at the end of each day, **depleted at the end of the week**. Friday (his private-project day)
  and Saturday (Shabbat — he is an orthodox Jew) are spent recovering instead of living.

`work-balancer` is a **pre-commitment device**: the calm, rested owner configures limits in advance; the system enforces
them on the absorbed, depleted owner — with **friction, not prohibition**, and with **kindness, not shame**.

The thing being protected is **energy for Friday and Saturday**, not "hours" per se. Hours are the measurable proxy.

### Design principles (non-negotiable — apply them to every feature, wording and default)

1. **Close the loop instead of cutting it.** Every stopping point offers a place to *park* the burning thought
   ("context-memory for tomorrow"). An open loop that has been written down stops burning (Zeigarnik effect).
2. **Friction, not prohibition.** Blocks are real, but there are always honest, *costly*, *logged* exits
   (postpone tokens, emergency bypass). The owner is a hacker: anything that feels like a cage gets disabled.
   Something that feels like a fair contract with himself gets respected.
3. **Kind, neutral, never shaming wording.** No "YOU OVERWORKED!". The owner already carries "not good enough".
   Prefer: "That's today's budget. Friday-you will thank you." Neutral colours; red only as a status colour.
4. **Measure what matters.** Feedback (how am I feeling, what's going on) is a first-class signal, recorded in the
   same data as activity, so trends become visible over weeks.
5. **Never trap the user because of a bug.** Fail **open** on internal errors (with a visible warning), always keep an
   emergency escape hatch, and never leave the screen dimmed or blocked by a crashed component.
6. **Respect the week's shape.** Workdays are **Sun–Thu** (Israel). Friday = private day (personal work is done on a
   *different* computer). Saturday = Shabbat: **no popups, no prompts, nothing** — tracking only.
7. **Everything on this computer is work.** There is no "personal app" filtering. Apps are recorded only as insight.
8. **Small and boring beats clever.** This project must not become another hyperfocus sink. Prefer the simplest thing
   that serves the intent. Zero runtime dependencies is a goal.

---

## 2. Product summary (details and acceptance criteria are in the ledger)

- **Monitor work**: per-minute info from *info-providers* (v1: `interactive` — keyboard/mouse/scroll + top focused apps;
  `prompt-history` — human prompts/answers in Copilot chat history; `work` — a digest deciding "was this a work
  minute"). Future: camera-based fatigue/stress (architecture must allow it; do **not** build it until the ledger says so).
- **Aggregate** per time range (today, this week, a stretch).
- **Policy** (per weekday, configurable): daily + weekly budgets of *worked time* → status ladder
  `ok → orange → warn → countdown → blocked` (until the 04:00 day-boundary), plus postpone tokens and emergency bypass.
- **UI effects**: menubar status (+ left-click quick note, right-click menu), warning dialog, screen dim pulse,
  countdown, full-screen block, inactivity dialog, feedback form, notes manager, 04:00 morning review, activity summary.
- **Data**: append-only JSONL, one file per (04:00-bounded) day: `data/YYYY-MM/YYYY-MM-DD.jsonl`, git-able.

---

## 3. Technology & conventions

### 3.1 Runtime: Node ≥ 26, TypeScript executed directly (no transpilation, no bundler)

- Node runs `.ts` files natively via **type stripping**. `tsconfig.json` never shapes a run; it only powers the editor
  and `npm run typecheck` (`tsc --noEmit`).
- **Erasable syntax only** (`erasableSyntaxOnly: true`): **no** `enum` (use `as const` objects + union types),
  **no** `namespace` with runtime code, **no** constructor parameter properties (`constructor(private x)`),
  no `import x = require()`. Prefer interfaces + plain objects + factory functions over class hierarchies.
- **`verbatimModuleSyntax: true`**: type-only imports **must** use `import type` — a type imported as a value
  survives stripping and crashes at runtime ("does not provide an export named …").
- **`allowImportingTsExtensions: true`**: relative imports name the real file: `import { x } from './store.ts'`.
- ESM only (`"type": "module"`). Top-level `await` is fine.
- Baseline `tsconfig.json` (mirror it; `lib` includes `dom` because UI page scripts are type-checked too):
  ```jsonc
  {
    "compilerOptions": {
      "module": "nodenext", "moduleResolution": "nodenext", "target": "es2024",
      "lib": ["es2024", "dom"],
      "allowImportingTsExtensions": true, "erasableSyntaxOnly": true, "verbatimModuleSyntax": true,
      "esModuleInterop": true, "skipLibCheck": true, "resolveJsonModule": true,
      "strict": true, "types": ["node"], "noEmit": true
    },
    "include": ["**/*.ts"],
    "exclude": ["**/node_modules", ".github/tmp", "var"]
  }
  ```
- Package manager: **npm**. Dev dependencies only: `typescript`, `@types/node` (`^26`). **Runtime dependencies: none**
  unless the ledger records a decision justifying one. Use `node:http`, `node:fs`, `node:test`, `node:assert`, etc.
- Node version is pinned in `.nvmrc` (`26`). Node lives under nvm (`~/.nvm/versions/node/v26.*/bin/node`); Hammerspoon
  does **not** inherit a shell `PATH`, so the daemon is always launched through `scripts/run-daemon`, which resolves
  the newest installed v26 binary by itself.
- Tests: **`node --test`** (built-in runner), files named `*.test.ts` next to the code they test.
  Fixtures under `test-fixtures/`. **Fixtures must never contain real prompt text or real notes.**

### 3.2 Hammerspoon (Lua) — the thin native layer

- Single file: [`hammerspoon/work-balancer.lua`](../hammerspoon/work-balancer.lua), symlinked to
  `~/.hammerspoon/work-balancer.lua`, loaded by **exactly one** line in `~/.hammerspoon/init.lua`:
  `require("work-balancer")`. **Never** add other lines to `init.lua`, never edit other files in `~/.hammerspoon/`
  (the owner has unrelated modules there: `playwright-focus-guard`, `copilot-retry-watcher`, `copilot-chat-opener`).
- **After every edit of `hammerspoon/work-balancer.lua` you MUST run `scripts/reload-hammerspoon`** and check that it
  succeeded (exit code 0, and its health check passed). It also (re)creates the symlink and the `require` line.
  Note: a Hammerspoon reload also reloads the owner's other modules — that is acceptable, but do not reload in a loop.
- Lua is **thin**: sensors (idle time, focused app, sleep/wake/lock), actuators (menubar, webview windows, gamma dim),
  process supervision of the Node daemon, and the transport. **No business logic in Lua.** Every decision lives in TS.
- Expose one global table `WorkBalancer` for introspection through the `hs` CLI
  (e.g. `hs -c 'return WorkBalancer.health()'`). `work-balancer.lua` itself does `require("hs.ipc")` so the CLI works.
- Never block Hammerspoon's main thread: async HTTP only (`hs.http.asyncPost`), no busy loops. `asyncPost` has **no
  timeout/cancel** — keep **one heartbeat in flight** at most, guard it with an `hs.timer` watchdog + generation counter,
  and ignore late callbacks.
- Text input inside `hs.webview` requires `:allowTextEntry(true)` and the window being brought to front as key.
- Restore screen gamma (`hs.screen.restoreGamma()`) on module unload/quit, on daemon death, and after every dim pulse.

### 3.3 Code style

- Small modules, explicit names, pure functions where possible; side effects at the edges (store, bridge, Lua).
- **Inject the clock** (`Clock` interface: `now(): number`) everywhere; never call `Date.now()` in logic. This is what
  makes day-boundary, DST, budget and ladder logic testable.
- Comment only what needs clarification (the *why*), not the *what*.
- User-facing strings: kind tone (principle 3); centralise them in one module so tone can be reviewed in one place.

---

## 4. Architecture

```
 ┌──────────────── Hammerspoon (Lua, thin) ────────────────┐        ┌──────────────────── Node daemon (TS) ──────────────────────┐
 │ sensors: idleTime, app-focus intervals, sleep/wake/lock │──5s──▶ │ Bridge (HTTP 127.0.0.1, token)                              │
 │ supervisor: spawn/adopt/restart daemon                  │ POST   │   ↓                                                        │
 │ actuators: menubar, webview windows, gamma dim          │◀─────  │ Collectors → PerMinuteInfoProviders → Store (JSONL/day)     │
 │ escape hatch (panic hotkey)                             │ reply: │   ↓                                                        │
 └─────────────────────────────────────────────────────────┘ status │ TimeRangeInfoProviders (aggregates)                         │
          ▲  webviews load http://127.0.0.1:<port>/ui/...  +cmds   │   ↓                                                        │
          └──────────────────────────────────────────────────────  │ Policy (config/policy.ts) → PolicyState                     │
                                                                   │   ↓                                                        │
                                                                   │ Effects reconciler: desired UI vs actual → commands         │
                                                                   │ Notes (event-sourced) · Feedback · Inactivity gaps          │
                                                                   │ UI pages + JSON API                                         │
                                                                   └────────────────────────────────────────────────────────────┘
```

### 4.1 Info-providers (the extension point for metrics)

The owner's original concept, kept but expressed in erasable TS (interfaces, not abstract-class hierarchies):

- **PerMinuteInfo** — one record per provider per minute. Key: `MinuteKey` = epoch ms floored to 60 000.
  Either **raw** (`interactive`, `prompt-history`, future `camera`) or a **digest** of other providers' minute info
  (`work`), or both.
- **PerMinuteInfoProvider** — `name`, `dependsOn` (provider names it digests), `start(ctx)`, `stop()`,
  `getMinuteInfo(minute)`. Raw providers persist their minute records via the store; digests may be computed on demand.
- **TimeRangeInfo / TimeRangeInfoProvider** — aggregate of one provider's minute infos over `[start, end)`
  (both `MinuteKey`s), `null` if no data.
- **InfoRepository (registry)** — maps provider name → `{ perMinute, timeRange }`. Type-safety via an interface that
  each provider module **augments** (declaration merging is erasable):
  ```ts
  // core/registry.ts
  export interface ProviderTypeMap {}        // augmented by each provider module
  // providers/interactive/index.ts
  declare module '../../core/registry.ts' {
    interface ProviderTypeMap { interactive: { minute: InteractiveMinute; range: InteractiveRange } }
  }
  ```
- Adding a provider (e.g. `camera`) must require: a new folder under `src/providers/<name>/`, one registration line,
  optionally a Lua/native sensor feeding it. **No change to core, store, policy plumbing or existing providers.**
- **Raw providers persist; digests never do.** `work` (and any future digest) is always computed on demand from raw
  records + events (with an in-memory cache invalidated by new inputs). So adding a provider or fixing digest logic
  retroactively corrects history — no migration, no stale persisted digests.
- Minute records may arrive **late or out of order** (e.g. prompt-history discovers a prompt 40 s after it happened).
  Rule: a provider (re-)emits the **full** record for a minute; readers take the **last** record per
  `(provider, minute)`.

### 4.2 Policy

- Pure function of: config + clock + aggregates + today's events (tokens, bypasses, rollovers) → `PolicyState`
  (`level`, budgets, remaining, tokens left, reasons, next transition).
- **Recomputed from data on every tick and on startup** — therefore restarts, crashes and Hammerspoon reloads can
  never be used to escape a block, and never lose it.
- Config is a **typed TS module** `config/policy.ts` (`export default {...} satisfies PolicyConfig`), validated at load,
  hot-reloaded on change (re-`import()` with a cache-busting query, e.g. `?v=<mtimeMs>`). An invalid config keeps the
  previous one and shows a menubar warning. Every valid config is snapshotted to `var/<env>/policy.last-good.json`;
  on a **cold start** with an invalid config, use that snapshot; if there is none, run **tracking-only** (no
  enforcement) with a visible warning. Never crash-loop on a config error.
- **Kill-switches beat reconciliation.** `panic` and `quit` are Lua-side latches that the reconciler cannot override
  (see ledger R-UI-ESC and R-UI-MENU-3).

### 4.3 Effects (the extension point for UI)

- An effect is a named UI behaviour (`menubar`, `warn-dialog`, `dim-pulse`, `countdown`, `block`, `inactivity`,
  `feedback`, `notes`, `morning-review`, `summary`, `break-nudge`, …).
- **Reconciliation, not imperative calls**: from `PolicyState` + pending UI needs, compute the *desired* set of windows /
  dim / menubar; diff against what Lua reports as *actual*; emit idempotent commands. This makes everything robust to
  restarts, reloads, monitor changes and lost messages.
- UI windows are `hs.webview`s that load pages served by the daemon (`src/ui/`). Pages talk to the daemon's JSON API.
  Page scripts are TypeScript too: the daemon serves them through `module.stripTypeScriptTypes()` (verify availability
  in Node 26; fallback: plain `.js` with JSDoc types + `checkJs`). No bundler, no framework — plain DOM.

### 4.4 Bridge protocol (Lua ⇄ Node)

- Node binds **127.0.0.1 only**, fixed port from config/env (default proposal: `47621`; dev instance uses another).
- Node generates a random token at start, writes `var/<env>/daemon.json` (pid, port, token, protocol version, repo path)
  **atomically** (temp file + rename, mode 0600); Lua reads it; every request carries it. Pages get it via their URL.
- **Mutual exclusion = the port bind.** A second daemon of the same env fails to bind and exits cleanly. No lockfiles
  (they go stale after crashes).
- Lua → Node every **5 s**: `POST /bridge/heartbeat` with `seq` (monotonic per Lua load), `sentAt` (epoch ms), sensor
  samples **with their own epoch-ms timestamps** (idle-time samples, app-focus intervals `[from,to)`, system events),
  and the *actual* UI state. Same machine ⇒ same OS clock, so Lua timestamps are trusted for attribution; Node
  de-duplicates by `seq` and tolerates out-of-order/late delivery. Reply: menubar spec + commands (each with an id;
  Lua acks executed ids in the next heartbeat). Lua also pushes immediately on sleep/wake/lock/unlock, menubar clicks,
  and user-closed windows.
- **Policy clock = Node's `Clock`** (which a dev fake/offset clock may shift; it then shifts incoming Lua timestamps
  by the same offset).
- Protocol version in every message; mismatch → menubar warning "reload needed".
- Supervisor (Lua): on load, **adopt** a healthy running daemon (via `daemon.json` + `/health`) instead of spawning a
  duplicate; otherwise spawn `scripts/run-daemon` via `hs.task`; restart with backoff on death — **unless the `quit`
  latch is set** (intentional stop).
- **Environments:** `live` (default) and `dev`. Every runtime path is namespaced: `var/live/…`, `var/dev/…`
  (dev data: `var/dev/data/`). The **dev daemon is browser-only** — Lua controls only the live daemon. Lua offers one
  safe helper, `WorkBalancer.preview(url)`, opening a window clearly labelled `DEV PREVIEW` (normal level, closable)
  for visually checking a dev page; it never touches live state.

---

## 5. Repository layout (target — create pieces as milestones need them)

```
work-balancer/
├── .github/
│   ├── copilot-instructions.md     ← this file (always loaded)
│   ├── ledger.md                   ← status, requirements, decisions, open questions (read every session)
│   ├── <topic>.md                  ← additional Copilot-oriented topic files (see §11) — ONLY here, flat
│   └── tmp/                        ← per-session tmp-folders (see §8)
├── hammerspoon/work-balancer.lua   ← symlinked into ~/.hammerspoon/
├── scripts/
│   ├── execute-copilot-session     ← (exists) runs a prompt file as a new Copilot session (see §7)
│   ├── reload-hammerspoon          ← ensure symlink + require line, reload, health-check
│   ├── run-daemon                  ← resolve Node 26 and exec src/main.ts (used by Lua)
│   └── check                       ← typecheck + tests (the "is it green?" command)
├── config/policy.ts                ← the owner's editable policy (typed)
├── src/
│   ├── main.ts                     ← daemon entry
│   ├── core/                       ← clock, time (day-boundary, minute keys, weekdays), registry, types, log
│   ├── store/                      ← JSONL append/read, recovery, schema versions
│   ├── providers/<name>/           ← interactive, prompt-history, work (digest), [camera later]
│   ├── policy/                     ← config schema+validation, evaluator, ladder, tokens, bypass
│   ├── notes/                      ← event-sourced notes (context-memory, feedback, free notes)
│   ├── effects/                    ← reconciler + one module per effect
│   ├── bridge/                     ← HTTP server, auth, heartbeat, command queue, JSON API
│   ├── hammerspoon/                ← logic of scripts/reload-hammerspoon (install + reload + health)
│   └── ui/                         ← pages (*.html + *.ts + shared css), strings (tone)
├── test-fixtures/                  ← sanitized fixtures (no real prompts/notes)
├── data/YYYY-MM/YYYY-MM-DD.jsonl   ← the owner's real data (git-able; see §6)
└── var/                            ← runtime only, gitignored; namespaced var/live/ and var/dev/
                                       (daemon.json, logs, cursors, policy.last-good.json, latches; dev data in var/dev/data/)
```

---

## 6. Data rules (the owner's data is precious — treat it like a production database)

- **Day boundary = 04:00 local civil time.** Day key of `t`: take the *local civil* date-time of `t`; if its hour < 4,
  the key is the previous civil date, else the civil date. Day start = the local civil 04:00 of that date, computed with
  calendar operations. **Never** compute it as `localDate(t − 4 h)` (wrong on DST days: Israel switches at ~02:00, so
  only 3 or 5 real hours separate midnight from 04:00). Days may be 23 h or 25 h long — use real timestamps, never
  "24 × 60 minutes". **Week = Sunday 04:00 → next Sunday 04:00.**
- File: `data/YYYY-MM/YYYY-MM-DD.jsonl` where `YYYY-MM-DD` is the **day key** (the 04:00-bounded day). One JSON object
  per line, each with at least `{ "v": <schemaVersion>, "ts": <epochMs>, "type": "<event-type>" }`.
- **Append-only.** Never rewrite, reorder or delete lines in existing files. File routing:
  - Records **about a time** (`minute`, `inactivity.*`, `monitor.gap`) go to the file of the **day they describe**,
    even if written later (e.g. a 03:59 minute discovered at 04:00:30 goes to the previous day's file). So a day's
    activity is fully contained in its own file.
  - Records **about an entity** (`note.*`) and actions (`token.used`, `bypass.used`, …) go to the **current** day's file;
    corrections reference ids from any earlier day. Notes state is a fold over **all** files.
- Readers must be **tolerant**: skip unparsable lines (e.g. a torn last line after a crash) with a logged warning,
  ignore unknown `type`s and unknown fields, and accept out-of-order minute records (last one wins per key).
- Writers: a single daemon process (the port bind is the mutex — see §4.4); appends are **synchronous**
  (`appendFileSync`) so they are serialised by construction; each line `\n`-terminated; if the file does not end with
  `\n` (torn write), prepend one. A write error is never swallowed: log it, show a menubar warning, and fail open.
- **Privacy:** never store prompt text or Copilot output. Prompt-history stores counts/timestamps/source kinds only.
  Notes and feedback text *are* stored (the owner typed them for this purpose).
- Never commit `data/` changes yourself unless the owner explicitly asks; never `git add -A` blindly (it would sweep
  `data/`). **Never** delete or "clean up" files under `data/`.
- **Development and tests must never write to `data/`.** Use the dev instance (§10) whose data dir is under `var/`.
- The canonical, versioned list of event types and their fields belongs in a topic file `.github/data-format.md`
  (create it in the milestone that first writes data; keep it in sync with the code).

---

## 7. Delegating work: `scripts/execute-copilot-session` vs subagents

`scripts/execute-copilot-session` launches a **new, full Copilot session** (natively in VS Code when run from VS Code)
from a **prompt file**, waits for its outcome, and marks the prompt file with the result. Run
`scripts/execute-copilot-session --help` for the full reference; the relevant subset:

| Flag | Use |
|---|---|
| `--model <fragment>` | **Required** (unless `$COPILOT_MODEL` is set). E.g. `claude-opus` for design/implementation, a lighter model for mechanical tasks. |
| `--effort <low\|medium\|high\|xhigh\|max>` | Reasoning effort; default depends on the model. |
| `--context <short\|long>` | Use `long` for sessions that must read many files. |
| `--questions <policy>` | `critical-questions-only` (default) · `free-to-ask` (design/UX decisions where the owner's judgment matters) · `no-questions-allowed` (unattended work). |
| `--night` | Owner is away until morning: more investigation, advance unblocked work. Combine with `--questions no-questions-allowed`. |
| `--extra-prompt <text>` | Extra instructions appended (repeatable). |
| `--title <title>` | Session title (default: the prompt file's `# ` heading). Not with `--concurrency > 1`. |
| `--wait-for-file <path>` | Require an output file (e.g. the session's `report.md`); waited for and must be stable 30 s. |
| `--timeout-seconds <N>` | Bound the wait (default: wait forever). |
| `--no-wait` | Fire and forget (the session marks the file itself when done). |
| `--concurrency <N>` | Run several prompt files in parallel — **only** for tasks that touch disjoint files. |
| `-v --max-attempts 1` | Debugging a launch failure. |

The harness flag is irrelevant here (auto-detected). **Prompt-file state machine** (the tool renames the file):
`foo.md` (pending) → `foo.vscode.launched-<stamp>.md` → `foo.vscode.completed.md` | `foo.vscode.error-<kind>.md`
(`kind`: `launch`, `timeout`, `incomplete`, `blocked`, `unknown`). Re-running over a folder skips marked files; to
re-arm, rename back to `foo.md`.

**When to prefer `execute-copilot-session` over a subagent:**
- The task may **need or benefit from the owner's input** (UX wording, visual verification of a window, policy numbers,
  anything with `ask_user`) — subagents cannot talk to the owner; these sessions can.
- The task is a **self-contained milestone/sub-milestone** that deserves its own visible, resumable session record.
- Long-running or **parallelisable independent** work (disjoint files) — `--concurrency`, `--no-wait`.
- Overnight work (`--night --questions no-questions-allowed`).

Prefer a **subagent** for short, read-only research or mechanical work whose result you consume immediately.

**"tbd files"** — a *tbd file* is a prompt file meant for `execute-copilot-session`:
- Location: inside the **creating session's tmp-folder**: `.github/tmp/<session-folder>/tbd-<NN>-<slug>.md`.
- Must be **self-contained**: goal, context, exact scope (files it may touch), acceptance criteria, how to verify, and
  these mandatory lines:
  - "Read `.github/copilot-instructions.md` and `.github/ledger.md` first."
  - "Your tmp-folder is `.github/tmp/<session-folder>/tbd-<NN>-<slug>/`" (a sub-folder of the parent's).
  - "Write your final report to `<that tmp-folder>/report.md`, ending with a `## Ledger delta` section (exact proposed
    ledger changes). **Do not edit `.github/ledger.md` yourself** — the launching session applies the delta."
- Launch it with `--wait-for-file <its tmp-folder>/report.md` when the parent needs the result.
- **Register every tbd file in the ledger** (§9) when it is created, by its *pending* path. Because the tool renames
  the file, the ledger records the **stem** (`.github/tmp/<session-folder>/tbd-<NN>-<slug>`) — its current state is
  the filename suffix on disk.
- Never run two sessions that edit the same files, `work-balancer.lua` or `config/policy.ts` concurrently, and never
  two sessions that run `scripts/reload-hammerspoon` concurrently.
- **Single ledger writer:** only a top-level session (one started by the owner) edits the ledger; it applies its
  children's `## Ledger delta` sections after reading their reports. If the owner runs several top-level sessions in
  parallel, each re-reads the ledger immediately before a small, targeted edit.

**Subagents** (when used) are stateless: their prompt must begin by instructing them to read
`.github/copilot-instructions.md` and `.github/ledger.md`, and must give them a tmp-folder path.

---

## 8. Session tmp-folder

- Every **non-trivial** session works in a tmp-folder where it may create files freely (scratch scripts, investigation
  notes, captured outputs, tbd files, reports).
- If the prompt provides one, use it. Otherwise create `.github/tmp/YYYY-MM-DD--HH-MM--<kebab-title>/`
  (get the stamp with `date +%Y-%m-%d--%H-%M`). Never use `/tmp/`.
- Committed to git by default (tbd files and reports are referenced from the ledger). Put bulky or throwaway artefacts
  in `<tmp-folder>/scratch/` — gitignored via `.github/tmp/**/scratch/`.
- End-of-session: leave a short `report.md` in the tmp-folder for any session that did significant work (what was done,
  what was verified and how, what remains, surprises).

---

## 9. The ledger protocol

[ledger.md](./ledger.md) is the project's memory between sessions. Rules:

- **Read it fully at session start.** Trust it over your assumptions; if reality contradicts it, fix the ledger.
- **Update it at session end** (and at milestones within long sessions) — top-level sessions only; sessions launched
  from a tbd file return a `## Ledger delta` in their report instead (§7):
  - status of the items you touched (checkboxes + status words: `todo` / `in-progress` / `done` / `blocked` / `dropped`);
  - new **decisions** in the decision log (dated, with the *why*; superseded decisions are marked, never deleted);
  - new/closed **open questions**;
  - new **facts** discovered about the environment (Hammerspoon behaviours, Copilot log formats, macOS quirks);
  - a row in the **session log** (date, tmp-folder, one-line summary, tbd files created).
- Keep it **concise and current**: the "Current status" section must be correct at a glance. Move long explanations to
  topic files (§11) and link them.
- Requirements in the ledger are the owner's; do not silently change them. Propose changes as open questions.

---

## 10. Verification & safety while developing on the owner's live machine

The owner works on this same Mac while sessions develop this project. **Never disrupt him unannounced.**

- **Never trigger a real block, dim, countdown or popup on the live instance** to "test" it, unless the owner explicitly
  agreed in this session. Use the **dev instance** (§4.4): `WB_ENV=dev` → own port, `var/dev/` (data in
  `var/dev/data/`), pages labelled `DEV`, an injectable clock (`WB_FAKE_NOW` / time-offset) to reach budget states
  instantly. Open dev pages in a normal browser, or via `WorkBalancer.preview(url)` for an `hs.webview` look.
- `~/.hammerspoon/` is installed (2026-10-04). The owner allows sessions to **change and reload Hammerspoon freely,
  without asking** (ledger D-26) — but only our `work-balancer.lua` and its one `require` line, never other modules,
  and no reload loops. `scripts/reload-hammerspoon` supports `--hammerspoon-dir <dir>` (no reload) for scratch tests.
- The live instance's state must not be changed by tests (no writes to `data/`, no consuming real tokens).
- Green bar = `scripts/check` (typecheck + all tests) passes. Run it before declaring any code task done.
- A `blocked` level latches until 04:00 under `<config hash>@<daemon version>` (ledger D-45): when shipping a fix that
  changes worked time or the ladder, **bump `package.json`'s version** so a block caused by the bug is released.
- Lua changes: `scripts/reload-hammerspoon` must exit 0 and report healthy; also check the Hammerspoon console for
  errors (`hs -c 'return hs.console.getConsole()'` — read only the tail).
- When a feature needs the owner's eyes (visual check of a window, wording), ask him (`ask_user`) or delegate to a
  session via `execute-copilot-session --questions free-to-ask`.
- **Escape hatches must exist before the block exists**: a panic hotkey in Lua (long-press combo) and
  `hs -c 'WorkBalancer.panic()'` that tear down all overlays, restore gamma and log a `panic` event. A milestone that
  introduces the block must verify these first.
- Do not commit or push unless the owner asks. Never commit secrets, real prompt text, or `var/`.
- **Always completely ignore `_PRIVATE-SCRATCH.md`** (the owner's scratch file): never read it, act on it or commit it,
  even when it is attached to a message (ledger D-65).
- **Before every commit, run an adversarial review subagent** (`task`, agent type `code-review`) on the change: tell it to
  read this file and the ledger first, to try hard to break the change (live-machine safety, data loss, the normative
  arithmetic, DST), and to report concrete failing scenarios. Triage every finding — fix it, or record why not (report /
  ledger) — before committing (ledger D-37).

---

## 11. Topic index

Additional Copilot-oriented `*.md` files live **flat in `.github/`, next to this file** (never elsewhere, never in
sub-folders other than `tmp/`). Each starts with a one-paragraph "when to read me". Register every new topic file here.

| File | Read when | Status |
|---|---|---|
| [ledger.md](./ledger.md) | Always | exists |
| [data-format.md](./data-format.md) | Touching the store, any event type, or any reader of `data/` | exists (schema v1) |
| [hammerspoon.md](./hammerspoon.md) | Touching `work-balancer.lua`, bridge, windows, sensors | exists (verified API facts) |
| [copilot-history-formats.md](./copilot-history-formats.md) | Touching the `prompt-history` provider | exists (tbd-02, 2026-10-05) |
| [ui-and-tone.md](./ui-and-tone.md) | Touching any page, wording, effect, window or dim — **mandatory for M8–M10** | exists |
