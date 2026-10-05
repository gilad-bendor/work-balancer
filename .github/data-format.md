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
| `inactivity.detected` | `gapId`, `lastInputAt` | planned (M9) | |
| `inactivity.resolved` | `gapId`, `from`, `to`, `choice` (`back` · `whole` · `some` · `expired`), `creditedMinutes` | planned (M9) | Later resolution of the same gap replaces earlier. |
| `policy.transition` | `from`, `to`, `workedMin`, `limitMin`, `weekMin` | planned (M6/M10) | Level changes only. |
| `token.used` | `minutes`, `until` | planned (M10) | |
| `bypass.used` | `minutes`, `until`, `reason` | planned (M10) | |
| `effect.shown` / `effect.closed` | `effect`, `windowId`, `by` (`user` · `system` · `rollover`) | planned (M7) | |
| `note.created` | `noteId`, `kind` (`context` · `feedback` · `note`), `text`, `choices?`, `energy?`, `source` | planned (M8) | `source`: `quick` · `countdown` · `block` · `review` · `manager`. |
| `note.edited` / `note.dismissed` / `note.undismissed` | `noteId`, (`text`) | planned (M8) | Event-sourced; state = fold over all days. No delete (ledger D-36): "removing" a note = dismissing it. |
| `config.loaded` | `hash`, `source` (`file` · `snapshot`) | written (M3) | |
| `config.invalid` | `errors` | written (M3) | |
| `day.rollover` | `fromDay`, `toDay` | planned (M8) | |
| `panic` | `by` (`hotkey` · `cli` · `unknown`), `at` (when the latch was set) | written (M3) | Logged once per latch transition (a restarted daemon restores today's state from these records). |
| `resume` | `by` (`cli` · `rollover`) | written (2026-10-05) | The panic latch was cleared: `WorkBalancer.resume()`, or the daemon expired it at 04:00. |
| `app.quit` | `by` | planned (M8) | |

### 3.1 `minute` data per provider

**`interactive`** (R-INFO-2) — one record per monitored minute, **except** minutes without input that were entirely locked and/or asleep (ledger D-31: each provider decides which minutes deserve a record; the `system` lock/sleep records already describe those; once a minute has a record, later corrections are still written):

| Field | Meaning |
|---|---|
| `inputs` | Input runs inside this minute: `[[fromOffsetMs, toOffsetMs], …]` (closed), offsets relative to `minute`. A run joins observed input instants ≤ 2 s apart (exact for the busy union because the grace window ≫ 2 s); a single instant is `[x, x]`; a run crossing the minute end is split (`…, 59999]` / `[0, …`). Instants come from `hs.host.idleTime()` (whole seconds) sampled every second ⇒ ±1 s. |
| `activeSeconds` | Distinct whole seconds of the minute touched by an input run (0–60). |
| `lastInputAt` | Epoch ms of the end of the last input run in this minute (`minute + 59999` if the run continues into the next minute). |
| `topApps` | ≤ 3 apps by foreground time in this minute, each ≥ 5 s: `[{ "id": bundleId, "name": appName, "s": seconds }]`. |
| `lockedSeconds`, `asleepSeconds` | Seconds of this minute with the screen locked / the Mac asleep. Locked/asleep time is not counted as app time. |

On disk, zero / empty / `null` fields are **omitted** (a fully locked minute is `"data":{"lockedSeconds":60}`); readers
default them. A minute is written ~70 s after it ends (and the partial current minute on a graceful stop); a later
record for the same minute (late samples, a restart) replaces it. App
`topApps` of a minute loaded from disk are kept when re-emitting (raw app intervals are not persisted; per app the
larger second count wins).

**`prompt-history`** (M5) — planned.

## 4. Changelog

| Version | Date | Change |
|---|---|---|
| 1 | 2026-10-04 | Initial (M2). |
