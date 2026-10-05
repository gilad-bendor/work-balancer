# Ledger — `work-balancer`

The project's memory between Copilot sessions: **status, requirements, decisions, open questions, discovered facts**.
Protocol: [copilot-instructions.md §9](./copilot-instructions.md#9-the-ledger-protocol). Read fully at session start;
update at session end. Keep "Current status" correct at a glance.

---

## 0. Current status (update every session)

| | |
|---|---|
| **Phase** | M1–M10 **done** (2026-10-05). **Enforcement is LIVE** (`liveEffects: true`, owner's approval 2026-10-05 ~16:40, D-62): on Sun/Tue/Thu — morning review, inactivity dialog, break nudge, warn + dim → countdown (Save = done for today, D-60) → full-screen block until 04:00 with tokens (10+5+5) and the emergency bypass. Mon/Wed/Fri/Sat: menubar only. Escape hatches: panic, debug eject ⌃⌥⌘⇧F12 (ON). |
| **Next** | **M11 — hardening & soak**: the hardening cases, then **one week of live use** (from Tue 2026-10-06; not to be compressed). Owner: sanity-check the M5 dry-run numbers (`scripts/prompt-history-report`). Open: Q-12…Q-15. Watch: daemon RSS ≈ 150 MB. Backlog after M11: "Feedback & energy" window (§4). |
| **Blocked** | Nothing. |
| **Live on the owner's machine?** | Yes — **enforcing** (Lua 0.6.0 + daemon 0.7.0, 2026-10-05): tracking into `data/`, menubar `⏱ worked / limit` (`⏳Nm` while a token/bypass runs), the menu, and every intrusive effect on Sun/Tue/Thu. Turn back to observe mode: `liveEffects: false` in `config/policy.ts` (on save). Debug eject ON (⌃⌥⌘⇧F12 terminates Hammerspoon; relaunch `open -g -a Hammerspoon`); `overlayOpacity: 0.8`. Check: `hs -c 'return WorkBalancer.health()'`; after `src/` changes `scripts/restart-daemon`; after Lua changes `scripts/reload-hammerspoon`. **Every commit is preceded by an adversarial review subagent (D-37).** |
| **Active tbd files** | `tbd-05-continue-m10` — the **successor top-level session** (D-58); M10 done, continuing with M11; it owns the ledger. |

---

## 1. Requirements (the owner's — do not silently change; propose changes in §7)

IDs are stable; reference them in code comments only where it clarifies the *why*, and in reports/tbd files.

### 1.1 Platform & runtime
- **R-PLAT-1** macOS only (this Mac). No cross-platform abstractions.
- **R-PLAT-2** Node ≥ 26, TypeScript run directly (type stripping), no transpilation. Hammerspoon for native bits.
- **R-PLAT-3** Hammerspoon integration = one file `hammerspoon/work-balancer.lua`, symlinked into `~/.hammerspoon/`,
  plus exactly one line `require("work-balancer")` in `~/.hammerspoon/init.lua`. Nothing else in `~/.hammerspoon/`.
- **R-PLAT-4** `scripts/reload-hammerspoon` (spec in §3 M1). Copilot runs it after every edit of `work-balancer.lua`.

### 1.2 Time model
- **R-TIME-1** Day boundary **04:00 local civil time**: if the local hour of `t` is < 4 the day key is the previous civil
  date, else the civil date (calendar arithmetic — **not** `t − 4 h`, which is wrong on DST days). DST-safe (23/25 h days).
- **R-TIME-2** Week = **Sun 04:00 → next Sun 04:00**. Workdays Sun–Thu. Fri = owner's private day (private work is done on
  another computer). Sat = Shabbat.
- **R-TIME-3** **All** activity on this computer is work, on any day.
- **R-TIME-4** Exact clock hours are never policy inputs (except the 04:00 boundary). Only *worked time* per day/week is.

### 1.3 Info-providers (monitoring)
- **R-INFO-1** Extensible provider architecture: PerMinuteInfo / PerMinuteInfoProvider / TimeRangeInfo /
  TimeRangeInfoProvider / InfoRepository (see [copilot-instructions §4.1](./copilot-instructions.md#41-info-providers-the-extension-point-for-metrics)).
  A future `camera` provider (and others) must plug in without core changes. **Do not build `camera` now.**
- **R-INFO-2** Provider **`interactive`** (raw): per minute — whether there was input; active seconds; last input time;
  **top ≤ 3 apps by foreground time in that minute, each ≥ 5 s**; lock/sleep seconds. Input = keyboard, mouse click,
  mouse move, **scroll** (anything that resets macOS HID idle time).
- **R-INFO-3** **Busy rule:** a moment is *busy* if there was input in the preceding **5 minutes** (configurable),
  cut short by screen lock / sleep. Inactivity-dialog resolutions override this rule for their gap (R-UI-INACT).
  **Arithmetic (normative):** truth is kept as **intervals**, at second precision: `busy = ⋃ [input, input + 5 min)`
  minus locked/asleep intervals, plus credited intervals (R-UI-INACT). A minute's `workSeconds` = overlap of that union
  with the minute (0–60). **Budgets sum `workSeconds`** (no rounding to whole minutes); UI shows `h:mm`, floored.
- **R-INFO-4** Provider **`prompt-history`** (raw): reads Copilot's **local** chat history, counts only **human**
  interactions — prompts typed by the owner and the owner's answers to agent questions. Agent actions/outputs,
  subagent traffic and automated launches (e.g. by `execute-copilot-session`) are **not** human interactions.
  Assume future sessions run in **VS Code** (not the CLI) — but see facts F-COP-* (VS Code sessions live in two stores).
  **Stores counts and timestamps only, never text.**
- **R-INFO-5** Provider **`work`** (digest): per minute, `workSeconds` per R-INFO-3 — combines `interactive` input,
  human prompts (count as input instants), lock/sleep, and inactivity resolutions. All budgets use `work`.
  **Computed on demand, never persisted** (instructions §4.1), so later providers/resolutions apply retroactively.
- **R-INFO-6** Time-range aggregates at least: worked minutes; longest continuous work stretch; number of breaks;
  first/last activity; top apps; prompts count / per hour; unmonitored minutes.

### 1.4 Data
- **R-DATA-1** JSONL, append-only, git-able. File per day key: **`data/YYYY-MM/YYYY-MM-DD.jsonl`**.
- **R-DATA-2** Survives restarts; all state (including an active block) is recomputable from data.
- **R-DATA-3** Feedback and notes are recorded in the same data.

### 1.5 Policy (initial values — owner said "conjure a reasonable policy, I'll change it later")
- **R-POL-1** Per-weekday policy must be **easy** to edit: one typed file `config/policy.ts`, hot-reloaded.
- **R-POL-2** Initial policy (all numbers configurable):

  | Day | Track | Menubar | Daily budget | Inactivity dialog | Break nudge | Warn → countdown → **block** | Morning review at 04:00 |
  |---|---|---|---|---|---|---|---|
  | Sun | ✅ | ✅ | **9 h** | ✅ | ✅ | ✅ | ✅ |
  | Mon | ✅ | ✅ | — (reference 9 h for colour only) | ❌ | ❌ | ❌ | ❌ |
  | Tue | ✅ | ✅ | **9 h** | ✅ | ✅ | ✅ | ✅ |
  | Wed | ✅ | ✅ | — (reference 9 h for colour only) | ❌ | ❌ | ❌ | ❌ |
  | Thu | ✅ | ✅ | **9 h** | ✅ | ✅ | ✅ | ✅ |
  | Fri | ✅ | ✅ | — | ❌ | ❌ | ❌ | ❌ (protects the private day) |
  | Sat | ✅ | ✅ (no colours) | — | ❌ | ❌ | ❌ | ❌ (Shabbat: **no popups at all**) |

  - *(2026-10-05, D-35)* **Only Sun/Tue/Thu have anything intrusive** (dialogs, dims, nudges, morning review, block).
    Mon/Wed/Fri/Sat: menubar status only.
  - **Weekly budget 44 h** (all days of the week count, R-TIME-3).
  - On enforcing days: **effective daily limit = min(daily budget, weekly budget − worked earlier this week)**, floor 0.
    A heavy week therefore shortens Thursday — protecting Friday. (If the effective limit is 0, see open question Q-3.)
  - Ladder on enforcing days (worked-time based, so it pauses when the owner is idle):
    `ok` (green) → **`orange`** at ≥ 75 % of the effective limit → **`warn`** at limit − 30 worked-min →
    **`countdown`** at limit − 10 worked-min → **`blocked`** at the limit, **until the next 04:00**.
  - Non-enforcing workdays: colours only (green/orange/red against the 9 h reference); no dialogs from the ladder.
  - **Ladder arithmetic (normative):** thresholds are clamped to `[0, limit]`; when several levels qualify, the
    **highest** wins (`blocked` > `countdown` > `warn` > `orange` > `ok`). Each dialog is shown once per level entry
    (a level re-entered after a token/bypass expiry does not replay lower-level dialogs). A **limit of 0** blocks only
    after the first worked second of that day (nobody is blocked at 04:00 while asleep), preceded by a short kind
    explanation screen.
- **R-POL-3 Postpone tokens** (enforcing days): per day **1 × 10 min + 2 × 5 min**, wall-clock minutes, do not carry
  over. Using one lifts the block for its duration; then the block returns. Logged.
- **R-POL-3a Grant composition (tokens & bypass):** usable **only while `blocked`**. Grants extend:
  `until = max(currentGrantUntil, now) + minutes`, clipped to the next 04:00. Grants run in wall-clock time (sleeping
  through a grant consumes it). When the grant expires, the block returns immediately (no re-warning).
- **R-POL-4 Emergency bypass**: costs effort — retype a long phrase shown on screen (paste disabled), plus a short
  reason; two-step confirm; grants **30 min** (wall clock); repeatable; every use logged and visible in summaries.
  Proposed phrase: *"I am choosing to borrow this time from my Friday and my family. I accept the cost, and I will stop
  as soon as I can."*
- **R-POL-5 Break nudge**: after **90 min** of continuous work, a gentle, dismissible, non-blocking nudge
  (snooze 15 min). Never blocks.

### 1.6 UI effects
- **R-UI-MENU-1** Menubar item: compact status (worked today vs effective limit, e.g. `5:12 / 9:00`), colour-coded
  (green / orange / red; grey = not monitored / Saturday / daemon down; a warning glyph on errors). Tooltip: week total.
- **R-UI-MENU-2** *(changed 2026-10-05, D-32)* **Any click** (left or right) opens one menu. Its first item
  **Quick note…** opens the *quick note* window: context-memory textbox + feedback form (R-UI-FB), submit.
- **R-UI-MENU-3** The menu: **Quick note…** · **Show activity summary** · **Show status notes** · **Quit**.
  - *Show activity summary*: today (worked, effective limit, remaining, state, tokens left, bypasses, prompts, top apps,
    longest stretch, breaks, unmonitored gaps), this week per day vs budgets, recent feedback; last 4 weeks trend.
  - *Show status notes* (= notes manager): **non-dismissed first, then dismissed**, each with its **date**; actions:
    **edit, dismiss, un-dismiss, add new**. *(2026-10-05, D-36: no delete and no purge — notes are temporary
    reminders, not book-keeping; "removing" a note = dismissing it.)*
  - *Quit*: confirm → logged → Lua sets a **`quit` latch** (supervisor stops restarting) → daemon stops, menubar
    removed, gamma restored, windows closed. The latch lives only in memory: the next Hammerspoon module load (login /
    reload) starts everything again. Not reachable while blocked (the block overlay covers the menubar — by design).
    *(2026-10-05, D-61)* Also not offered (menu item hidden, confirm refused) at `countdown`/`blocked` on an enforcing day
    with the live gate open — including during a token, when the menubar is visible — unless nothing can be enforced
    (panic, store write error).
- **R-UI-FB Feedback form** (reusable component; appears in quick-note, block, countdown, morning review):
  predefined **multi-select choices** (initial: *Too much work · Feeling tired · Anxious · Stuck / frustrated ·
  Productive · Good day · Other*) **+ always a free-text comment**, plus optional energy 1–5. Recorded as a note of kind
  `feedback`.
- **R-UI-CTX Context-memory** ("close the loop"): free-text box "What's the next thing you'd do? It will be waiting
  for you tomorrow." + submit. Present in: countdown, block, quick-note. Recorded as a note of kind `context`.
- **R-UI-WARN** Warning dialog (dismissible) + **dim pulse** (few seconds; gamma based; always restored).
  Grayscale is a nice-to-have later (no clean public API).
- **R-UI-COUNTDOWN** Countdown window: "≈ N min of work left today", context-memory box, feedback; not dismissible but
  can be collapsed to a small pill. *(2026-10-05, owner, D-60)* Its **Save = done for today**: the remaining minutes are
  given up (`budget.forfeited`) and the block follows until 04:00 (tokens / bypass still work). Cmd+Enter does not save
  there (review M10#6).
- **R-UI-BLOCK** Full-screen block on **all screens, all spaces, above the menubar and full-screen apps**, until 04:00:
  kind message, today/week numbers, context-memory box, feedback form, token buttons (remaining counts),
  emergency-bypass flow. Consequential actions (token, bypass) need a two-step confirm (guards against accidental and
  synthetic clicks — see F-HS-2). Re-asserted on screen/space changes and after restarts.
- **R-UI-INACT Inactivity dialog**: when inactivity (default 5 min, R-INFO-3) is detected, show a non-focus-stealing
  window stating the **last activity time** and the **time elapsed since** (live). Buttons:
  **"I am back to work!"** (default busy rule applies) · **"I was working the whole time"** (whole gap credited) ·
  **"Worked some of the time"** with a slider (0 … gap length) crediting that many minutes from the gap start.
  *(2026-10-05, D-33)* The dialog is preceded by a **~10 s noticeable pre-warning** (a gentle screen dim): any input
  during it cancels the dialog (the owner was just reading); otherwise the dialog appears.
  Multiple unresolved gaps are listed in the same window. It **disappears automatically at 04:00** (unresolved =
  default rule). Not shown on Saturday or while blocked. Gaps are clipped to their day.
  *(2026-10-05, owner, D-56 — supersedes the window shape above)* The dialog is **full screen** (all screens,
  `overlayOpacity`), **not escapable and never times out** — it ends only by answering (escape hatches still apply).
  **Input while it is on screen does not end the gap**: the gap keeps growing (live timer with seconds) until Submit,
  so there is only ever **one** gap to answer. One slider "Worked N min of M" (0 = back · max = whole, pinned to the
  growing gap · between = some) with the two presets moving it; Submit only after a deliberate touch.
  **Credit arithmetic (normative):** a gap is `[lastInput, nextInput)`. "Whole" credits the entire gap **including
  locked/asleep time** (the owner locks the screen when leaving for a meeting — that is work). "Some = N min" credits
  `[gapStart, gapStart + N)` chronologically (N ≤ gap length). "Back" keeps the default rule. A later resolution of
  the same gap replaces the earlier one.
- **R-UI-REVIEW Morning review at 04:00** (on rollover into Sun–Thu; if the Mac sleeps at 04:00, on first wake after):
  a window listing **all non-dismissed notes** (context-memory + feedback + free notes), **pre-filled/editable**, each
  with a **Dismiss** button. Closing the window does not dismiss anything. Thursday's notes therefore surface on Sunday.
- **R-UI-QUIET** *(2026-10-05, D-34)* **No visual effect starts within 10 s of user input** (typing / mouse): a
  due effect (warn, dim, countdown, block, nudge, dialog) waits for 10 s without input, so it never lands
  mid-keystroke or mid-click. Bounded by a maximum deferral (Q-13), otherwise continuous typing would postpone it forever.
- **R-UI-ESC** Escape hatches (must exist before the block): panic hotkey (long-press combo) and
  `hs -c 'WorkBalancer.panic()'` → set a Lua-side **`panic` latch** (reconciler cannot override it): remove overlays,
  restore gamma, suppress all enforcement windows/dims **until the next 04:00 rollover** or
  `WorkBalancer.resume()`; tracking continues; log `panic`. Internal errors fail **open** with a visible warning.

- **R-UI-EJECT** *(2026-10-05, owner, D-49)* **Debug panic-eject** — a temporary safety net while the blockers are new:
  every window that covers a whole screen (overlay mode or `full` placement — block, full-screen dialogs, test
  overlays, even when its page failed to load) shows a label at its bottom: **"Press Shift+Ctrl+Alt+Cmd+F12 to
  PANIC-EJECT"**; pressing that combo **terminates Hammerspoon** (gamma restored first; the detached daemon keeps
  running). Implemented in Lua only (works with the daemon down). **Toggle-able, default on**:
  `hs -c 'return WorkBalancer.debugEject(false)'` (persisted in `var/live/debug-eject.json`); the owner turns it off
  once he trusts the blockers. While on, the combo ejects on press (it supersedes the hold-1.5 s panic of R-UI-ESC,
  which returns when eject is off). **Must exist before any real block** (M10 verifies it first, with the escape hatches).

### 1.7 Dev process
- **R-DEV-1** `.github/copilot-instructions.md` + this ledger; additional Copilot topic files flat in `.github/`.
- **R-DEV-2** Session tmp-folders `.github/tmp/YYYY-MM-DD--HH-MM--<title>/`; tbd files inside them; tbd files
  registered in §5.
- **R-DEV-3** Prefer `scripts/execute-copilot-session` over subagents for tasks needing/benefiting from owner interaction.

---

## 2. Initial data model (draft — becomes `.github/data-format.md` in M2)

Every line: `{ "v": 1, "ts": <epochMs>, "type": "<type>", ... }`. Unknown types/fields are ignored by readers.

| `type` | Key fields | Notes |
|---|---|---|
| `daemon.started` / `daemon.stopped` | `pid`, `version`, `reason` | `stopped` may be missing after a crash — derive gaps from heartbeats. |
| `monitor.gap` | `from`, `to`, `cause` (`daemon-down`, `quit`, `hs-down`, `stall`) | Unmonitored time, written when detected. |
| `minute` | `provider`, `minute` (MinuteKey), `data` | Raw providers only (`work` is never persisted). Written to the file of the day the minute belongs to. Last record per `(provider, minute)` wins. `interactive` writes every monitored minute (`inputs`: input-instant timestamps or compact runs, `activeSeconds`, `lastInputAt`, `topApps`, `lockedSeconds`, `asleepSeconds`); `prompt-history` only minutes with ≥ 1 interaction. |
| `system` | `event` (`sleep`, `wake`, `lock`, `unlock`, `display-sleep`, `display-wake`) | From Lua watchers. |
| `inactivity.detected` | `gapId`, `lastInputAt` | |
| `inactivity.resolved` | `gapId`, `from`, `to`, `choice` (`back`, `whole`, `some`, `expired`), `creditedMinutes` | |
| `policy.transition` | `from`, `to`, `workedMin`, `limitMin`, `weekMin` | Level changes only (not every tick). |
| `token.used` | `minutes`, `until` | |
| `bypass.used` | `minutes`, `until`, `reason` | |
| `budget.forfeited` | `remainingSeconds`, `by` | *(M10, D-60)* countdown Save = done for today → blocked until 04:00. |
| `effect.shown` / `effect.closed` | `effect`, `windowId`, `by` (`user`, `system`, `rollover`) | Lightweight UX audit. |
| `note.created` | `noteId`, `kind` (`context`, `feedback`, `note`), `text`, `choices?`, `energy?`, `source` | `source`: `quick`, `countdown`, `block`, `review`, `manager`. |
| `note.edited` / `note.deleted` / `note.dismissed` / `note.undismissed` | `noteId`, (`text`) | Event-sourced; state = fold over all days. Delete = tombstone (see Q-5). |
| `config.loaded` / `config.invalid` | `hash`, `errors?` | |
| `day.rollover` | `fromDay`, `toDay` | |
| `app.quit` / `panic` | `by` | |

---

## 3. Milestones & tasks

Legend: `todo` · `in-progress` · `done` · `blocked` · `dropped`. Each milestone lists acceptance criteria (AC).
Natural tbd-file boundaries are marked ⟂ (a sub-task that can be delegated via `execute-copilot-session`).

### M0 — Design docs · `done`
- [x] `.github/copilot-instructions.md`, `.github/ledger.md` (session 2026-10-04, see §9).

### M1 — Scaffolding & scripts · `done`
- [x] `package.json` (`"type": "module"`, scripts `typecheck`, `test`, `check`), `tsconfig.json` (baseline in
      instructions §3.1), `.nvmrc` (`26`), `.gitignore` (`node_modules/`, `var/`, `.github/tmp/**/scratch/`, `.DS_Store`).
- [x] `scripts/run-node` (resolve newest `~/.nvm/versions/node/v26.*/bin/node`; fail clearly if none) — every script
      uses it; **never rely on `node` in PATH** (F-ENV-1).
- [x] `scripts/run-daemon` → `run-node src/main.ts` (env passthrough: `WB_ENV`, `WB_PORT`, `WB_FAKE_NOW`).
- [x] `scripts/check` → typecheck + `node --test` (via run-node / its npm).
- [x] ⟂ `scripts/reload-hammerspoon` — spec (done by tbd-01; logic + 36 tests now in `src/hammerspoon/reload-hammerspoon{,.test}.ts`):
  - Resolve repo root from the script's own location (works via symlinks / any cwd).
  - Ensure `~/.hammerspoon/` exists. Ensure `~/.hammerspoon/work-balancer.lua` is a symlink to
    `<repo>/hammerspoon/work-balancer.lua`: create if missing; fix if it is a symlink pointing elsewhere (print old
    target); if it is a **regular file**, **refuse** (exit ≠ 0, explain) — never clobber.
  - Ensure `~/.hammerspoon/init.lua` contains **exactly one** line `require("work-balancer")` (tolerate `'` quotes and
    surrounding whitespace when detecting; normalise to the canonical line). Add if missing (append, preceded by a
    newline if the file doesn't end with one); remove duplicates; leave every other line byte-identical. Before any
    modification write a backup `init.lua.bak.<epochMs>` (the owner's existing convention). No change → no backup.
  - Ensure Hammerspoon is running (`open -g -a Hammerspoon` if not) and the `hs` CLI responds (`hs -c 'return 1'`);
    if not, explain that `hs.ipc` must be loaded (our module requires it, but the first load needs a manual reload or
    Hammerspoon restart).
  - Reload **without killing the IPC call**: `hs -c 'hs.timer.doAfter(0.2, hs.reload)'`, then poll
    `hs -t 2 -c 'return WorkBalancer and WorkBalancer.health() or "missing"'` until healthy or timeout (~15 s).
  - On failure: print the tail of the Hammerspoon console, exit ≠ 0. Flags: `--check` (verify links/line only, no
    reload), `--hammerspoon-dir <dir>` (operate on another dir, implies no reload — for tests), `--quiet`, `--help`.
  - Idempotent: running twice in a row changes nothing the second time.
  - Tested with `node --test` against scratch dirs (missing dir, missing line, duplicate lines, `'`-quoted line,
    no trailing newline, wrong symlink, regular-file conflict).
- [x] `hammerspoon/work-balancer.lua` stub: `require("hs.ipc")`, global `WorkBalancer` with `health()` → `"ok <version>"`,
      `panic()` / `resume()` (latch only, for now), clean unload on reload (stop timers/watchers, delete menubar,
      restore gamma).
- [x] README.md: one-paragraph intro + setup steps (`scripts/reload-hammerspoon`).
- [x] **First live install — ask the owner first** (`ask_user`; instructions §10). If he declines, stop after the
      scratch-dir tests and record it in §0.
- **AC:** `scripts/check` green; scratch-dir tests cover the cases above; after the approved live install, a second
  run makes no changes, `init.lua` diff shows only the one added line, and the owner's other modules still load
  (console clean).
- **AC verified (2026-10-04):** `scripts/check` → typecheck clean, 36/36 tests (`src/hammerspoon/reload-hammerspoon.test.ts`:
  missing dir, missing/duplicate/`'`-quoted/whitespace/`;` lines, no trailing newline, wrong symlink, regular-file
  conflict, backup only on change, idempotency, spawned CLI via `--hammerspoon-dir` from `/` and via a symlink).
  Live: owner consented; `scripts/reload-hammerspoon` → created symlink, backup `init.lua.bak.1791121428512`, appended
  the line, reload healthy (`ok 0.1.0`), exit 0; second run → "symlink ok / init.lua ok", no new backup, exit 0;
  `diff` of `init.lua` before/after = only `> require("work-balancer")`; console tail clean (`playwright-focus-guard`,
  `copilot-retry-watcher` loaded).

### M2 — Core & store · `done`
- [x] `core/clock.ts` (real + fake/offset clock from env), `core/time.ts` (MinuteKey, dayKey, day start/end, week start,
      weekday names `sun..sat`), with tests run under `TZ=Asia/Jerusalem` covering both 2026 DST transitions (verify the
      dates with `Intl` — expected late March and late October) and day-boundary edges (03:59/04:00, Sat→Sun week edge).
- [x] `core/registry.ts` + provider/effect type contracts (instructions §4.1, §4.3).
- [x] `store/`: synchronous append with torn-line repair, file routing by record kind (instructions §6: time-records
      → the day they describe; entity/action records → current day), read day, read range, tolerant parsing, last-wins
      minute index; data dir from env (`data/` live, `var/dev/data/` dev, a temp dir in tests).
- [x] `policy/config.ts`: `PolicyConfig` type, validation (clear errors), loader with cache-busted hot-reload,
      last-good snapshot + cold-start fallback (instructions §4.2); `config/policy.ts` with R-POL-2 values.
- [x] Logger → `var/<env>/logs/daemon-<dayKey>.log` (+ stderr in dev).
- [x] Create `.github/data-format.md` from §2; register in instructions §11.
- **AC:** tests cover DST, boundaries, torn lines, unknown types, out-of-order minutes, invalid config.
- **AC verified (2026-10-04):** `scripts/check` → typecheck clean, 58/58 tests. `src/core/time.test.ts` (TZ
  Asia/Jerusalem; asserts the 2026 transitions found via a scan of `getTimezoneOffset`: **Fri 27 Mar 02:00→03:00**
  ⇒ day `2026-03-26` = 23 h; **Sun 25 Oct 02:00→01:00** ⇒ day `2026-10-24` = 25 h, both repeated 01:30s on Saturday's
  day; 03:59/04:00 edges; month/year edges; Sat-night→ending week; week with fall-back = 169 h).
  `src/store/store.test.ts` (routing incl. a 03:59 minute written at 04:00:30 → previous file; torn line repaired +
  skipped with warning; garbage/non-object/unknown type/extra fields; incremental re-read; last-wins minutes;
  unwritable dir → no throw, `health().writeError`, cleared after a good write). `src/policy/config.test.ts` (owner's
  file valid + R-POL-2 values; clear validation errors; hot reload via `?v=<mtime>`; syntax error / invalid value
  keeps previous; snapshot written; cold start → snapshot, else tracking-only). `src/core/registry.test.ts`
  (dependency order, typed augmentation, missing dep, duplicate). Test scratch dirs: `var/test/` (never `/tmp`, never `data/`).

### M3 — Daemon, bridge, Lua skeleton · `done`
- [x] `src/main.ts`: port bind as mutex, atomic `var/<env>/daemon.json` (pid, port, token, protocol version, repo),
      graceful shutdown (`daemon.stopped`), `/health`.
- [x] Bridge: `POST /bridge/heartbeat` (auth, `seq`, `sentAt`, timestamped sensor samples, actual-UI report, command
      acks) → reply (menubar spec, commands). Dedup by `seq`; protocol version check (instructions §4.4).
- [x] Lua: supervisor (adopt healthy daemon / spawn via `hs.task` + `scripts/run-daemon` / restart with backoff; honours
      the `quit` latch), 5 s heartbeat (single in-flight + watchdog), static menubar title from reply, grey
      `daemon down` state, `WorkBalancer.health()` real.
- [x] Dev instance (`WB_ENV=dev`, browser-only daemon, `var/dev/`), `WorkBalancer.preview(url)`. Document how to run.
- [x] Escape hatch: panic hotkey + `WorkBalancer.panic()` / `resume()` latch (R-UI-ESC).
- [x] Create `.github/hammerspoon.md` (API facts verified here, gotchas, how to debug via `hs -c`).
- **AC:** kill the daemon → Lua restarts it within ~10 s and menubar shows grey meanwhile; Hammerspoon reload → no
  duplicate daemon (adopted); a second live daemon exits on bind failure; a dev daemon runs alongside the live one
  without touching `var/live/` or `data/`.
- **AC verified (2026-10-04):** `scripts/check` 64/64 (`src/daemon/daemon.test.ts`: daemon.json atomic + 0600 +
  removed on stop; `/health` open, token on everything else, foreign `Host` → 403; heartbeat reply, `(loadId, seq)`
  dedup, protocol mismatch 409, bad body 400; panic transition logged once; `WB_VAR_DIR` refused for live; **two
  spawned `scripts/run-daemon` → the second exits 0, the first keeps `daemon.json`**, SIGTERM removes it).
  Live: `kill <pid>` → menubar grey `⏱ –:––` after ~4 s, new daemon answering after ~9 s (1 s polling of
  `WorkBalancer.health()`); `scripts/reload-hammerspoon` → same pid, `adopted=true`; `WB_ENV=live scripts/run-daemon`
  while live runs → exit 0, `daemon.json` pid unchanged; dev daemon on 47622 (health, heartbeat, `/api/status`) →
  `var/dev/data/…` only; before/after `stat` snapshot of `data/` + `var/live/` identical except the live log line of
  the refused second live daemon. `preview()` refuses the live port and non-local URLs; a hidden `hs.webview` loads a
  dev page (`loading()==false`). Panic hotkey registered (`✧ESCAPE`); a live `panic()` was **not** triggered (it
  would write a fake `panic` record into `data/`) — daemon-side logging is unit-tested; full escape-hatch check is
  M10's first task. Script: `.github/tmp/2026-10-04--16-19--kickoff-m1-m4/scratch/m3-ac.sh` (gitignored scratch).
- **Incident (2026-10-04 16:56–16:57):** the first spawn command (`mkdir … && nohup … & echo $!`) froze all of
  Hammerspoon for ~67 s (hs.task stdout pipe held by a background subshell — `.github/hammerspoon.md` H-6). Killed the
  subshell; fixed the command; verified spawn/restart since.

### M4 — `interactive` provider, `work` digest, aggregates, live menubar · `done`
- [x] Lua sensors: `hs.host.idleTime()` per heartbeat (implemented: sampled every **1 s**, batched per heartbeat — F-HS-6); app focus intervals via `hs.application.watcher` (exact
      durations, bundle id + name); `hs.caffeinate.watcher` (sleep/wake/lock/unlock/display) pushed immediately.
- [x] `interactive` minute records (R-INFO-2), every monitored minute; `monitor.gap` detection (heartbeat silence
      > 30 s without a sleep event).
- [x] `work` digest (R-INFO-3, R-INFO-5) — computed on demand, designed to accept prompt instants (M5) and inactivity
      credits (M9) as additional inputs — + time-range aggregates (R-INFO-6): today, week, current stretch.
- [x] Menubar: `worked / limit` text + colour (R-UI-MENU-1), no enforcement yet.
- **AC:** interval-arithmetic unit tests (R-INFO-3: overlapping grace windows, lock cut-off, minute projection,
  sleep across minute boundaries, 04:00 split); **observe mode is live** (tracking + menubar only) on the owner's
  machine (with his consent from M1).
- **AC verified (2026-10-04):** `scripts/check` 86/86. `src/providers/work/work.test.ts` (one instant = 5 min;
  overlapping grace windows not double counted; run `[a,b]` → `b + grace`; breaks/longest stretch; lock cut-off (after unlock
  the rest of the grace window counts again — R-INFO-3 union − locked); credits count while locked; per-minute projection at second precision; sleep across minute
  boundaries; 04:00 split 03:58 → 2 min + 3 min; clipped to *now*; current stretch). `src/core/intervals.test.ts`.
  `src/providers/interactive/interactive.test.ts` (every monitored minute; runs joined ≤ 2 s; apps ≥ 5 s top 3,
  locked time excluded; lock persisted with event time; idempotent re-send; late samples re-emit; sleep batch does
  not fake a wake; fully asleep minutes skipped; `locked` flag repairs a missed unlock; restart reload of runs/locks/
  topApps without rewriting unchanged minutes). `src/daemon/tracker.test.ts` (menubar `⏱ 1:00 / 9:00` green +
  tooltip; Saturday grey/Friday none; Sun–Wed 40:16 from disk ⇒ Thursday `/ 3:44`; `hs-down` gap recorded, sleep not,
  split at 04:00; restart ⇒ `daemon-down` gap). `src/policy/observe.test.ts` (limits + colours).
  **Live:** `scripts/restart-daemon` + `scripts/reload-hammerspoon` → daemon 0.3.0 adopted; after 2.5 min the menubar
  read `⏱ 0:02 / 9:00` (green), `data/2026-10/2026-10-04.jsonl` had `interactive` minutes with input runs + top apps,
  `/api/status` aggregates consistent (worked 165 s, 4 monitored minutes, 0 unmonitored), daemon 0.0 % CPU / 68 MB,
  console clean, no `monitor.gap` across a Hammerspoon reload. Not yet observed live: lock/unlock, sleep/wake records.

### M5 — `prompt-history` provider · `done` (owner's sanity check of the dry-run numbers pending)
- [x] ⟂ Investigation → [copilot-history-formats.md](./copilot-history-formats.md) (tbd-02, 2026-10-05): three stores
      (CLI `events.jsonl`, agent-host turn index `agentSessionData/*/session.db`, VS Code native op-logs), no
      cross-store double counting, copied sessions deduped by event id; classification C0–C10 / A1–A2 / V1–V5 / VA1;
      Insiders not installed.
- [x] Incremental reader: scan changed files by mtime every ~30 s; per-file byte cursors **in memory** (D-44: a restart
      re-scans today's changed files — < 0.5 s — instead of persisting cursors); only from today's day start on startup;
      robust to partial lines, rewritten files (guard bytes) and format drift (skip unknown, never crash).
- [x] Human filter per [copilot-history-formats.md](./copilot-history-formats.md) §3 (`src/providers/prompt-history/classify.ts`): agent-host prompts classified
      deterministically by the `agentSessionData` turn id (`request_*` = VS Code UI = human; bare UUID = runner/AHP
      client) and runner markers; subagents by `agentId`/`source`; `ask_user` answers (outcome answered / elicitation
      accept) count as human everywhere; `interactive` corroboration (~60 s) only for runner-launched sessions without a
      turn index (C8); retries, `github/cli`, missing turn rows, cancelled asks → `unclassified` (never silently human).
- [x] Minute records `{ prompts, answers, unclassified, automated, at, bySource }` (no text; data-format §3.1) + range
      aggregates (count, per hour, first/last, longest silence). Human prompts/answers are activity instants in `work`.
- [x] `scripts/prompt-history-report` — read-only dry run over today's real history (counts only).
- [x] Synthetic fixtures for all stores + `expected.json` (tbd-02): `test-fixtures/prompt-history/`.
- **AC:** fixture tests; a live dry-run report over today's real history (counts only) shown to the owner for a sanity
  check.
- **AC verified (2026-10-05):** `scripts/check` 116/116 — `src/providers/prompt-history/prompt-history.test.ts` runs the
  tbd-02 fixtures (materialised SQLite) and matches `expected.json` per store/kind/class/rule; C8 with/without
  corroboration; C9 deferral; minute records hold counts + times only (no fixture text in `data/`); restart and VS Code
  compaction add nothing; answers re-stamped identically; failed writes retried; copied-session original by
  `created_at`; hot journal skipped; drift warning. Live: `scripts/prompt-history-report` (79 ms) — 2026-10-05 04:00 →
  ~09:40: human prompts 2 (1 CLI agent-host UI turn, 1 VS Code native), answers 0, automated 9 (runner + subagents),
  unclassified 0 — matches tbd-02's independent count for the morning. Daemon writes `prompt-history` minutes live.
  Adversarial review: 8 findings + 3 on the fixes (incl. a db byte-copy that would have put drafts/terminal output
  into `var/`) — all fixed (`.github/tmp/2026-10-05--08-37--answers-reviews-m5/scratch/review-m5.txt`).

### M6 — Policy engine · `done`
- [x] Pure evaluator → `PolicyState` (R-POL-2) — `src/policy/evaluate.ts` (builds on `observe.ts`); wired in the tracker (menubar colour, `policy.transition` on level changes, `/api/status`): weekday rules, effective limit, ladder thresholds in worked minutes,
      tokens/bypass windows from today's events, Saturday quiet mode, rollover semantics.
- [x] Exhaustive table-driven tests (each weekday, week overrun, token sequences, bypass during token, credit from an
      inactivity resolution pushing over the limit, restart mid-block, config change mid-day, DST day).
- **AC:** 100 % of ladder transitions covered by tests; no I/O in the evaluator.
- **AC verified (2026-10-05):** `src/policy/evaluate.test.ts` (11 tests): each weekday (D-35), every ladder transition
  at its exact threshold (t−1 / t) for 9 h, clamping + highest-wins for a short limit, week overrun (Thursday 4 h;
  limit 0 → `ok` at 0 s, `blocked` at 1 s, `zeroLimit`), token slots, grant composition (token then bypass during it →
  max+30), expiry → block returns, clip to 04:00 on the 25 h day, credit pushing over the limit, purity (restart),
  config change mid-day, token/bypass only while blocked; tracker test: transitions logged once and restored after a
  restart. The evaluator has no I/O (pure function of its input). Adversarial review: 9 findings + 1 on the fixes, all
  addressed (D-45, D-46) — 133 tests; `.github/tmp/2026-10-05--08-37--answers-reviews-m5/scratch/review-m6.txt`.

### M7 — UI infrastructure · `done`
- [x] Lua window manager: create/update/close webviews by id; levels (normal, floating, overlay above menubar);
      behaviours (all spaces, full-screen auxiliary); per-screen overlays; re-assert on `hs.screen.watcher` / space
      changes; `allowTextEntry(true)`; report actual state in heartbeats; fallback inline HTML if a page fails to load
      (with auto-close after 60 s → fail open).
- [x] Daemon: page serving (`src/ui/`), TS page scripts via type stripping (verify; else JSDoc `.js`), JSON API with
      token, shared CSS, central strings module (tone).
- [x] Effects reconciler (desired vs actual → commands), dim pulse (`setGamma` + guaranteed restore).
- [x] Create `.github/ui-and-tone.md`.
- [x] Debug panic-eject (R-UI-EJECT, D-49): label on full-screen windows, press → terminate Hammerspoon, toggle.
- **AC:** every window type renders against the dev daemon (browser + `WorkBalancer.preview`); with the owner's
  consent and a short agreed window, the live overlay is shown once on 2 monitors and over a full-screen app, and panic
  removes it.
- **AC verified (2026-10-05):** `scripts/check` 147/147 (`src/effects/reconcile.test.ts`: open/update/close, every
  R-UI-QUIET edge incl. max deferral and re-appearance, panic, pulse once; `src/effects/effects.test.ts`: page serving
  + traversal + type stripping, test-window lifecycle through the daemon, panic suppression, live gate + consent flag,
  covering ⇒ intrusive, audit incl. restart/reload, opacity, cap). Live, with the owner's consent (~11:05–11:36): the
  fixture rendered in a DEV PREVIEW and in managed `normal` windows (typing after the H-10 focus fix; the dev page in
  the browser too); a `perScreen` **overlay** at 70 % on **both monitors**, then **over full-screen apps on both
  screens**, capturing all input, with the eject label; ⌃⌥⌘⇧F12 terminated Hammerspoon (Esc version impossible —
  H-9); panic teardown via `WorkBalancer._panicDryRun` removed the overlay at once (no `panic` record, no latch);
  readiness handshake: a broken page failed after 15 s, closed, stayed quarantined. Floating mode and dim pulses are
  covered by the tests and the dev fixture but were not shown live (no consent needed yet — first live use in M9/M10).
  Adversarial review: 8 findings + 2 on the fixes, all fixed; final re-check clean (`tbd-03-continue-m7/scratch/review-m7.txt`).

### M8 — Notes, feedback, menubar menus, summary, morning review · `done`
- [x] Notes event-sourcing (fold across all days; ids `n-<epochMs>-<rand>`) — `src/notes/notes.ts`; `store.listDays()` +
      uncached `scanDay()`.
- [x] Quick-note window: context-memory + feedback (R-UI-MENU-2, R-UI-CTX, R-UI-FB) — shared `feedback.ts` form.
- [x] Menu on any click (D-32, H-14): items sent by the daemon, `POST /bridge/ui-request`, `window.focus` to raise.
- [x] Notes manager window (*Show status notes*).
- [x] Activity summary window (today, week per day vs budgets, last 4 weeks via `src/daemon/history.ts`, feedback).
- [x] Quit flow (confirm page → Lua `quit` → shutdown → `app.quit` + `daemon.stopped quit`; daemon down → Lua confirm).
- [x] Rollover (`day.rollover` on the first tick of a day — 04:00, after a wake, or at a start) and morning review
      window (R-UI-REVIEW, D-53).
- **AC:** owner reviews wording/visuals (use `execute-copilot-session --questions free-to-ask` or `ask_user`).
- **AC verified (2026-10-05):** `scripts/check` 164/164 (`src/notes/notes.test.ts`: fold incl. unknown ids/duplicates/
  malformed, order, validation, restart = same state, write error keeps state; `src/effects/product.test.ts`: menu
  windows open live with the gate closed, focus on re-request, quick-note parts, notes manager actions, restart adopts
  / reload ends, review decided by rollover + done survives a restart + Monday/live-gate off, summary model incl.
  history weeks; store `listDays`/`scanDay`; daemon: menu in every reply, `app.quit`, persisted token). Owner, live
  (Lua 0.5.0, ~12:00–12:55): **left and right click both open the menu**; quick note, status notes, activity summary
  "all looking very good"; asked for and approved: a static top bar with a big ✕ and 90 % windows with an inner
  scrolling box (summary, notes), Esc closes every dialog, Cmd+Enter submits, review button "Let's start this day!"
  (D-55); morning review checked in a DEV PREVIEW; a live floating `focus: false` test window at the top right
  ("looks good"). The review stays **gated on live** (`liveEffects: false`). Adversarial review: 6 findings (1 high —
  pages kept open across a daemon restart could never save: token now persisted, D-54) — all fixed
  (`tbd-04-continue-m8/report.md`).

### M9 — Inactivity dialog · `done`
- [x] Gap detection with the ~10 s pre-warning dim (D-33; input cancels), full-screen un-escapable dialog (D-56), live
      gap timer, slider + presets, one gap at a time, expiry at 04:00, not on Mon/Wed/Fri/Sat (D-35) / while blocked /
      with the live gate closed; `inactivity.*` events; `work` digest honours resolutions (credits + the gap override)
      — `src/inactivity/inactivity.ts`, page `inactivity`; history (4-week summary) includes them.
- **AC:** tests for credit math (incl. lock inside gap, gap across 04:00); owner tries it in dev.
- **AC verified (2026-10-05):** `src/inactivity/inactivity.test.ts` (8): credit arithmetic; pre-warning dim → input
  cancels → no gap, else gap + full-screen window; late detection after sleep (no pre-warning); `whole` credits a gap
  with a 24-min lock inside it; `some` replaces `whole` after a restart; no close action; gap across 04:00 clipped and
  expired into the gap's day file; restart restores the open gap; Mon/Sat/live-gate → nothing; D-56: input over the
  dialog ignored, gap ends at Submit, dialog fiddling not work, one gap; a panic-suppressed dialog lets input end the
  gap. 172 tests. Owner: dev previews (2 rounds of changes → D-56), **live** pre-warning dim twice (cancelled by the
  mouse; ran 10 s and restored by itself — "Good"), **live** full-screen trial on both screens over a synthetic gap
  (`/api/test/window` `page: inactivity`, nothing in `data/`) — "That was perfect"; `overlayOpacity` 0.7 → **0.8**.
  Adversarial review: 3 findings + 1 + 2 on the fixes (Hammerspoon-down gaps erasing work, a failing write trapping
  the owner, panic; sleep-with-keypress missed → retroactive detection) — all fixed; version **0.6.0** (D-45). 177 tests.

### M10 — Enforcement: warn, countdown, block, tokens, bypass, break nudge · `done`
- [x] **First verify escape hatches** (panic, `hs -c`), fail-open on daemon death / page failure — live, with consent.
- [x] Warn dialog + dim pulse; countdown window (collapsible pill); block overlay (all screens/spaces, above menubar,
      zero-limit explanation first); tokens (two-step); emergency bypass (sentence retyped, paste blocked, reason,
      two-step); break nudge — `src/enforcement/enforcement.ts`, pages `warn` / `countdown` / `block` / `nudge` + `park.ts`.
- [x] Block persists across daemon restart and Hammerspoon reload (recomputed from data; re-shown without R-UI-QUIET
      deferral); lifts at 04:00 rollover.
- [x] Trial mode for every enforcement page (`/api/test/window {page}`), nothing in `data/`.
- **AC:** full ladder walk-through in dev with a fake clock, recorded in the session report; owner approves before
  enforcement is enabled on the live instance.
- **AC verified (2026-10-05):** `scripts/check` 184/184 (`src/enforcement/enforcement.test.ts`: the full Tuesday ladder
  orange+nudge → warn+dim (once) → countdown (pill; empty Save forfeits nothing; Save → `budget.forfeited` → block) →
  token (wrong size / reused refused; `⏳10m`) → expiry → block back → bypass (sentence check, reason) → restart while
  typing → re-shown at once → 04:00 nothing; zero limit; gate closed / Saturday / write error → nothing; nudge rules;
  trial pages; review regressions). Dev daemon over HTTP with `WB_FAKE_NOW` on seeded fake data (`dev-walk.out`) and
  screenshots of every page (tbd-05 `report.md` §M10). Escape hatches live first: panic dry run, daemon death (2 s),
  broken page (21 s), eject labels on both screens. **Owner tried every page live** (block on both screens + token;
  warn + dim; nudge; countdown + pill) — "All good!", "They looked good"; his changes: countdown Save = done for today
  (D-60), visible title bars (H-15), a shorter countdown. Adversarial review: 6 findings + 2 on the fixes, all fixed
  (D-59, D-61). **Owner approved live enforcement → `liveEffects: true`** (D-62). Performance ≈ 19 ms per 5 s beat.

### M11 — Hardening & soak · `todo`
- [ ] Sleep/wake across 04:00, lid closed, external monitors hot-plug, DST day, Hammerspoon crash/restart, daemon
      crash loops (backoff + visible warning), disk full / unwritable data dir (fail open + warning), config errors.
- [ ] One week of live use; collect owner feedback; tune defaults (decisions logged).

---

## 4. Backlog / future (not scheduled — do not build without the owner's go-ahead)
- `camera` provider (posture/fatigue/stress) — architecture already allows it (R-INFO-1).
- True grayscale effect; screen "shake".
- Fatigue proxies from existing signals: typo/backspace rate, prompt length trend, rapid app switching, late prompts.
- Meeting awareness (don't throw a block over a screen share; offer auto-postpone during calls).
- Gentle Friday notice on first activity ("Friday is your private day").
- Historical backfill script for `prompt-history`; weekly report (markdown) generated into `data/`.
- Optional auto-commit of `data/` (owner currently commits manually).
- ~~Energy/feedback trend charts in the summary.~~ → superseded by the next item (2026-10-05).
- *(2026-10-05, owner — **after M11**, once there is real data)* **"Feedback & energy" window**: a 5th menu item, same
  90 % layout as the summary: energy per day (mean + range) over the last weeks beside worked hours per day, choice
  counts per week, and every comment with its date.
- *(2026-10-05, owner — low priority)* **Statistics on every full-screen effect** (block, zero-limit explanation, any
  overlay): today worked vs limit, this week vs weekly budget, per-day bars Sun–Thu, current stretch, tokens/bypasses
  used; reuse the summary's model. (The block already shows today/week numbers per R-UI-BLOCK — this extends it.)
  *(2026-10-05: the block and the zero-limit screen now show today/week numbers + a per-day week strip; the rest open.)*

---

## 5. tbd-file registry

Register every tbd file here when created (path **stem**; the on-disk suffix shows its state:
`.md` pending · `.<harness>.launched-<stamp>.md` · `.<harness>.completed.md` · `.<harness>.error-<kind>.md`).

| tbd stem | Milestone/task | Created by (session) | Purpose | Outcome / report |
|---|---|---|---|---|
| `.github/tmp/2026-10-04--16-19--kickoff-m1-m4/tbd-01-reload-hammerspoon` | M1 `scripts/reload-hammerspoon` | 2026-10-04 kickoff-m1-m4 | Implement + test the install/reload script | completed (2nd launch; 1st opened in the wrong VS Code window — runner bug, fixed by the owner). Report: `…/tbd-01-reload-hammerspoon/report.md`; its ledger delta applied (F-HS-7 corrected: `getConsole()` returns a string via `hs -c`). |
| `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-02-copilot-history` | M5 investigation (⟂) | 2026-10-05 answers-reviews-m5 | Copilot history formats, human-vs-automated rules, synthetic fixtures | completed. Report `…/tbd-02-copilot-history/report.md`; topic file `.github/copilot-history-formats.md`; fixtures `test-fixtures/prompt-history/` (generator `…/tbd-02-copilot-history/generate-fixtures.ts`). Delta applied (its D-38 → D-43). |
| `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7` | M7 → M11 (top-level handover, D-47) | 2026-10-05 answers-reviews-m5 | Successor top-level session: UI infrastructure and onward | completed: **M7 done** (commit "M7: UI infrastructure …") + debug panic-eject; handed over to tbd-04 (D-51). Report `…/tbd-03-continue-m7/report.md`. |
| `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8` | M8 → M11 (top-level handover, D-51) | 2026-10-05 tbd-03-continue-m7 | Successor top-level session: notes, menu, summary, review, and onward | completed: **M8 + M9 done** (commits "M8: …", "M9: …"); handed over to tbd-05 (D-58). Report `…/tbd-04-continue-m8/report.md`. |
| `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/tbd-05-continue-m10` | M10 → M11 (top-level handover, D-58) | 2026-10-05 tbd-04-continue-m8 | Successor top-level session: enforcement and onward | launched 2026-10-05 (`--no-wait`); owns the ledger. **M10 done** (commit "M10: …"; live enforcement approved, D-62); continuing with M11. Report `…/tbd-05-continue-m10/report.md`. |

---

## 6. Decision log (newest last; never delete — mark superseded)

| # | Date | Decision | Why |
|---|---|---|---|
| D-1 | 2026-10-04 | The goal is protecting Fri/Sat energy; hours are the proxy. Friction not prohibition; kind wording; close-the-loop (context-memory) at every stop. | Root-cause analysis with the owner (instructions §1). |
| D-2 | 2026-10-04 | Policy inputs are worked time per day/week only; clock times only for the 04:00 boundary. | Owner: "Exact hours are never important." |
| D-3 | 2026-10-04 | Block lasts until 04:00; only tokens or emergency bypass open it. | Owner choice. |
| D-4 | 2026-10-04 | Initial policy per R-POL-2 (9 h on Sun/Tue/Thu, 44 h/week, ladder 75 % / −30 / −10). | Owner: "conjure a reasonable policy; I'll change it later." |
| D-5 | 2026-10-04 | Architecture: thin Hammerspoon Lua (sensors/actuators/supervisor) + Node 26 TS daemon (all logic), HTTP on 127.0.0.1 with token; UI = `hs.webview` pages served by the daemon. | Testable logic in TS; Lua limited to what only it can do. |
| D-6 | 2026-10-04 | Lua spawns the daemon via `hs.task` (no launchd plist). | Keeps the "single `require` line" footprint; Hammerspoon supervises. |
| D-7 | 2026-10-04 | JSONL per 04:00-day in `data/YYYY-MM/`; append-only; event-sourced notes; last-wins minute records. | Git-able, crash-tolerant, mergeable. |
| D-8 | 2026-10-04 | Policy config = typed `config/policy.ts`, hot-reloaded. | Typechecked, easy per-weekday editing. |
| D-9 | 2026-10-04 | Zero runtime dependencies; npm; `node --test`; `tsc --noEmit`. | Small and boring; mirrors owner's baseline (`storm/.github`). |
| D-10 | 2026-10-04 | Camera provider deferred; architecture must support it. | Owner. |
| D-11 | 2026-10-04 | Inactivity = no input (incl. scroll) for 5 min; dialog with back / whole / some(slider); auto-close 04:00. | Owner. |
| D-12 | 2026-10-04 | All activity on this computer is work (no app filtering); top-3 apps (≥ 5 s/min) recorded for insight. | Owner: personal work happens on another computer. |
| D-13 | 2026-10-04 | Morning review skipped on Fri/Sat mornings; Thursday's notes surface Sunday 04:00. No popups on Saturday at all. | Protect private day and Shabbat. | *(Review schedule superseded by D-35.)*
| D-14 | 2026-10-04 | Quit is a simple confirm + logged gap; unreachable during a block because the overlay covers the menubar. | Owner. |
| D-15 | 2026-10-04 | Fail open on internal errors; panic escape hatch is a prerequisite of the block. | Never trap the user because of a bug. |
| D-16 | 2026-10-04 | Prompt-history stores counts/timestamps only; never text. | Data is git-able; privacy. |
| D-17 | 2026-10-04 | Day key via local civil 04:00 (calendar arithmetic), not `t − 4h`. | DST correctness (design review). |
| D-18 | 2026-10-04 | Worked time = interval arithmetic at second precision; `work` digest computed on demand, never persisted. | Unambiguous budgets; later providers/resolutions apply retroactively. |
| D-19 | 2026-10-04 | Inactivity "whole"/"some" credit includes locked/asleep time within the gap. | Owner locks the screen when leaving for meetings — that is work. |
| D-20 | 2026-10-04 | `panic` and `quit` are Lua-side latches that override reconciliation; panic lasts until 04:00 or `resume()`. | Otherwise the next heartbeat re-creates the block / supervisor restarts the daemon. |
| D-21 | 2026-10-04 | Port bind = daemon mutex (no lockfiles); runtime files namespaced `var/<env>/`; dev daemon is browser-only. | Stale lockfiles after crashes; safe dev beside live. |
| D-22 | 2026-10-04 | Single ledger writer: tbd-launched sessions return a `## Ledger delta`; the launching session applies it. | Concurrent sessions would clobber the ledger. |
| D-23 | 2026-10-04 | First live install into `~/.hammerspoon/` only with the owner's explicit consent; scripts testable via `--hammerspoon-dir`. | Never surprise the owner's live setup. *(First install done with consent; see D-26.)* |
| D-24 | 2026-10-04 | The daemon is spawned **detached** through an `hs.task` shell (`/bin/sh -c '… &'`), supervised via `daemon.json` + `/health` (not the task exit callback). Still `hs.task`, so D-6 holds. | Verified: direct `hs.task` children are killed by `hs.reload()`; detached grandchildren survive → adoption works (`.github/hammerspoon.md` H-3). |
| D-25 | 2026-10-04 | `reload-hammerspoon` sets a `_WB_RELOAD_PENDING` global before reloading; health polling treats it as "reloading". | The old Lua state may answer `ok` in the 0.2 s before the reload — never a false success. |
| D-26 | 2026-10-04 | Copilot sessions may **change and reload Hammerspoon freely, without asking** (still: only our own `work-balancer.lua` + the one `require` line; never other modules; no reload loops; never show test UI / enforcement on the live instance without consent). | Owner, at the M1 live install. |
| D-28 | 2026-10-04 | Coverage = Lua's sample spans (`since` → `sentAt` per heartbeat), not the daemon's uptime. A daemon outage while Lua runs loses nothing (Lua's outbox re-delivers; ingest is idempotent) and is **not** a gap; `monitor.gap` only for holes in Lua coverage (> 30 s, minus sleep). | Honest gaps; restarts are free. |
| D-29 | 2026-10-04 | `interactive` stores input as **runs** (instants ≤ 2 s apart joined); minute records omit zero/empty fields; fully asleep minutes are not written. Daemon crash ⇒ up to ~70 s of unflushed minutes may be lost (recorded as a `daemon-down` gap). | Exact busy union with compact files (≈ 1 short line per awake minute). |
| D-30 | 2026-10-04 | `work` digest = pluggable `WorkSource`s (activity runs, blocked, credited) and is clipped to *now*; M4's menubar limit/colour lives in `src/policy/observe.ts` (`effectiveLimit`, `statusColour`) for M6 to build on. All user-facing strings in `src/ui/strings.ts`. | M5/M9 plug in without touching `work`; one place to review tone. |
| D-31 | 2026-10-04 | Each raw provider decides which minutes deserve a record. `interactive` writes none for a minute **without input that was entirely locked/asleep** (supersedes the "fully asleep" part of D-29 and the "every monitored minute" wording of §2/M4). Locked/asleep totals come from the `system` timeline; locked/asleep time is never a `monitor.gap`. | Owner (Q-11): less data, no information lost. |
| D-32 | 2026-10-05 | One menubar menu on **any** click; first item *Quick note…* (supersedes left-click = quick note; F-HS-4 no longer matters). | Owner (Q-1). |
| D-33 | 2026-10-05 | Inactivity dialog preceded by a ~10 s pre-warning dim; input cancels it. | Owner (Q-2): reading ≠ away. |
| D-34 | 2026-10-05 | R-UI-QUIET: effects never start within 10 s of input (bounded deferral, Q-13). | Owner (Q-3): never land mid-keystroke. |
| D-35 | 2026-10-05 | Only Sun/Tue/Thu are intrusive; Mon/Wed/Fri/Sat menubar only (no inactivity dialog, break nudge or morning review there; supersedes D-13's review schedule: notes now surface on Sun/Tue/Thu mornings). Consequence: no inactivity credits on Mon/Wed/Fri, so off-computer work on those days is not counted toward the weekly budget. | Owner (Q-4). |
| D-36 | 2026-10-05 | Notes: no delete, no purge — dismiss/un-dismiss only; `note.deleted` dropped from the data model. | Owner (Q-5): notes are temporary reminders. |
| D-37 | 2026-10-05 | **Before every commit, an adversarial review subagent checks the change**; findings are triaged (fixed, or recorded why not) before committing. M1–M4 commits were reviewed retroactively. | Owner. |
| D-38 | 2026-10-05 | Sensors: an input is only an idle-counter **reset** (H-7); a synthetic `wake` only > 60 s after an unmatched sleep; the heartbeat's `locked` flag repairs the timeline only when the newest lock/unlock event is > 10 s old. | Live data 2026-10-04 (phantom inputs, false wake) + review M4#1 (fake lock/unlock pair on every unlock). |
| D-39 | 2026-10-05 | The panic latch is persisted (`var/live/panic.json`); Lua sends `panicAt`, the daemon decides the 04:00 expiry (`panicExpired`) and logs `panic`/`resume` once per transition (state restored from today's records). | Review M3#4/#5/#7: a reload must not bring a block back; no day logic in Lua. |
| D-40 | 2026-10-05 | Supervisor: heartbeat → `503` until the tracker is ready (Lua keeps samples); spawn only on connection-refused / missing `daemon.json`; a daemon that times out 4× in a row is verified by command line and killed (TERM → KILL) and respawned; fast backlog drain only after a 200. | Review M3#1/#2/#3/#6. |
| D-41 | 2026-10-05 | `store.append` returns null on failure; `interactive` retries failed minute/system writes; a write error stays visible ≥ 10 min. Other records (gaps, daemon/config events) are logged-only on failure (rare, low value). | Review M1#1. |
| D-42 | 2026-10-05 | Live env refuses `WB_PORT` (≠ 47621) and `WB_FAKE_NOW`. `reload-hammerspoon`: a commented-out require line = owner disabled it (never re-added); refuses to re-point to another checkout without `--force`; byte-transparent (latin1) atomic write. | Review M1#2/#6/#8. |
| D-43 | 2026-10-05 | `prompt-history` provenance: the agent-host turn-id format (`request_*` vs bare UUID) is the primary signal, runner boilerplate markers outrank it, subagents by `agentId`/`source`; undecidable cases (retries, `github/cli`, runner follow-ups without corroboration, missing turn rows, cancelled asks) go to `unclassified`. Text is read in memory only; nothing derived from text (not even hashes) is persisted. | Deterministic for the owner's main mode; verified on ground-truth sessions (tbd-02). |
| D-44 | 2026-10-05 | `prompt-history` keeps no persisted cursors: on start it re-scans today's changed history files (< 0.5 s) and rewrites no unchanged minute; a minute is never re-emitted with fewer interactions than its persisted record. | Simpler and restart-proof; the ledger's "cursors in var/" was only a means. |
| D-45 | 2026-10-05 | A `blocked` level **latches until 04:00** (worked time may shrink later: late lock events, re-resolved inactivity credits) under the key `<config hash>@<daemon version>`: a config edit or a daemon version bump (a bug fix) releases it. `policy.transition` records carry the key. Editing `tokensMin` mid-day may yield extra tokens — accepted (explicit owner act). | Review M6#3 + principle 5 (never trap the owner because of a bug). |
| D-46 | 2026-10-05 | No ladder level above `ok` before the first **real** activity of the day (input or human prompt — not a grace window carried over from before 04:00); effective limit floored to whole seconds; Saturday is non-intrusive by construction (evaluator + config validation); a non-enforcing day with a budget uses it as colour reference; grant records are only today's, clipped to `[ts, 04:00]`. | Review M6#1/#5/#6/#7/#8; Q-3's "nobody is blocked at 04:00 while asleep"; principle 6. |
| D-47 | 2026-10-05 | **Top-level handover:** the session `2026-10-05--08-37--answers-reviews-m5` ends after launching `tbd-03-continue-m7` (via `execute-copilot-session`, `--questions free-to-ask`), which becomes the single top-level / ledger-writing session and continues M7 → M11 under the same standing rules (D-26, D-27, D-37, D-45) plus a live-effects gate (new effects hard-disabled for `live` until the owner approves enforcement in M10; no live `panic()` as a test). Successors hand over the same way when their context grows. | Owner: this session's context is very large; continue in a fresh session. |
| D-48 | 2026-10-05 | **Live gate** = `liveEffects` in `config/policy.ts` (default false): system-initiated (*intrusive*) effects run on the live instance only when true; dev ignores it. User-initiated windows (from the menu, M8) and explicitly requested `test` windows (`live: true`, TTL ≤ 120 s, owner consent) are exempt. Panic and R-UI-QUIET still apply to them. | Task tbd-03 live-effects gate; the owner's own file is the most visible place for the switch. |
| D-49 | 2026-10-05 | **Debug panic-eject** (R-UI-EJECT): Lua-only label on full-screen windows + ⌃⌥⌘⇧**F12** **press** (owner's original Esc is swallowed by macOS — H-9) terminates Hammerspoon while enabled (default on, `WorkBalancer.debugEject(bool)`, persisted). Same combo as the panic hotkey on purpose: when eject is on, eject wins. Limitation: a Hammerspoon whose main thread is frozen (H-6) cannot run any hotkey — `kill` from a terminal remains the last resort. | Owner: a safety net against buggy blockers locking the computer, before any real block exists. |
| D-50 | 2026-10-05 | M7 window contract: effects declare windows (`mode`, `placement`, `perScreen`, `focus`, `intrusive`); the manager adds `rev` + `opacity`; anything covering a screen is always intrusive; Lua's kill-switches key on `intrusive or covers-screen`; pages must say `ready` within 15 s or fail open (screen-covering: closed after 5 s; quarantine doubles); a window already shown today is never deferred by R-UI-QUIET; 6 × 503 ⇒ fail open; `effect.*` audit rebuilt from the day's records, unreported disappearance = `closed by reload`. `overlayOpacity` (owner: 0.7) for screen-covering windows; page fonts +50 % (owner). | Owner requests + adversarial review M7 (8 findings). |
| D-51 | 2026-10-05 | **Top-level handover** after M7: `tbd-03-continue-m7` ends and launches `tbd-04-continue-m8` (`execute-copilot-session --model claude-opus --context long --questions free-to-ask --no-wait`), which becomes the single top-level / ledger-writing session for M8 → M11 under the same rules (D-26, D-27, D-37, D-45, live gate D-48, eject D-49) plus the owner's call-to-action preference before live visual stages. | Owner chose a fresh session at the M7 checkpoint (large context). |
| D-52 | 2026-10-05 | **Menu windows** (`quick`, `notes`, `summary`, `quit`) are user-initiated `floating` windows with focus (not `normal`: Hammerspoon has no Dock icon, a window lost behind VS Code would be unreachable); never intrusive, never screen-covering, so not gated live. The menu items come from the daemon (`strings.menu`, in every menubar spec); a click posts `/bridge/ui-request`; clicking an open one raises it (`window.focus`); a click within 2 s of the window closing reopens it. A restarted daemon **adopts** open windows (first heartbeat); a Hammerspoon reload ends them. Note edits change the text only; waiting notes oldest first, dismissed most recent first. | Owner wants the menu to "just work"; restarts must not lose his typing. |
| D-53 | 2026-10-05 | **Morning review** is decided once per day by the `day.rollover` record (`review: true` on a `morningReview` day with notes waiting at the first tick of the day) — so a later restart neither invents nor loses it; it is shown (floating, **no focus**, intrusive ⇒ live gate / R-UI-QUIET / panic apply) until closed by the owner (`effect.closed` by user/page = done for the day; reload/fail-open bring it back). A click gives the window focus (`focusOnInteract`). | R-UI-REVIEW + "never steal keystrokes" + data-driven state. |
| D-54 | 2026-10-05 | The bridge **token persists** in `var/<env>/token` (0600) across daemon restarts. | Review M8#1: pages carry the token in their URL; an adopted window would otherwise get 401 forever. Same-user local secret either way. |
| D-55 | 2026-10-05 | **Owner's UI conventions:** Esc closes every dismissible window (first Esc only warns when a box holds unsaved text; a note editor takes Esc first; never on countdown/block); Cmd+Enter submits a text box; large windows (summary, notes) are 90 % of the screen with a static top bar (title + big ✕, no bottom Close) and an inner box 20 px from every side that scrolls; review button "Let's start this day!". Window `w`/`h` in (0, 1] = fraction of the screen. | Owner, 2026-10-05 (M8 visual review); Esc guard from review M8#4. |
| D-56 | 2026-10-05 | **Inactivity dialog = full screen, un-escapable, no timeout; input while it is up does not end the gap** (supersedes R-UI-INACT's corner window / multi-gap list): a gap ends at the owner's first input made while the dialog was **not** on screen (from the `effect.shown`/`effect.closed` audit; a suppressed/closed dialog lets input end it) or at Submit; at most one unanswered gap; inside `[lastInput + grace, end)` only the credit counts. Slider "Worked N min of M" with presets; Submit after a deliberate touch. `overlayOpacity` 0.8. | Owner, live trial 2026-10-05: "This has to be full screen, un-escapable, un-timed-out"; moving the mouse over the dialog is not being back. |
| D-57 | 2026-10-05 | **Inactivity robustness:** gaps are detected only while Lua's sensors are fresh (≤ 15 s) and never while panicking; a dialog period ends at any close or at a hole in Lua's coverage; human prompts end a gap like input; a gap missed because the Mac slept (the wake heartbeat already carried the key press) is detected **retroactively** within 2 min of the return (hole ≥ grace + 30 s, coverage continuous, locked/asleep inside, dialog allowed throughout); a resolution whose record cannot be written is applied in memory and retried, and no dialog shows while the store has a write error. | Adversarial review M9 (principle 5: never trap; never erase real work). |
| D-58 | 2026-10-05 | **Top-level handover** after M9: `tbd-04-continue-m8` ends and launches `tbd-05-continue-m10` (`execute-copilot-session --model claude-opus --context long --questions free-to-ask --no-wait`), the single top-level / ledger-writing session for M10 → M11 under the same rules (D-26, D-27, D-37, D-45, gate D-48, eject D-49, conventions D-55/D-56). | Owner approved at the M9 checkpoint (large context; M10 is the biggest milestone). |
| D-59 | 2026-10-05 | **M10 enforcement design:** four audited intrusive effects driven by the policy state + today's records (a level *entry* = the latest `policy.transition` into it; `warn` dismissed / `nudge` snoozed = `effect.closed` by user/page, also kept in memory for write errors); one warn dim pulse per entry; block not shown while the store cannot write (fail open); the bypass sentence compared ignoring case/spacing/punctuation; the countdown's typed text carried into the block; nudge ✕/Esc = snooze, "taking a break" = quiet for the stretch; borrowed time shown in the menubar only (`⏳Nm`, no re-warning); a restarted daemon re-shows today's windows without R-UI-QUIET (`shownToday` from the audit); once a token/bypass was used today the block returns **immediately** (`WindowInput.immediate`, R-POL-3a); a view whose screen became primary is rebuilt (tokens/bypass live on the primary instance); failed `policy.transition` writes are retried. Version 0.7.0. | Announced defaults (owner did not object) + adversarial review M10 (6 + 2 findings). |
| D-60 | 2026-10-05 | **Countdown Save = done for today** (`budget.forfeited` → evaluator `blocked` until 04:00, independent of the latch key; tokens/bypass still work). Only a save that kept something forfeits; Cmd+Enter does not save there. | Owner, after the live trial: "clicking Save should be considered as forfeiting the remaining minutes". |
| D-61 | 2026-10-05 | **No Quit at countdown/blocked** on an enforcing day with the live gate open (menu item hidden, confirm refused) — unless nothing can be enforced (panic, write error). `hs -c 'WorkBalancer.quit()'`, panic and the eject remain (explicit acts). Non-full windows: opaque title bar via `fullSizeContentView` + page padding (Lua 0.6.0, H-15). | Review M10#5 (a 5-min token opened the way to Quit = the rest of the day unenforced); owner: title bar see-through, hard to drag. |
| D-62 | 2026-10-05 | **Live enforcement approved by the owner** — the session set `liveEffects: true` with his explicit consent (~16:40, a Monday: first intrusive day Tue 2026-10-06 04:00). The debug eject stays ON until he trusts the blockers. | M10 AC; owner: "Yes — you flip liveEffects to true now". |
| D-27 | 2026-10-04 | At milestone checkpoints: **commit** (never `data/`, `var/`, or files that aren't the session's, e.g. `_PRIVATE-SCRATCH.md`) and **proceed** to the next milestone without asking — stop to ask only for a real blocker. | Owner, at the M1 checkpoint. |

---

## 7. Open questions (non-blocking; current default in **bold**)

| # | Question | Current default | Status |
|---|---|---|---|
| Q-1 | Should the right-click menu be reachable if `hs.menubar` cannot distinguish right-click? | **Fallback: Ctrl-click or an eventtap on `rightMouseDown` within `menubar:frame()`; last resort: left-click menu whose first item is "Quick note…".** | Owner: any click (left or right) opens the menu. **closed → D-32** (2026-10-05) |
| Q-2 | Inactivity dialog appears while the owner is *reading* (5 min without input). Annoying? | **Keep 5 min (owner's call); revisit after soak.** | Owner: 5 min is OK; add a ~10 s pre-warning dim, input cancels. **closed → D-33** (2026-10-05) |
| Q-3 | Effective limit ≤ 0 on an enforcing day (weekly budget exhausted): is blocking at the first worked second (R-POL-2 ladder arithmetic) too harsh? | **Yes it blocks, after a kind explanation screen; tokens/bypass available.** Consider a floor (e.g. 2 h) after soak. | Owner: OK as designed; plus no effect within 10 s of input. **closed → D-34** (2026-10-05) |
| Q-4 | Should non-enforcing days (Mon/Wed/Fri) show the warn dialog at 9 h without blocking? | **No — colours only.** | Owner: no — only Sun/Tue/Thu are intrusive at all; other days menubar only. **closed → D-35** (2026-10-05) |
| Q-5 | Note deletion is a tombstone; the text remains in an older day file (and in git history). Need a real purge tool? | **Tombstone; a manual `scripts/purge-note` later if wanted.** | Owner: never purge; no delete — dismiss only. **closed → D-36** (2026-10-05) |
| Q-6 | Should using a token require writing a context-memory first? | **No — scarcity is the friction.** | Owner: no. **closed** (2026-10-05) |
| Q-7 | Saturday-night (after Shabbat) work belongs to the ending week (Sat day key). Fine? | **Yes, per R-TIME-2.** | Owner: yes. **closed** (2026-10-05) |
| Q-8 | Synthetic input from `copilot-retry-watcher` likely resets HID idle time → phantom busy minutes. Filter? | **Accept for now (rare); revisit if visible in data.** | Owner: ignore (rare). **closed** (2026-10-05) |
| Q-9 | Auto-commit `data/` daily? | **No; owner commits manually.** | Owner: no. **closed** (2026-10-05) |
| Q-10 | Fixed port `47621` acceptable? | **Yes; dev = `47622`; both overridable via env.** | Owner: yes. **closed** (2026-10-05) |
| Q-11 | The Mac rarely sleeps (copilot-retry-watcher holds the display awake during chats), so `interactive` writes ≈ 1 line per minute even while locked (≈ 100–250 KB/day in `data/`). Acceptable, or skip fully-locked idle minutes? | Owner: *"The specific info provider decides. In our case — yes, skip."* | **closed → D-31** |
| Q-12 | Menubar colours: green `(0.20,0.66,0.33)`, orange `(0.93,0.55,0.05)`, red `(0.86,0.22,0.18)`, grey; title `⏱ h:mm / h:mm`. Owner's visual check pending. | **As implemented.** Owner noticed clicks show no menu; asked about an interim menu → **no, keep menus in M8 as planned** (2026-10-04). | open (colours) |
| Q-13 | R-UI-QUIET: maximum deferral of a due effect while the owner keeps typing? | **2 min** — then the effect starts anyway (otherwise an absorbed owner typing non-stop could postpone a block forever). | open |
| Q-14 | `github/cli` sessions (mostly headless `copilot -p` tool calls, sometimes possibly the owner in a terminal)? | **unclassified** | open |
| Q-15 | copilot-retry-watcher clicks are visible only in the Hammerspoon console; give work-balancer a hook to classify retries exactly? | **No — retries stay unclassified; revisit if the bucket grows.** | open |

---

## 8. Facts discovered (environment & external formats — verified 2026-10-04 unless marked)

### Environment
- **F-ENV-1** Shell default `node` is **v20.19.5** (nvm). Installed: v20.19.5, v24.16.0, **v26.7.0**
  (`~/.nvm/versions/node/v26.7.0/bin/node`). `npm`/`yarn` on PATH belong to v20 → always go through `scripts/run-node`.
- **F-ENV-2** Baseline conventions to mirror: `~/go/src-4/storm/.github/package.json` and `tsconfig.json`
  (Node ≥ 26 type stripping, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`,
  `typescript ^7`, `@types/node ^26`).
- **F-ENV-3** `scripts/execute-copilot-session` is a wrapper → `~/go/src-4/storm/.github/copilot-tbd-sessions/execute-copilot-session`
  (external dependency; if it breaks, it's not this repo's code). `--model` is required (or `$COPILOT_MODEL`).
- **F-ENV-4** Timezone: Asia/Jerusalem (UTC+3 in summer, +2 in winter).
- **F-ENV-5** Node 26.7.0 type stripping (verified 2026-10-04): `satisfies` and `import type` are erased fine;
  `enum` and constructor parameter properties are rejected at load ("not supported in strip-only mode");
  `module.stripTypeScriptTypes(code)` exists (for serving page scripts, M7); a `.ts` module re-imported with a
  different `?v=<n>` query is re-evaluated (hot-reload works; same query → cached). `typescript` latest = 7.0.2
  (`tsc` binary present), `@types/node` 26.6.4.
- **F-ENV-6** `scripts/execute-copilot-session` (vscode harness) originally opened sessions in the storm window
  regardless of cwd; the owner fixed it on 2026-10-04 (it now prints `Repo: <git toplevel of cwd>`). Run it from this
  repo's directory.

### Hammerspoon
- **F-HS-1** `hs` CLI at `/opt/homebrew/bin/hs`; Hammerspoon 1.1.1. `~/.hammerspoon/init.lua` (as of 2026-10-04, after
  our install): `require("playwright-focus-guard")`, `require("copilot-retry-watcher")`, `require("work-balancer")`
  (`copilot-chat-opener` is gone). The owner keeps `init.lua.bak.<epoch>` backups there. Hotkeys already taken:
  `⌘⌃⌥P` (playwright-focus-guard), `⌘⌃⌥R` (copilot-retry-watcher).
- **F-HS-2** `copilot-retry-watcher.lua` auto-clicks VS Code Copilot "Try Again" buttons (raising windows, synthetic
  mouse events) and **keeps the display awake while a chat is in flight** (toggle Cmd+Alt+Ctrl+R; menubar 🔁/⏸).
  Consequences: (a) display-awake ≠ owner present; (b) synthetic input may reset idle time (Q-8);
  (c) its clicks land at VS Code button coordinates — if our overlay is on top, they could hit our buttons → two-step
  confirm for consequential actions (R-UI-BLOCK).
- **F-HS-3** Agents keep running during a block — by design (delegated work is fine; the block protects the owner).
- **F-HS-4** *(verified 2026-10-05)* With `hs.menubar:setMenu(fn)` both left and right click open the menu (H-14).
- **F-HS-5** *(verified 2026-10-05)* `hs.webview` typing needs `allowTextEntry(true)` **and** key focus
  (`hswindow():focus()`) — H-10; overlay at `screenSaver` level + `canJoinAllSpaces|fullScreenAuxiliary|stationary`
  covers both monitors and full-screen apps and captures all input — H-11. (`hs.task` across reload: → F-HS-8.)
- **F-HS-13** *(2026-10-05)* macOS swallows **⌘⌥Esc** (Force Quit) even with ⌃⇧ added: no app/eventtap ever sees the
  Esc — the panic/eject combo is ⌃⌥⌘⇧F12 (hammerspoon.md H-9). `os.exit(0)` in Lua terminates Hammerspoon (H-12).
- **F-HS-6** `hs.host.idleTime()` returns **integer** seconds → input instants known to ±1 s (sample every 1 s).
- **F-HS-7** `hs.http.asyncPost`: refused → status `-1` immediately; unanswered → status `-1` "request timed out"
  after ~61 s; no cancel. `hs.console.getConsole()` returns a string via `hs -c`; use the tolerant form
  `local c = hs.console.getConsole(); return type(c)=="string" and c or c:string()`.
- **F-HS-9** `hs.task`'s exit handler reads leftover stdout **synchronously on the main thread**: a surviving process
  holding the pipe freezes all of Hammerspoon (H-6). Background only simple commands with all fds redirected.
- **F-HS-10** `hs.json.decode`: JSON `null` → `nil`; `hs.json.encode({})` → `[]`; integers (epoch ms) encode exactly.
  `hs.styledtext.defaultFonts.menuBar` = `.AppleSystemUIFont` 13 pt. Hyper hotkeys show as `✧` in `getHotkeys()`.
- **F-HS-11** Live sensors (2026-10-04): continuous typing yields one input instant per second; the owner's Playwright
  browser shows up as app `com.google.chrome.for.testing` ("Google Chrome for Testing") when it takes the foreground.
- **F-HS-12** *(2026-10-05, live data)* While locked with the display asleep, `hs.host.idleTime()` grows **slower than
  the wall clock** (~11 s per 12 s): `now − idle` creeps forward → phantom inputs, and each re-emitted the same minute
  (up to 60 records/minute; 2 596 lines for 91 minutes on 2026-10-04). Fix: only an idle-counter *reset* is an input
  (`hammerspoon.md` H-7). Also: Lua keeps heartbeating ~1 s after `systemWillSleep` → a synthetic wake must not be
  inferred from that (fixed: only > 60 s after the sleep).
- **F-HS-8** `hs.reload()` **kills direct `hs.task` children**; a grandchild backgrounded by an `hs.task` shell survives
  (→ D-24). Details and method: [hammerspoon.md](./hammerspoon.md) §1.

### Copilot local history (for `prompt-history`, M5)
- **F-COP-1** `~/.copilot/session-state/<sessionId>/` (~6.7 k dirs): `events.jsonl` + `workspace.yaml`.
  `workspace.yaml` has `client_name` — seen: `vscode-agent-host` (**VS Code sessions via the agent host — the owner's
  current main mode**), `vscode`, `github/cli`, `copilot-intellij`. So "VS Code only" still means this store too.
- **F-COP-2** `events.jsonl` lines: `{type, data, id, timestamp (ISO), parentId}`. Human prompts: `type:"user.message"`;
  `data` keys include `content`, `transformedContent`, `attachments`, `delivery`, `interactionId`, `turnId`,
  `parentAgentTaskId` — set on **every** `user.message` (human ones too): it does **not** mark subagents (corrected
  2026-10-05). Subagent traffic: top-level `agentId` + `data.source = "agent-<parent sessionId>"`. Agent question answers: `tool.execution_start` with
  `data.toolName:"ask_user"` + matching `tool.execution_complete` (`data.toolCallId`) whose
  `toolTelemetry.properties.outcome == "answered"` and result like `"User selected: …"` (or
  `elicitation_action == "accept"` in `github/cli`).
- **F-COP-3** Sessions launched by `execute-copilot-session` (and test harness runs) also appear here; their first
  `user.message` is the prompt file — **not** human input. Must be filtered (M5).
- **F-COP-4** VS Code native chat: `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl`
  (~1.8 k files) and `.../globalStorage/emptyWindowChatSessions/*.jsonl`. Op-log format: `kind:0` = initial snapshot
  (`v.requests`), `kind:1` = set at path `k`, `kind:2` = push at path `k` (e.g. `k:["requests"]` pushes a request with
  `timestamp` (epoch ms), `message.text`, `hiddenFromTranscript`, `modeInfo`, …). Files can be several MB → incremental
  reading required.
- **F-COP-5** *(re-measured 2026-10-05)* The owner moved from the VS Code native agent to VS Code agent-host sessions
  around 2026-09-24. In the 45 days before 2026-10-05 the CLI store had 206 `user.message`s (152 of 202 sessions are
  `github/cli` — mostly headless `copilot -p` tool calls) and VS Code native had 1 648 requests. 2026-09-27 → 10-04:
  no activity.
- **F-COP-6** VS Code agent-host turn index: `~/Library/Application Support/Code/agentSessionData/<ahId>/session.db` —
  `session_metadata.defaultChatProviderData` (or `agentHost.chatProviderData`) `.sdkSessionId` → CLI session id;
  `turns(id, event_id)` maps each main-agent `user.message` id to its turn. Turn ids `request_<uuid>` come from the
  VS Code UI, bare `<uuid>` from `execute-copilot-session`/other AHP clients. Several dbs may share one sdkSessionId → merge.
  The dbs use a rollback journal (not WAL): read a byte copy, never VS Code's file in place (a SHARED lock could make
  its commit fail).
- **F-COP-7** Agent-host sessions are **not** mirrored into VS Code's `chatSessions` store (no cross-store double
  counting). Inside the CLI store, continued sessions are copied with the same event ids and timestamps → dedupe by
  event id. `events.jsonl` is append-only (51/52 resume offsets exact).
- **F-COP-8** VS Code native chat op-log: kind 0 initial / 1 set / 2 push (`i` = truncate to i first; no `v` = pure
  truncate) / 3 delete; after > 512 entries the file is **rewritten** as a single kind:0. Requests: `timestamp` epoch
  ms, `isSystemInitiated` for VS Code-initiated ones; `vscode_askQuestions` answers = `questionCarousel` parts with
  `isUsed` + `data`, no timestamp.
- **F-COP-9** `execute-copilot-session` appends fixed boilerplate to every prompt (`WORKING AGREEMENT: …` since
  2026-09-09, `TASK OUTCOME: …`, and before 2026-09-09 `the very LAST thing you do MUST be to rename the prompt file`).
  VS Code Insiders is not installed; `~/.copilot/session-store.db` is a stale index (last write 2026-09-25).

---

## 9. Session log

| Date | Session / tmp-folder | Summary | tbd files |
|---|---|---|---|
| 2026-10-04 | Design session (ran from `~/gits/GILAD-PRIVATE-BRANCH`; no tmp-folder in this repo) | Problem analysis with the owner; requirements, policy, architecture; created `copilot-instructions.md` and this ledger; independent design review applied (D-17…D-23). | — |
| 2026-10-04 | `.github/tmp/2026-10-04--16-19--kickoff-m1-m4/` | Kickoff M1→M4, all done; **observe mode live**. M1 scaffolding + reload-hammerspoon (tbd-01) + live install; M2 core/store/config; M3 daemon/bridge/supervisor (incident: hs.task pipe freeze, H-6); M4 interactive/work/menubar. Facts F-HS-6..11, F-ENV-5..6; decisions D-24..D-30. | tbd-01 |
| 2026-10-04 | (same tmp-folder, follow-up) | Q-11 → D-31 (skip idle fully-locked/asleep minutes; locked time never a gap); moved reload-hammerspoon logic + tests to `src/hammerspoon/` (owner's TODO); Q-12: no interim menu. 88 tests. | — |
| 2026-10-05 | `.github/tmp/2026-10-05--08-37--answers-reviews-m5/` | Owner's answers Q-1…Q-10 → D-32…D-36; review rule D-37; live-data bugs fixed (phantom inputs, false/dark wake); retroactive adversarial reviews of all commits + 2 review rounds on the fixes — 31 findings, all fixed or justified (D-38…D-42); tbd-02 M5 investigation applied (D-43, F-COP-6…9). 106 tests. **M5 implemented** (readers, classifier, minute records, dry-run report; review + 2 re-checks; D-44). **M6 done** (pure evaluator, ladder transitions logged, latch; review + re-check; D-45, D-46; version 0.4.0). 133 tests. Handed over to tbd-03 (D-47). | tbd-02, tbd-03 |
| 2026-10-05 | `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/` | Successor top-level session (D-47). **M7 done**: effects contracts/reconciler/manager (live gate D-48), test effect, page serving with type stripping, Lua window manager + dim + fail-open, owner's **debug panic-eject** (R-UI-EJECT, D-49; Esc impossible → F12, H-9) and `overlayOpacity`; live visual checks with consent; review 8 + 2 findings fixed (D-50); `ui-and-tone.md`. 147 tests. Handed over to tbd-04 (D-51). | tbd-04 |
| 2026-10-05 | `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/` | Successor top-level session (D-51). **M9 done** (inactivity dialog, owner's redesign D-56 after a live trial, robustness D-57, 0.6.0, 177 tests); handed over to tbd-05 (D-58). **M8 done**: notes (event-sourced over all days), menu on any click (H-14), quick note + shared feedback form, notes manager, activity summary (4-week history), quit flow, `day.rollover`, morning review (gated live); owner's live visual review + UI conventions (D-55); review 6 findings fixed (token persisted, D-54); D-52…D-55. 164 tests. Backlog: "Feedback & energy" window after M11. | tbd-05 |
| 2026-10-05 | `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/tbd-05-continue-m10/` | Successor top-level session (D-58). **M10 done**: escape hatches verified live; `src/enforcement/` (warn + dim, countdown + pill, block with tokens / bypass / zero-limit explanation / week strip, break nudge), trial pages, Lua 0.6.0 (opaque title bars, primary-view rebuild), daemon 0.7.0; dev walk-through with a fake clock; owner tried every page live → D-60 (countdown Save ends the day), H-15; review 6 + 2 findings fixed (D-59, D-61); **owner approved live enforcement** (D-62). 184 tests. | — |
