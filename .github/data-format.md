# Data format — `work-balancer`

**When to read me:** before touching the store (`src/store/`), adding or changing any event type, or writing anything
that reads `data/`. This is the canonical, versioned list of record types; keep it in sync with
[`src/store/records.ts`](../src/store/records.ts) and the code that writes each type. Rules for the data itself
(append-only, never delete, privacy) are in [copilot-instructions.md §6](./copilot-instructions.md#6-data-rules-the-owners-data-is-precious--treat-it-like-a-production-database).

---

## 1. Files

- Live: `data/YYYY-MM/YYYY-MM-DD.jsonl`; dev: `var/dev/data/…`; tests: `var/test/<tmp>/…`.
- `YYYY-MM-DD` is the **day key** (04:00-bounded local day — `src/core/time.ts`).
- One JSON object per line, `\n`-terminated. A torn last line (crash mid-write) gets a `\n` prepended by the next
  append and is then skipped by readers with a logged warning.
- **Routing** (`aboutTime()` in `records.ts`): records *about a time* go to the file of the day they describe (even if
  written later): `minute` → `minute`; `monitor.gap`, `inactivity.resolved` → `from`; `inactivity.detected` →
  `lastInputAt`; `system` → `ts`. Everything else (entities, actions) goes to the file of the **current** day.
  Writers split intervals that cross 04:00 into one record per day (gaps are clipped to their day).
- **Git** (ledger D-72): the live daemon auto-commits *settled* day files — new/changed files whose mtime is before
  yesterday's 04:00 (no record has touched them for over a day) — and deleted day files, once per 04:00 day, on
  `main` only (amending a pure-`data/` HEAD; constant message `data: auto-commit day files`), then pushes that
  one commit with an exact `--force-with-lease` (`src/daemon/data-commit.ts`). A later late record just makes the file
  eligible again. Bulk deletions (> 2 in one run, or a whole month folder) and changes that are not an append to the
  committed version are never auto-committed (menubar warning; commit deliberate ones by hand). Files are never rewritten. The GitHub repo is public: pushed data is public.

## 2. Common fields

Every line: `{ "v": <schemaVersion>, "ts": <epochMs>, "type": "<type>", ... }`. Current schema version: **1**.
`ts` = when the record was written, except `system` where it is the event time (Lua's timestamp).
Readers ignore unknown `type`s and unknown fields, and accept any `v` (fields are only ever added).

## 3. Record types (v1)

Status: **written** = implemented; **planned** = designed, not yet written by any code (milestone in brackets).

| `type` | Fields | Status | Notes |
|---|---|---|---|
| `daemon.started` | `pid`, `version`, `env`, `reason` | written (M3) | Written before `config.loaded` of the same start. |
| `daemon.stopped` | `pid`, `reason` | written (M3) | Missing after a crash — gaps are derived instead. |
| `monitor.gap` | `from`, `to`, `cause` (`daemon-down` · `quit` · `hs-down` · `stall`) | written (M4) | Unmonitored time, written when detected: a hole > 30 s in Lua's sample coverage, minus sleep. `daemon-down`/`quit` = the hole began before this daemon started (samples were lost, e.g. a crash before minutes were flushed); `hs-down` = Lua was not sampling. A daemon outage while Lua runs is **not** a gap: Lua's outbox re-delivers the samples. Split per day. `stall` is reserved. |
| `minute` | `provider`, `minute` (MinuteKey = epoch ms floored to 60 000), `data` | written (M4: `interactive`) | Raw providers only (`work` is never persisted). **Last record per `(provider, minute)` in file order wins.** |
| `system` | `event` (`sleep` · `wake` · `lock` · `unlock` · `display-sleep` · `display-wake`) | written (M4) | From Lua's `hs.caffeinate.watcher`; `ts` = event time. The daemon may also write a **synthetic** `lock`/`unlock` (heartbeat's `locked` flag disagrees with the timeline) or `wake` (a heartbeat arrives while the timeline says asleep), at the receiving time. Lock/unlock and sleep/wake pairs give the intervals that cut busy time. |
| `inactivity.detected` | `gapId` (`g-<lastInputAt>`), `lastInputAt` | written (M9) | After `busyGraceMin` without input + the ~10 s pre-warning dim not cancelled, on a day with `inactivityDialog`, live gate open, not blocked. At most one unanswered gap at a time. |
| `inactivity.resolved` | `gapId`, `from` (= lastInputAt), `to`, `choice` (`back` · `whole` · `some` · `expired`), `creditedMinutes` | written (M9) | `to` = the owner's return — the first input **not** made while the dialog was on screen (D-56: input over the dialog does not end the gap; it ends at Submit) — clipped to the gap's day; `expired` at the next 04:00. Credit = `[from, from + creditedMinutes)` (incl. locked/asleep time, D-19); inside `[from + grace, to)` only the credit counts (dialog fiddling is not work). Later resolution of the same gap replaces earlier. |
| `policy.transition` | `from`, `to` (`ok` · `orange` · `warn` · `countdown` · `blocked`), `configHash` (latch key `<config hash>@<daemon version>`), `workedMin`, `limitMin` (null on non-enforcing days), `weekMin` | written (M6) | Ladder level changes only (one per change; a restarted daemon resumes from the day's last record; each day starts at `ok`). |
| `token.used` | `minutes`, `until` | written (M10) | A postpone token, used from the block (only while `blocked`, only an unused size of `tokensMin`). `until` = `max(current grant until, ts) + minutes`, clipped to the next 04:00 (`grantUntil()`); the evaluator folds today's records (each clipped to `[ts, 04:00]`). |
| `bypass.used` | `minutes`, `until`, `reason` | written (M10) | The emergency bypass (R-POL-4): the sentence retyped (case/spacing/punctuation ignored), `reason` (trimmed, 3–500 chars — the owner's words, like notes). Same `until` arithmetic. Repeatable. |
| `budget.forfeited` | `remainingSeconds`, `by` (`countdown`) | written (M10) | The owner pressed Save in the countdown (owner, ledger D-60): the rest of today's budget is given up — `blocked` until 04:00 (tokens / bypass still work). Only written by a save that kept something. |
| `effect.shown` / `effect.closed` | `effect`, `windowId`; `closed` also `by` (`user` · `page` · `system` · `panic` · `failopen` · `load-failed` · `reload`) | written (M7) | Only for effects with `audit: true` (M8: `quick`, `notes`, `summary`, `quit`, `review`; M9: `inactivity`; M10: `warn`, `countdown`, `block`, `nudge`; `test` windows are never logged). M10 reads them back: a `warn` closed by `user`/`page` after its level entry = dismissed; a `nudge` closed by `user`/`page` = snoozed; today's `effect.shown` let a restarted daemon re-show a window without R-UI-QUIET deferral. `shown` when Lua first reports the window; `closed` once per Lua close report (deduped by id + time), or `reload` when an audited window vanished without a report. An `effect.closed` for `review` by `user`/`page` = the morning review is done for that day. |
| `note.created` | `noteId` (`n-<epochMs>-<6 hex>`), `kind` (`context` · `feedback` · `note`), `text` (trimmed, ≤ 4000 chars; may be `""` for a feedback note), `choices?` (feedback only; only values from the policy's `feedbackChoices`), `energy?` (feedback only; integer 1–5), `source` | written (M8) | `source`: `quick` · `countdown` · `block` · `review` · `manager`. Current day's file. |
| `note.edited` / `note.dismissed` / `note.undismissed` | `noteId`, (`text` for `edited`) | written (M8) | Event-sourced; state = fold of all `note.*` records over **all** day files in order (`src/notes/notes.ts`; unknown ids / duplicate creates ignored). Edits change the text only. No delete (ledger D-36): "removing" a note = dismissing it. A no-op (same text, already dismissed) writes nothing. |
| `report.submitted` | `day` (target day key), `energy` (required integer 1–5), `choices` (configured values, ≤ 20), `text` (trimmed, ≤ 4000 chars) | written (D-69) | A daily energy report, separate from optional feedback notes. `ts` is the submission time; appended to the **submission day's file**, even for an older target `day`. |
| `report.skipped` | `day` (target day key) | written (D-69) | Explicitly confirmed skip; no energy score is invented. Same submission-time routing. A later submission can fill the skipped date. |
| `config.loaded` | `hash`, `source` (`file` · `snapshot`) | written (M3) | |
| `config.invalid` | `errors` | written (M3) | |
| `day.rollover` | `fromDay`, `toDay`, `review` (bool) | written (M8) | Once per day, on the daemon's first tick of the day (04:00, the first tick after a wake, or a start on a day without one). `review: true` = a morning-review day (policy `morningReview`) with notes waiting at that moment: it decides the day's morning review (R-UI-REVIEW). |
| `panic` | `by` (`hotkey` · `cli` · `unknown`), `at` (when the latch was set) | written (M3) | Logged once per latch transition (a restarted daemon restores today's state from these records). |
| `resume` | `by` (`cli` · `rollover`) | written (2026-10-05) | The panic latch was cleared: `WorkBalancer.resume()`, or the daemon expired it at 04:00. |
| `app.quit` | `by` (`menu` · `cli`) | written (M8) | Lua's quit (menu → confirm, or `WorkBalancer.quit()`) asked the daemon to stop; followed by `daemon.stopped` with reason `quit`. |

### Daily reports

[`src/reports/reports.ts`](../src/reports/reports.ts) folds valid `report.*` events across **all** files; the last
event for a target `day` wins. Identical resubmissions write nothing; failed writes leave the previous state intact.
Missing dates are derived from **every calendar day** from `dailyReportsStartDay` (inclusive), not from activity or
existing files. Initial activation: **2026-10-06**; absent/null disables reports. Date age uses civil calendar days
(DST-safe); the 04:00 boundary applies. Skip confirmations expire after 60 s and are cancelled by a restart.
`effect.shown`/`effect.closed` for `review:fresh` delimit mandatory welcome interaction, excluded from worked time and
inactivity credits in both live and historical reconstruction. Ordinary notes review and voluntary reports do not
change work accounting. The `reports` catch-up window is also audited.

For `review:fresh`, `effect.shown`/`effect.closed` carry optional `at` = actual Lua lifecycle time; `ts` remains
the audit write time. Lua reports `ui.windowOpenedAt` and retains `openedAt` in close reports, including a window
completed before its first shown heartbeat. Never derive appearance from a command request: a lost reply means
the window did not appear. Exclusion ends at the close **or the first loss of continuous sensor coverage**, whichever
is earlier; `monitor.gap` clips rounded historical coverage. This prevents a delayed reload audit from erasing real
work done after an overlay crashed.

### 3.1 `minute` data per provider

**`interactive`** (R-INFO-2) — one record per monitored minute, **except** minutes without input that were entirely locked and/or asleep (ledger D-31: each provider decides which minutes deserve a record; the `system` lock/sleep records already describe those; once a minute has a record, later corrections are still written):

| Field | Meaning |
|---|---|
| `inputs` | Input runs inside this minute: `[[fromOffsetMs, toOffsetMs], …]` (closed), offsets relative to `minute`. A run joins observed input instants ≤ 2 s apart (exact for the busy union because the grace window ≫ 2 s); a single instant is `[x, x]`; a run crossing the minute end is split (`…, 59999]` / `[0, …`). Instants come from `hs.host.idleTime()` (whole seconds) sampled every second ⇒ ±1 s. |
| `activeSeconds` | Distinct whole seconds of the minute touched by an input run (0–60). |
| `lastInputAt` | Epoch ms of the end of the last input run in this minute (`minute + 59999` if the run continues into the next minute). |
| `topApps` | ≤ 3 apps by foreground time in this minute, each ≥ 5 s: `[{ "id": bundleId, "name": appName, "s": seconds }]`. |
| `categories` | *(since 2026-10-05, D-67)* Foreground seconds per **app category** in this minute: `{ "Work": 48, "WhatsApp": 12 }` (locked/asleep time excluded; all seconds, no threshold). The category comes from the owner's `config/categories.ts` `categorize()` (bundle id, app name, window title) **when the interval arrives** — later edits of that function do not change history. Insight only: **no time logic reads it**. Window titles are never stored. Older minutes have no `categories`. |
| `lockedSeconds`, `asleepSeconds` | Seconds of this minute with the screen locked / the Mac asleep. Locked/asleep time is not counted as app time. |

On disk, zero / empty / `null` fields are **omitted** (a fully locked minute is `"data":{"lockedSeconds":60}`); readers
default them. A minute is written ~70 s after it ends (and the partial current minute on a graceful stop); a later
record for the same minute (late samples, a restart) replaces it. App
`topApps` of a minute loaded from disk are kept when re-emitting (raw app intervals are not persisted; per app the
larger second count wins).

**`prompt-history`** (R-INFO-4, M5) — one record per minute with ≥ 1 classified interaction (rules:
[copilot-history-formats.md](./copilot-history-formats.md) §3). **Counts and times only — never text, never hashes.**

| Field | Meaning |
|---|---|
| `prompts`, `answers` | Human prompts / human answers to agent questions (`ask_user`, VS Code question carousels). |
| `unclassified` | Undecidable interactions (retries, runner follow-ups without corroboration, missing turn rows, cancelled asks) — never counted as human. Before daemon 0.7.1 (ledger D-64) `github/cli` prompts were counted here; since then they are `automated`. |
| `automated` | Runner, subagent, system, `github/cli` (since 0.7.1) and other non-human prompts (insight only). |
| `at` | Offsets (ms from `minute`) of the human prompts and answers — activity instants for the `work` digest (each counts like an input instant). VS Code answers read on a catch-up scan carry their request's time (a lower bound). |
| `bySource` | Human interactions per store: `{ "cli": n, "vscode": n }`. |

Omitted when zero/empty. A minute is re-emitted (last wins) when late classifications change it, never with fewer
interactions than its persisted record. Only interactions at/after the day start of the daemon's start are read from
history; a restart re-scans today's history files (no persisted cursors — D-44).

## 4. Changelog

| Version | Date | Change |
|---|---|---|
| 1 | 2026-10-04 | Initial (M2). |
