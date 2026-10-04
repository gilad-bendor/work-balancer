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
| `daemon.started` | `pid`, `version`, `env`, `reason` | written (M3) | |
| `daemon.stopped` | `pid`, `reason` | written (M3) | Missing after a crash — gaps are derived instead. |
| `monitor.gap` | `from`, `to`, `cause` (`daemon-down` · `quit` · `hs-down` · `stall`) | written (M4) | Unmonitored time, written when detected. |
| `minute` | `provider`, `minute` (MinuteKey = epoch ms floored to 60 000), `data` | written (M4: `interactive`) | Raw providers only (`work` is never persisted). **Last record per `(provider, minute)` in file order wins.** |
| `system` | `event` (`sleep` · `wake` · `lock` · `unlock` · `display-sleep` · `display-wake`) | written (M4) | From Lua watchers. |
| `inactivity.detected` | `gapId`, `lastInputAt` | planned (M9) | |
| `inactivity.resolved` | `gapId`, `from`, `to`, `choice` (`back` · `whole` · `some` · `expired`), `creditedMinutes` | planned (M9) | Later resolution of the same gap replaces earlier. |
| `policy.transition` | `from`, `to`, `workedMin`, `limitMin`, `weekMin` | planned (M6/M10) | Level changes only. |
| `token.used` | `minutes`, `until` | planned (M10) | |
| `bypass.used` | `minutes`, `until`, `reason` | planned (M10) | |
| `effect.shown` / `effect.closed` | `effect`, `windowId`, `by` (`user` · `system` · `rollover`) | planned (M7) | |
| `note.created` | `noteId`, `kind` (`context` · `feedback` · `note`), `text`, `choices?`, `energy?`, `source` | planned (M8) | `source`: `quick` · `countdown` · `block` · `review` · `manager`. |
| `note.edited` / `note.deleted` / `note.dismissed` / `note.undismissed` | `noteId`, (`text`) | planned (M8) | Event-sourced; state = fold over all days. Delete = tombstone. |
| `config.loaded` | `hash`, `source` (`file` · `snapshot`) | written (M3) | |
| `config.invalid` | `errors` | written (M3) | |
| `day.rollover` | `fromDay`, `toDay` | planned (M8) | |
| `app.quit` / `panic` | `by` | `panic`: written (M3); `app.quit`: planned (M8) | |

### 3.1 `minute` data per provider

**`interactive`** (R-INFO-2) — one record for every monitored minute:

| Field | Meaning |
|---|---|
| `inputs` | Input runs inside this minute: `[[fromOffsetMs, toOffsetMs], …]`, offsets relative to `minute`. A run merges observed input instants ≤ 5 s apart (exact for the busy union because the grace window ≫ 5 s). A single instant is `[x, x]`. Input instants come from `hs.host.idleTime()` sampled every second (±1 s). |
| `activeSeconds` | Number of distinct seconds in the minute with observed input (0–60). |
| `lastInputAt` | Epoch ms of the last input in this minute, or `null`. |
| `topApps` | ≤ 3 apps by foreground time in this minute, each ≥ 5 s: `[{ "id": bundleId, "name": appName, "s": seconds }]`. |
| `lockedSeconds`, `asleepSeconds` | Seconds of this minute with the screen locked / the Mac asleep. |

**`prompt-history`** (M5) — planned.

## 4. Changelog

| Version | Date | Change |
|---|---|---|
| 1 | 2026-10-04 | Initial (M2). |
