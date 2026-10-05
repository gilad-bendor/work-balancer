# tbd-06 — work-balancer: M11 wrap-up after the week of live use

**Launch on or after Tue 2026-10-13** (the owner starts it, ledger D-66), from the repo directory:
`scripts/execute-copilot-session --model claude-opus --context long --questions free-to-ask --no-wait <this file>`.

This is the **successor top-level session** (D-66). The previous session `tbd-05-continue-m10` has ended and will not
write the ledger concurrently. This one-time designation overrides only the child-session rule "return a Ledger delta /
do not edit the ledger" (instructions §7, D-22): you edit `.github/ledger.md` directly. Every other tmp-folder, report,
safety and verification rule still applies.

## Before anything else
1. Read `.github/copilot-instructions.md` and `.github/ledger.md` fully. Then read the topic files `.github/ui-and-tone.md`,
   `.github/hammerspoon.md` (H-6 before any Lua change) and `.github/data-format.md`. Also read the previous session's report:
   `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/tbd-05-continue-m10/report.md`.
2. Your tmp-folder is
   `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/tbd-05-continue-m10/tbd-06-m11-wrapup/`
   (create it). Keep a `report.md` there.
3. **Always completely ignore `_PRIVATE-SCRATCH.md`** (owner's scratch, D-65): never read it, act on it or commit it.

## Goal
Finish **M11**. Enforcement has been live since Tue 2026-10-06 (`liveEffects: true`, D-62).

1. **Summarise the week from `data/`.** Use counts and times only; never quote note text, feedback text or bypass reasons back
   unless the owner asks. Cover, per day:
   - worked time vs budget;
   - `policy.transition`s;
   - blocks, `token.used`, `bypass.used` and `budget.forfeited`;
   - `inactivity.*` (choices), nudges and warn dismissals (`effect.*`);
   - feedback energy and choices;
   - `monitor.gap`s.

   Also cover the daemon log's errors and warnings, Hammerspoon console errors, and daemon RSS (it was ≈ 150 MB).
   Write a small read-only script in your tmp-folder for this; never write to `data/`. **Never put note, feedback or
   bypass-reason text into `report.md` or any other committed file**; keep any per-day dumps under `<tmp-folder>/scratch/`
   (gitignored). Notes stay only in `data/`.
2. **Ask the owner for his feedback** with `ask_user`, one question at a time:
   - How did the week feel?
   - Were the block, countdown, warn, nudge, inactivity dialog and morning review too early, too late, annoying or useful?
   - The numbers: 9 h/day, 44 h/week, ladder 75 % / −30 / −10, tokens 10+5+5, bypass 30 min, nudge 90/15, quiet 10 s/2 min.
   - Is the debug eject still wanted? (`WorkBalancer.debugEject(false)` turns it off.)
3. **Tune defaults** he agrees to, recording each as a decision in the ledger. Fix any bugs the week revealed.
   - Bump `package.json`'s version for fixes that change worked time or the ladder (D-45). Do it on a non-enforcing day if possible, because a version bump releases an active block.
   - Never change his `config/policy.ts` values without his explicit OK.
   - `config/policy.ts` is hot-reloaded on save, and its hash is part of the block latch key. Before each save, tell
     him the effect on today's level: a lower budget or tighter ladder can warn, count down or block him at once, and
     any edit releases an active block. Prefer saving on a non-enforcing day. Run `scripts/check` before every
     `scripts/restart-daemon`.
4. **Mark M11 `done`** with an AC-verified note.
   - Update "Current status" and the session log.
   - Close or record open items.
   - Mention the backlog choices for after M11 (ledger §4: the "Feedback & energy" window first, by his choice).

## Standing rules (all in the ledger)
- **D-37:** before every commit, run an adversarial `code-review` subagent. Triage every finding, re-check the fixes, then commit.
- **D-27:** commit only session-owned files. Never commit `data/`, `var/`, `.gitignore` or `_PRIVATE-SCRATCH.md`.
- **D-26:** after editing `hammerspoon/work-balancer.lua`, run `scripts/reload-hammerspoon`. After `src/` edits, run `scripts/restart-daemon`.
- **Live safety (instructions §10):**
  - No live test windows without his consent in the session.
  - Never call `WorkBalancer.panic()` as a test.
  - Post a call-to-action in chat before every live visual step, and tell him exactly what to do.
- **Owner's UI conventions:** D-55, D-56, plus D-60, D-61, H-15.

## Done when
M11 is `done` and committed, the ledger is current, and `report.md` is complete. Or the owner says stop.
