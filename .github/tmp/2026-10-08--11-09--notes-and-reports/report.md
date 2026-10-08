# Report — notes and reports split (2026-10-08)

## Done
- **Intent** (discussed with the owner first): notes = reminders ("park the thought"); reports = how he is doing.
  Two parallel ways to record feelings existed (feedback notes + D-69 daily reports; 10-06 had the same answer twice).
- **Model**: `src/notes/notes.ts` (no `kind`, numeric ids = creation ms), `src/reports/reports.ts` (several per day,
  `timestamp` "YYYY-MM-DD HH:MM", optional stage, skip = all-empty report, dismiss/undismiss only, missing days over the
  last `stubDays` from `startDay`, catch-up stage midpoints). Config `reports {startDay, statuses, stages, listMax,
  stubDays}` (no "Other").
- **UI**: menu Manage Reports · Manage Notes · summary · Early End-Of-Day · Quit; Manage Reports page (new report,
  list with Edit/Dismiss, in-session Bring back, stubs with Add (stage picker) / Skip, today/yesterday emphasised);
  Manage Notes (new-note box focused); welcome (catch-up for yesterday or skip); countdown/block `park.ts` (note +
  end-of-workday report, "recorded for today" + add another); Early End-Of-Day = the countdown dialog, closable;
  summary "Recent reports". Removed: quick note page, `feedback.ts`, `report-form.ts`.
- **Data**: one-time migration `migrate.ts` (this folder) — dry run printed no text; applied with the daemon stopped
  (quit latch), 3 files rewritten, other lines byte-identical, re-run = no-op. Backups of the 3 original files in
  `scratch/` (gitignored).

## Verified
- `scripts/check`: typecheck + 236 tests (new: notes, reports timestamps/stages/midpoints/missing/skip/edit/dismiss,
  Manage Reports, menu, Early End-Of-Day incl. panic, welcome decided at rollover, config validation).
- Dev daemon + browser: new report (11:29 → afternoon), catch-up morning (07:30), skip with confirmation, edit skip
  into a report, dismiss → stub returns + Bring back, welcome form, Early End-Of-Day save → forfeit `early` → block
  showing "Recorded for today". Dev data restored afterwards (walkthrough data kept in `scratch/`).
- Live: daemon 0.8.0 healthy, Manage Reports model = 3 reports + today's stub, 1 note; Hammerspoon console clean.

## Review (adversarial subagent) — 13 findings
Fixed: deploy order (the old daemon served the new pages — deployed at once), mid-day full-screen welcome after
dismissing yesterday's report (`day.rollover.reportMissing`), Early End-Of-Day during panic / closed gate / write error,
typed text lost when Manage Reports re-renders, migration (refuse while the daemon runs, check all files before
writing, energy range, "Other"-only notes), forfeit-failure message, Esc guard in the early dialog, welcome Done across
04:00, menu count excludes today. Kept by owner decision: schema stays v1; the committed 10-06 file was rewritten.

## Second review (on the owner's request, after the fixes and the data commit) — 10 findings, none high
Fixed: the welcome came back mid-day after dismissing a report answered in it (now: no welcome if a report for
yesterday was created today); today's stub let a future stage stand in for the end of the day (today = report as of
now; `report-add` refuses today); forfeit-failure message (`countdownNotEnded`); rollover without a config no longer
writes `reportMissing: false`; an early dialog open across 04:00 is adopted only if shown today; Manage Reports
re-enables an editor when the refetch fails; wording leftovers. 236 tests; live daemon restarted (0.8.0).
Not changed: 309cd15 may be amended by the next data auto-commit (content kept, message replaced) unless code is
committed on top; the 10-07/10-08 originals exist only in `scratch/` (gitignored); Sunday's welcome asks about
Shabbat (as in D-69's every-day model) — owner to confirm.

## Remains / for the owner
- `data/2026-10/2026-10-06.jsonl` committed alone on request (309cd15, not pushed).
- Code and docs not committed.
