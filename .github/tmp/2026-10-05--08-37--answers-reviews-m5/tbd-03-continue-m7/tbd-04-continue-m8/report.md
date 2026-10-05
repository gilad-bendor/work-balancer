# tbd-04 — successor top-level session (M8 → M11)

Tmp-folder: `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/`. Launched
2026-10-05 11:45 as the successor top-level session (D-51); owns the ledger.

## Plan given to the owner

M8 daemon side (store day listing, notes fold, ui-request + adopt + focus plumbing, effects quick/notes/summary/quit/
review, day.rollover, 4-week history) → pages (shared feedback module) → Lua menu (any click, daemon-down fallback,
page→Lua quit) → tests + dev walkthrough → owner reviews wording/visuals in DEV PREVIEW → review → commit; then M9 →
M10 → M11. Decided unless the owner objects: menu windows are `floating` (no dock icon ⇒ a normal window lost behind
VS Code would be unreachable); note edits change the text only.

## M8 checkpoint

### What was built
- Store: `listDays()`, uncached `scanDay(day, lineFilter)`.
- `src/notes/notes.ts`: pure fold of `note.*` over all day files + a writer that applies its own appends; validation
  (trim, ≤ 4000 chars, choices only from `feedbackChoices`, energy 1–5); no delete (D-36).
- Effects contract: `request` / `adopt` / `focusRequests`, `window.focus` command, `menu` in the menubar spec;
  manager: `POST /bridge/ui-request`, adoption on the first heartbeat, inferred reload closes reach effects.
- `src/effects/user-window.ts` (floating, focused, non-intrusive) and `src/effects/product.ts`: `quick`, `notes`,
  `summary`, `quit`, `review` (D-52, D-53). Tracker: `day.rollover`, summary model; `src/daemon/history.ts` (4 weeks).
- Pages: `quick`, `notes`, `summary`, `review`, `quit` + shared `feedback.ts`, `notes-view.ts`, `format.ts`; page
  helpers `topBar`, `closeOnEscape`, `submitOnCmdEnter`, `focusOnInteract`; all wording in `pageStrings`.
- Lua 0.5.0: `setMenu` (any click), `uiRequest`, page ops `focus` / `quit`, `window.focus`, fractional sizes,
  `quit(by)`, non-blocking local quit confirm. Daemon 0.5.0: persisted token (D-54), `app.quit`.
- Docs: data-format (note.*, day.rollover, app.quit, effect.* written), ui-and-tone (§4 windows, conventions),
  hammerspoon (H-14, menu).

### Verified
- `scripts/check` 164/164. Page scripts type-strip and parse (scratch `strip-check.ts`); headless-Chromium
  screenshots of every page against the dev daemon (fake Tuesday 09:00, seeded fake notes in `var/dev/data`).
- Owner, live: menu opens on left and right click; quick note / notes / summary "all looking very good"; then asked for
  the top bar + ✕ + 90 % + inner scrolling box, Esc, Cmd+Enter, "Let's start this day!" — done and confirmed ("Good!",
  "Looks good"). Review checked in DEV PREVIEW; a live `focus: false` floating test window (top right) — "looks good".
- Live gate: review not shown on live (`liveEffects: false`); menu windows are.

### Adversarial review (D-37)
Round 1 — 6 findings, all fixed: (1 high) adopted pages got 401 after a daemon restart → token persisted (D-54);
(2) a review closed before its first "shown" report was not audited → shown+closed written; (3) another note's
action discarded an open editor → drafts kept across re-renders; (4) Esc lost typed text → first Esc warns; (5) a
menu click while the window was closing was lost → reopen within 2 s; (6) `blockAlert` froze Hammerspoon →
`hs.dialog.alert`. Round 2: fixes 1–4, 6 sound; fix 5's 2 s window reopened a window closed on purpose right after a
raise → reworked to an order-based state machine (`closing` / `reopen`). Round 3: sound. Accepted leftovers: a ✕ click
followed by a menu click within the milliseconds before Lua's report is lost; a lost submit reply over 127.0.0.1 could
leave `closing` set (one spurious reopen later).

### Owner items
- Energy-survey window → backlog, after M11 (owner's choice).
- Still pending: sanity check of the M5 dry-run numbers (`scripts/prompt-history-report`); Q-12 (colours) open.

## M9 checkpoint

### What was built
- `src/inactivity/inactivity.ts`: gap detection (5 min idle → ~10 s pre-warning dim, input cancels → else
  `inactivity.detected`), one gap at a time, the full-screen un-escapable dialog (D-56), resolutions (`back` / `whole` /
  `some` / `expired` at 04:00) as a `work` source: credits + the in-gap override (dialog fiddling is not work).
  Input while the dialog is on screen does not end the gap (from the `effect.*` audit; a coverage hole ends a period).
- Page `inactivity` (live gap timer with seconds, slider "Worked N min of M" + presets, Submit after a touch; other
  screens: "Please answer on the main screen."). History includes credits. Test-effect trial mode (`page: inactivity`)
  and `WorkBalancer.preview(url, true)`. `overlayOpacity` 0.8.

### Verified
- `scripts/check` 175/175 (`src/inactivity/inactivity.test.ts`, 11 tests).
- Owner: two dev-preview rounds → his redesign (D-56: full screen, no Esc/timeout, one gap, input ignored while shown,
  slider-first, "Worked", Submit after touch); live pre-warning dim twice (cancelled by the mouse; ran 10 s and restored
  — "Good"; first attempt was deferred by R-UI-QUIET because he was using the mouse — as designed); live full-screen
  trial on both screens (answer logged only) — "That was perfect"; opacity → 80 %.

### Adversarial review (D-37)
Round 1 — 3 findings, all fixed: (high) Hammerspoon down/ejected → gaps detected without sensors, a dialog period that
never ended erased real work → detection only with fresh sensors, a period ends at a coverage hole or any close
(incl. reload), human prompts end a gap; (high) a failing resolve write would trap the owner behind the un-escapable
dialog → resolutions never fail (in memory + retry), no dialog while the store has a write error; (medium) gaps
recorded during panic → not while panicking. Version 0.6.0 (D-45). Round 2: the sensors-fresh rule missed a lid-closed
meeting whose wake heartbeat already carried the key press → **retroactive detection** (a recent return after a hole
≥ grace + 30 s, coverage continuous, the Mac locked/asleep in it, dialog allowed throughout). Round 3: two holes in that
(a prompt inside the last run → a second gap; breaks behind the gate/block/panic dug up) → max-end `lastInputAt`,
overlap check, `lastDisallowedAt`. Round 4: holds. 177 tests.

## Handover (D-58)

Owner approved a fresh session for M10 at the M9 checkpoint (large context). Successor prompt `tbd-05-continue-m10.md`
(in this tmp-folder; what exists for M10, suggestions, live gate, standing rules, open items), registered in the ledger
§5, launched with `scripts/execute-copilot-session --model claude-opus --context long --questions free-to-ask --no-wait`.
From its launch on, it owns the ledger; this session stops writing it. The dev daemon was stopped.

State at handover: live = Lua 0.5.1 + daemon 0.6.0, observe mode + menu (`liveEffects: false`), 177 tests green.
Leftover scratch (gitignored): `scratch/` (screenshots, dev seed/gap scripts, the reviewers' scratch tests).
