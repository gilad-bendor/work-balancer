# tbd-03 — work-balancer: continue as the top-level session from M7 (UI infrastructure) onward

You are the **successor top-level session** of the work-balancer project. The previous top-level session
(tmp-folder `.github/tmp/2026-10-05--08-37--answers-reviews-m5/`) handed over to you with the owner's approval because
its context grew too large (ledger D-47). The owner is directly initiating this launch and explicitly designates you as
the successor top-level session; the previous top-level session has ended and will not write the ledger concurrently.
This one-time designation overrides only the child-session "return a Ledger delta / do not edit the ledger" rule
(instructions §7, D-22): you edit `.github/ledger.md` directly. All other tmp-folder, report, safety and verification
rules still apply.

## Before anything else
1. Read `.github/copilot-instructions.md` and `.github/ledger.md` fully, then the topic files the ledger/§11 marks
   relevant: `.github/hammerspoon.md` (mandatory before touching Lua — note H-6: one wrong `hs.task` freezes all of
   Hammerspoon), `.github/data-format.md`, and the previous session's report
   `.github/tmp/2026-10-05--08-37--answers-reviews-m5/report.md`.
2. Your tmp-folder is `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/` (create it). Keep a
   `report.md` there with a `## Mn checkpoint` section per milestone.
3. Give the owner a short plan in chat (order of work + anything ambiguous), then continue without waiting unless
   something is a real blocker.

## Goal
Continue the milestones **in order**: **M7 (UI infrastructure)** → M8 → M9 → M10 → M11, per the ledger's tasks and
acceptance criteria. M7 first: Lua window manager (create/update/close webviews by id, levels incl. overlay above the
menubar, all spaces/full-screen behaviours, per-screen overlays, re-assert on screen/space changes,
`allowTextEntry(true)` — still *to verify*, F-HS-5), daemon page serving (`src/ui/`, TS page scripts via
`module.stripTypeScriptTypes`, verified available — F-ENV-5), JSON API with token, shared CSS, central strings
(`src/ui/strings.ts` exists), the effects reconciler (desired vs actual → idempotent commands; respects the Lua-side
`panic`/`quit` latches; **R-UI-QUIET**: no effect starts within 10 s of input, bounded deferral — Q-13 default 2 min),
dim pulse with guaranteed gamma restore, and `.github/ui-and-tone.md`.

**M7 scope:** validate the generic primitives with representative fixture pages for the normal, floating, overlay and
per-screen window modes. Do **not** implement the quick-note, inactivity, countdown or block product flows before their
milestones (M8–M10).

## Live-effects gate (mandatory, from M7 on)
Until the owner explicitly approves live enforcement in M10, every new visual/enforcement effect must be
**hard-disabled in the `live` env by default** (a config/env gate the reconciler checks; the menubar keeps working).
Develop and restart against `WB_ENV=dev`. Restart the live daemon only when the gate is confirmed off for live, or with
the owner's explicit consent for a specific visual test. For the M7 live overlay check use a harmless, explicitly
consented **test** overlay removed by test teardown; verify panic teardown in a dev/scratch path that cannot write
`data/` or alter the live latch — **never invoke live `WorkBalancer.panic()` merely as a test** (it writes a real
`panic` record and latches suppression until 04:00).

## Standing rules from the owner (all in the ledger — re-read them there)
- **D-37: before every commit, run an adversarial review subagent** (`task`, agent type `code-review`; tell it to read
  the instructions + ledger first, try hard to break the change, report concrete failing scenarios). Triage every
  finding (fix, or record why not), re-check fixes, then commit.
- **D-27: at each milestone checkpoint** run `scripts/check`; run and triage the adversarial review; re-run checks
  after fixes; update your `report.md` and the ledger (status, AC-verified notes, decisions, Current status, session log);
  inspect `git status`; **commit only milestone-owned files** (never `data/`, `var/`, `.gitignore`, `_PRIVATE-SCRATCH.md`)
  **and proceed** to the next milestone; ask only for real blockers.
- **D-26:** you may change and reload Hammerspoon freely (only `work-balancer.lua` + its one `require` line). Run
  `scripts/reload-hammerspoon` after every Lua edit; `scripts/restart-daemon` after `src/` edits (the supervisor adopts
  the running daemon). Bump `package.json`'s version for fixes that change worked time/ladder (D-45).
- **Live-machine safety (instructions §10):** never show a block/dim/countdown/popup on the live instance without the
  owner's consent in this session; use the dev instance (`WB_ENV=dev`, port 47622, `var/dev/`, `WB_FAKE_NOW`) and
  `WorkBalancer.preview(url)` for visual checks. Escape hatches must be verified before any block exists (M10).
- **Visual/wording checks need the owner:** use `ask_user` (this session may ask freely) — e.g. show a `DEV PREVIEW`
  window and ask; for M7's AC ask consent and a short agreed window for the one live overlay test on 2 monitors and over
  a full-screen app, then verify panic removes it.
- Owner decisions to respect in M7+: D-32 (one menu on any click; first item *Quick note…*), D-33 (inactivity dialog
  preceded by a ~10 s dim pre-warning; input cancels), D-34 / R-UI-QUIET, D-35 (only Sun/Tue/Thu are intrusive),
  D-36 (notes: no delete), kind tone (principle 3), Shabbat: nothing intrusive (enforced in `src/policy/evaluate.ts`).
- Small and boring; zero runtime dependencies; never write to `data/` from tests or the dev instance.

## Documentation duties
When creating `.github/ui-and-tone.md`, register it as existing in instructions §11 and treat it as mandatory reading
for M8–M10. Keep `.github/data-format.md` in sync whenever a milestone adds or changes events.

## M11
Do not compress, simulate or waive M11's one week of live use. Implement and verify the hardening cases, then mark M11
`in-progress — awaiting one week of live use`, update the ledger, and pause or hand over.

## Open items you inherit
- Owner's sanity check of the M5 dry-run numbers (`scripts/prompt-history-report`) — mention it at your first checkpoint.
- Q-12 (menubar colours, owner's visual check), Q-13 (R-UI-QUIET max deferral), Q-14, Q-15.
- Watch: daemon RSS ≈ 150 MB (≈ 90 MB Node + TS imports; JS heap ≈ 10 MB).

## Handover etiquette
When your own context grows large, do what the previous session did: write a successor prompt in your tmp-folder,
register it in the ledger (§5 + D-entry), get the owner's OK, and launch it with `scripts/execute-copilot-session`.

## Done when
M7's acceptance criteria are met and committed — then continue with M8 and onward (checkpoint per milestone, D-27) — or
the owner says stop. Finish each working stretch with the ledger's "Current status" accurate, a session-log row, your
`report.md` complete, and a short chat summary (what works, how to see it, what's next, open questions).
