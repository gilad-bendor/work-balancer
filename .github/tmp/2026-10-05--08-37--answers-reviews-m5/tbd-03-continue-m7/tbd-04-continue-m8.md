# tbd-04 — work-balancer: continue as the top-level session from M8 onward

You are the **successor top-level session** of the work-balancer project. The previous top-level session
(`tbd-03-continue-m7`, tmp-folder `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/`) finished
and committed M7 and handed over to you with the owner's approval because its context grew large (ledger D-51). The
owner is directly initiating this launch and explicitly designates you as the successor top-level session; the previous
session has ended and will not write the ledger concurrently. This one-time designation overrides only the
child-session "return a Ledger delta / do not edit the ledger" rule (instructions §7, D-22): you edit
`.github/ledger.md` directly. All other tmp-folder, report, safety and verification rules still apply.

## Before anything else
1. Read `.github/copilot-instructions.md` and `.github/ledger.md` fully, then the topic files: **`.github/ui-and-tone.md`
   (mandatory for M8–M10)**, `.github/hammerspoon.md` (mandatory before touching Lua — H-6: one wrong `hs.task` freezes
   all of Hammerspoon; H-9…H-13 are new), `.github/data-format.md`, and the previous session's report
   `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/report.md`.
2. Your tmp-folder is `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/`
   (create it). Keep a `report.md` there with a `## Mn checkpoint` section per milestone.
3. Give the owner a short plan in chat (order of work + anything ambiguous), then continue without waiting unless
   something is a real blocker.

## Goal
Continue the milestones **in order**: **M8** → M9 → M10 → M11, per the ledger's tasks and acceptance criteria, building
on M7's infrastructure (read `ui-and-tone.md` §2 for how an effect declares windows; `src/effects/test-effect.ts` is a
complete small example of an effect with model + actions + routes; `src/ui/pages/fixture.*` of a page).

### M8 design notes from the previous session (suggestions, not decisions — confirm or improve)
- **Notes** (`src/notes/`): event-sourced fold of `note.created/edited/dismissed/undismissed` over **all** day files
  (check whether the store can list existing days; add a `listDays()` if not), ids `n-<epochMs>-<rand>`, no delete
  (D-36). Notes are entity records → the current day's file.
- **Menu (D-32):** Lua `hs.menubar:setMenu(fn)` with the four items (Quick note… · Show activity summary · Show status
  notes · Quit). Verify with the owner that left **and** right click both open it. A click posts a small authenticated
  request to the daemon (e.g. `POST /bridge/ui-request {open: 'quick'|'summary'|'notes'|'quit'}`) and pushes a
  heartbeat at once; the daemon's effect then desires a **user-initiated** (`intrusive: false`, never `full`/`overlay`)
  window with `focus: true` — so it is not gated by `liveEffects` and not deferred. Daemon down → the menu still works
  for Quit (Lua-side confirm) and shows a kind "not running" item.
- **Quick note** window: context-memory box (R-UI-CTX) + reusable feedback component (R-UI-FB: `feedbackChoices` from
  config, multi-select, free text, optional energy 1–5) → one `context` note and/or one `feedback` note, `source: quick`.
  Build the feedback form as a shared page module (it is reused by countdown/block/review in M10).
- **Notes manager**, **activity summary** (R-UI-MENU-3; the tracker's `status()` already has most of today/week; add
  last-4-weeks totals and recent feedback), **quit flow** (confirm page → daemon logs `app.quit` → Lua `M.quit()`).
- **Rollover + morning review (R-UI-REVIEW, D-35):** `day.rollover` record from the tick on day change; the review is an
  *intrusive* floating window on days with `morningReview: true`, listing non-dismissed notes (editable, Dismiss each);
  "done for today" = an `effect.closed` (by `user`/`page`) for `review` in today's file (the M7 audit records persist).
  It is subject to the live gate (`liveEffects: false` until M10) — so on live it stays off until the owner approves;
  verify it in dev / with a consented test.
