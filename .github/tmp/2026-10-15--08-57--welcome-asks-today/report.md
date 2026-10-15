# Welcome asks about today after a day without work (D-78)

**Problem:** no work on Wed 2026-10-14. Thu's full-screen welcome asked "how was yesterday?"; the owner answered about
this morning and chose "morning" (= Wed morning) → report saved as `2026-10-14 07:30`.

**Done**
- `src/daemon/tracker.ts` `freshReviewDue`: yesterday with 0 worked seconds + a report created today for today → answered.
- `src/effects/product.ts` review effect: `workedSeconds` dep; welcome model gains `today` (when yesterday had no work);
  `report-new` allowed there; `report-edit` for today's reports.
- `src/ui/pages/review.ts`: today mode — today form (or recorded cards), bold note "Yesterday (…) has no report." +
  "Also report yesterday…" (catch-up form with skip, drafts kept across re-renders), bold note for older days, Continue
  once answered. Strings in `src/ui/strings.ts`; `.bold-note` in `style.css`; `dayDate()` in `report-card.ts`.
- Tests: new today-mode test; the yesterday-mode test seeds Saturday work. 240 tests + typecheck green.
- Dev browser check (isolated daemon, `scratch/devvar`, fake Thu 08:26): as expected.
- Data correction (owner request), append-only via the store: `report.dismissed` for 1792042023365 and a new
  `report.created` `2026-10-15 08:27` morning, same fields (`scratch/fix-report.ts`).
- Daemon 0.8.4 restarted live, healthy.

**Review (D-37):** no high. Fixed: mode decided at the rollover (`day.rollover.yesterdaySeconds`, rollover after the
minute flush/prompt poll), refused-day forms reload, title/hint per mode, cached forms bound to their day, more tests.
Threshold for "no work" → Q-16 (owner). Re-check: nothing significant. Committed and pushed on request.

## Ledger delta
Applied directly (top-level session): R-UI-REVIEW note, D-78, status line, session-log row.
