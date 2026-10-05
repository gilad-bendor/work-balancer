# tbd-05 — work-balancer: continue as the top-level session from M10 onward

You are the **successor top-level session** of the work-balancer project. The previous top-level session
(`tbd-04-continue-m8`, tmp-folder `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/`)
finished and committed **M8** and **M9** and handed over to you with the owner's approval because its context grew large
(ledger D-58). The owner approved this launch and designates you as the successor top-level session; the previous
session has ended and will not write the ledger concurrently. This one-time designation overrides only the
child-session "return a Ledger delta / do not edit the ledger" rule (instructions §7, D-22): you edit
`.github/ledger.md` directly. All other tmp-folder, report, safety and verification rules still apply.

## Before anything else
1. Read `.github/copilot-instructions.md` and `.github/ledger.md` fully, then the topic files: **`.github/ui-and-tone.md`**
   (mandatory: window contract §2, pages + the owner's UI conventions §3, the M8/M9 windows §4, eject §5),
   **`.github/hammerspoon.md`** (mandatory before touching Lua — H-6: one wrong `hs.task` freezes all of Hammerspoon;
   H-9…H-14), `.github/data-format.md`, and the previous session's report
   `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/report.md`.
2. Your tmp-folder is
   `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/tbd-05-continue-m10/`
   (create it). Keep a `report.md` there with a `## Mn checkpoint` section per milestone.
3. Give the owner a short plan in chat (order of work + anything ambiguous), then continue without waiting unless
   something is a real blocker.

## Goal
Continue the milestones **in order**: **M10** → M11, per the ledger's tasks and acceptance criteria.

### What exists that M10 builds on
- **Policy** (`src/policy/evaluate.ts`, M6): `PolicyState` already has `level` (`ok → orange → warn → countdown →
  blocked`), `limitSeconds`, `remainingSeconds`, `nextLevelAtSeconds`, `grant`, `blockActive`, `zeroLimit`,
  `tokensLeft`, `tokensUsed`, `bypassesUsed`; grants fold `token.used` / `bypass.used` records (`grantUntil()`); the
  block latches until 04:00 under `<config hash>@<daemon version>` (D-45). The tracker logs `policy.transition`.
  **Bump `package.json`'s version for any fix that changes worked time or the ladder (D-45).**
- **Effects** (`src/core/effects.ts`, `src/effects/manager.ts`, `reconcile.ts`): intrusive windows are gated on live
  (`liveEffects`), deferred by R-UI-QUIET, suppressed by panic; screen-covering windows get `overlayOpacity` (now
  **0.8**) and the red eject label. Examples: `src/effects/product.ts` (review), `src/inactivity/inactivity.ts` (a
  full-screen, un-escapable, intrusive effect with its own records and fail-open on write errors — the closest model
  for the block), `src/effects/user-window.ts` (menu windows). Manager hooks: `request`, `adopt`, `focusRequests`,
  `suppressed()`, `gateOpen()`.
- **Pages** (`src/ui/pages/`): `page.ts` (`boot`, `act`, `topBar`, `closeOnEscape` — never on countdown/block,
  `submitOnCmdEnter`, `focusOnInteract`), the reusable **feedback form** `feedback.ts` (R-UI-FB) and the context-memory
  box pattern in `quick.ts` (R-UI-CTX) — reuse both in countdown + block; `inactivity.ts` = full-screen page with
  `isPrimary` (inputs on the primary screen only). Every string in `src/ui/strings.ts`, kind tone.
- **Trying things live without touching data:** `POST /api/test/window {"live": true, "page": "inactivity"}` (trial mode
  in `src/effects/test-effect.ts`) — extend the same way for the block/countdown pages so the owner can try the real
  thing before approving enforcement; `WorkBalancer.preview(url, true)` = full-screen DEV PREVIEW.
- Dev instance: `WB_ENV=dev WB_FAKE_NOW=… scripts/run-daemon` (port 47622, `var/dev/`); headless screenshots of dev
  pages work with `~/Library/Caches/ms-playwright/chromium_headless_shell-1234/…/chrome-headless-shell --headless
  --screenshot=<abs path> <url>` (the session's `view` tool could not open fresh PNGs from `.github/tmp/` late in the
  previous session — ask the owner to look, or use DEV PREVIEW).

### M10 notes (suggestions, not decisions — confirm or improve)
- **First verify the escape hatches** (R-UI-ESC, R-UI-EJECT): `WorkBalancer._panicDryRun(sec)` (never a live
  `panic()` as a test), eject label on every screen-covering window, fail-open on daemon death / page failure.
- **Warn** (dismissible dialog + gamma dim pulse), **countdown** (not dismissible, collapsible to a pill; "≈ N min of
  work left"; context-memory + feedback), **block** (all screens, above everything, until 04:00; today/week numbers;
  context-memory + feedback; token buttons with remaining counts; emergency bypass: retype the phrase with paste
  blocked + reason + two-step confirm; consequential actions need a two-step confirm — F-HS-2), **zero-limit
  explanation** screen (Q-3), **break nudge** (R-POL-5: 90 min continuous, dismissible, snooze 15 min). Each dialog
  once per level entry (R-POL-2). Saturday: nothing. Records: `token.used`, `bypass.used` (data-format §3).
- Consider the owner's low-priority backlog item: statistics on every full-screen effect (ledger §4).
- AC: full ladder walk-through in dev with a fake clock (recorded in your report); the owner approves before
  `liveEffects: true` (his explicit act in `config/policy.ts` or with his consent). With the gate open on live, the
  morning review (M8) and the inactivity dialog (M9) go live too — tell him.

## Live-effects gate (mandatory, unchanged)
`liveEffects: false` keeps every intrusive effect off on the live instance until the owner explicitly approves live
enforcement in M10. Live test windows only with the owner's consent in your session (`"live": true`). **Never invoke
live `WorkBalancer.panic()` as a test.** The debug panic-eject (⌃⌥⌘⇧F12 terminates Hammerspoon; relaunch:
`open -g -a Hammerspoon`) is ON — keep it working for the block and the zero-limit screen.

## Standing rules from the owner (all in the ledger — re-read them there)
- **D-37:** before every commit, an adversarial review subagent (`task`, type `code-review`; tell it to read the
  instructions + ledger first, try hard to break the change, report concrete failing scenarios); triage every finding
  (fix or record why not), re-check the fixes, then commit. Expect several rounds — M8/M9 needed 2–4.
- **D-27:** at each milestone checkpoint: `scripts/check`; review + triage; re-check; update `report.md` and the ledger
  (status, AC-verified notes, decisions, Current status, session log); `git status`; commit only milestone-owned files
  (never `data/`, `var/`, `.gitignore`, `_PRIVATE-SCRATCH.md`) and proceed.
- **D-26:** change and reload Hammerspoon freely (only `work-balancer.lua` + its one `require` line);
  `scripts/reload-hammerspoon` after every Lua edit; `scripts/restart-daemon` after `src/` edits.
- **Owner preference:** before each live visual stage, write a short call-to-action in chat ("hands off for 15 s", …).
  R-UI-QUIET defers intrusive things while he uses the mouse — tell him to keep his hands off.
- **Owner's UI conventions (D-55, D-56):** Esc closes dismissible windows (never countdown/block); Cmd+Enter submits;
  big windows 90 % with a static top bar; full-screen effects at `overlayOpacity`; kind tone; Shabbat: nothing.

## Open items you inherit
- Owner's sanity check of the M5 dry-run numbers (`scripts/prompt-history-report`) — still pending; mention it.
- Q-12 (menubar colours), Q-13 (R-UI-QUIET max deferral 2 min), Q-14, Q-15.
- Backlog after M11 (owner's choice): the "Feedback & energy" window (ledger §4).
- Watch: daemon RSS ≈ 150 MB.

## M11
Do not compress, simulate or waive M11's one week of live use. Implement and verify the hardening cases, then mark M11
`in-progress — awaiting one week of live use`, update the ledger, and pause or hand over.

## Handover etiquette
When your own context grows large, do the same: write a successor prompt in your tmp-folder, register it in the ledger
(§5 + D-entry), get the owner's OK, and launch it with `scripts/execute-copilot-session`.

## Done when
M10's acceptance criteria are met and committed (including the owner's approval decision about live enforcement) —
then continue with M11 (checkpoint per milestone, D-27) — or the owner says stop. Finish each working stretch with the
ledger's "Current status" accurate, a session-log row, your `report.md` complete, and a short chat summary.