- Every user-facing string in `src/ui/strings.ts` (`pageStrings`), kind tone; owner reviews wording/visuals (M8 AC) —
  show him `DEV PREVIEW` windows (`WorkBalancer.preview(url)`; the page's Close button works there now).

## Live-effects gate (mandatory, unchanged)
`liveEffects: false` in `config/policy.ts` keeps every intrusive effect off on the live instance until the owner
explicitly approves live enforcement in M10. User-initiated menu windows are allowed live (they are what the owner
clicks). Develop against `WB_ENV=dev` (port 47622, `var/dev/`, `WB_FAKE_NOW`). Live test windows only with the owner's
consent in your session (`POST /api/test/window` with `"live": true`). **Never invoke live `WorkBalancer.panic()` as a
test** — use `WorkBalancer._panicDryRun(sec)`. The **debug panic-eject** (R-UI-EJECT, D-49) is ON: every screen-covering
window shows "Press Shift+Ctrl+Alt+Cmd+F12 to PANIC-EJECT", and that combo terminates Hammerspoon (relaunch:
`open -g -a Hammerspoon`). Keep it working for every new screen-covering effect (M10's block, zero-limit explanation).

## Standing rules from the owner (all in the ledger — re-read them there)
- **D-37: before every commit, run an adversarial review subagent** (`task`, agent type `code-review`; tell it to read
  the instructions + ledger first, try hard to break the change, report concrete failing scenarios). Triage every
  finding (fix, or record why not), re-check fixes, then commit.
- **D-27: at each milestone checkpoint** run `scripts/check`; run and triage the review; re-run checks; update your
  `report.md` and the ledger (status, AC-verified notes, decisions, Current status, session log); inspect `git status`;
  **commit only milestone-owned files** (never `data/`, `var/`, `.gitignore`, `_PRIVATE-SCRATCH.md`) **and proceed**.
- **D-26:** change and reload Hammerspoon freely (only `work-balancer.lua` + its one `require` line); run
  `scripts/reload-hammerspoon` after every Lua edit; `scripts/restart-daemon` after `src/` edits. Bump `package.json`'s
  version for fixes that change worked time/ladder (D-45).
- **Live-machine safety (instructions §10).** Visual/wording checks need the owner (`ask_user`; this session may ask
  freely). **Owner preference (2026-10-05): before each live visual stage, write a short call-to-action in chat**
  ("just wait", "press …", "hands off for 15 s").
- Owner decisions to respect: D-32, D-33, D-34/R-UI-QUIET, D-35, D-36, D-48…D-50, kind tone, Shabbat: nothing
  intrusive. Fonts are large (+50 %, `style.css`); full-screen effects use `overlayOpacity` (0.7).
- Low-priority backlog item from the owner: statistics on every full-screen effect (ledger §4) — consider it when
  building M10's block.

## Open items you inherit
- Owner's sanity check of the M5 dry-run numbers (`scripts/prompt-history-report`) — mention it at your first checkpoint.
- Q-12 (menubar colours), Q-13 (R-UI-QUIET max deferral: 2 min implemented as `quiet.maxDeferSec`), Q-14, Q-15.
- Not yet shown live: floating mode and dim pulses (tests + dev only) — first live use in M9/M10, with consent.
- Watch: daemon RSS ≈ 150 MB.

## M11
Do not compress, simulate or waive M11's one week of live use. Implement and verify the hardening cases, then mark M11
`in-progress — awaiting one week of live use`, update the ledger, and pause or hand over.

## Handover etiquette
When your own context grows large, do the same: write a successor prompt in your tmp-folder, register it in the ledger
(§5 + D-entry), get the owner's OK, and launch it with `scripts/execute-copilot-session`.

## Done when
M8's acceptance criteria are met and committed — then continue with M9 and onward (checkpoint per milestone, D-27) — or
the owner says stop. Finish each working stretch with the ledger's "Current status" accurate, a session-log row, your
`report.md` complete, and a short chat summary (what works, how to see it, what's next, open questions).
