# Everyday morning review (D-75) — 2026-10-12

## Problem
Monday 2026-10-12: no good-morning screen. `day.rollover` at 04:00:02 had `review: false, reportMissing: false`:
- the floating review (`review`) needed notes waiting — both notes were dismissed on Sunday morning, and new notes are
  mostly parked at the countdown/block, which Sunday never reached (he left ~15:37; the inactivity gap expired at 04:00);
- the full-screen welcome (`review:fresh`) needs yesterday without a report — Sunday had a morning report (10:35).
So the morning screen depended on how the previous day ended.

## Fix
- `src/effects/product.ts`: the review shows on every `morningReview` day from the day's `day.rollover` on, until closed
  by user/page (unchanged done/restart logic); decision from the current config each time (no cached null config).
  Automatic `reports` catch-up yields on morning-review days (the review has the catch-up button).
- `src/daemon/tracker.ts`: `day.rollover` no longer writes `review` (old values ignored).
- `src/ui/pages/review.ts`: no intro when nothing is waiting ("Nothing waiting — a clean start.").
- Tests: new "every workday, whatever yesterday left behind" + "none on Fri/Sat"; catch-up tests use
  `testPolicy({ morningReview: false })`; enforcement/inactivity helpers ignore the review window.
- Docs: data-format (`day.rollover`), ui-and-tone (windows table, reports §6), ledger (R-UI-REVIEW, D-53, D-75).
- `package.json` 0.8.1.

## Verification
- `scripts/check`: typecheck + 237/237 tests.
- Live: `scripts/restart-daemon` → 0.8.1 healthy, Lua `daemon=up`; `effect.shown review` logged at 09:41 today.

## Adversarial review (subagent) — triage
Nothing high. Lows accepted: (1) on Sun–Thu older missing days surface only through the review's catch-up button and
the menu suffix (intended: one morning window); (2) an unclosed review can sit under a later block/countdown overlay;
(3) the review and an inactivity dialog can coexist — both as before with notes, now more often; neither takes focus.

## Not done
Not committed (owner did not ask). Possible follow-up for the owner: should the morning screen offer an end-of-day report
for yesterday when yesterday has reports but none `end-of-workday` (an early end)? Today's rule (D-74) only tracks days
without any report.

## Follow-ups (same session)
- Status *Procrastinating* added after *Stuck / frustrated* (`config/policy.ts`, hot-reloaded live).
- **D-76**: the morning review offers an optional "How did yesterday end?" report when yesterday was a workday without
  an end-of-workday report (`report-end-of-day`, timed 23:59 of that day, source `review`). 238 tests + typecheck;
  isolated dev daemon in `scratch/devvar` (port 47623, fake Monday 09:00) checked in a browser: form → save → recorded
  card. Daemon 0.8.2 live; today's review was already closed, so the form first appears tomorrow.
