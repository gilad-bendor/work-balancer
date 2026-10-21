# End the borrowed time early (D-85)

**Question (owner, 17:36):** after tokens + the bypass, why is there no menu item to report end-of-day?
**Cause:** *Early End-Of-Day* was hidden from `blocked` on (by design — the block has the report), and that includes
time borrowed with a token or the bypass. So there was no way to close the day before the grant expired.

## Done
- `canEndEarly`: also offered while blocked **with** an active grant. In that case the menu item is titled
  "End-Of-Day now — end the borrowed time…".
- The same closable dialog shows the grant's minutes left. Save writes `grant.ended` (plus `budget.forfeited` if the
  level is below `blocked`), and the block returns at once.
- `grantSpans()` (evaluate.ts) cuts every grant whose `ts` is before an end at that end. It is used by the evaluator,
  `blockedIntervals` and the history (its `RAW_LINE` filter now includes `grant.ended`).
- Docs: data-format.md (`grant.ended`), ledger R-UI-MENU-3, D-85.

## Verified
- `scripts/check`: typecheck + 248 tests. New tests: evaluator (`grantSpans`, an end then a later token),
  enforcement flow (menu title, close keeps the grant, Save → block + report, a later token works), timeline and
  history.
- Live: the daemon was restarted at 17:42. The menu showed the item, and the owner used it at 17:43
  (`grant.ended` in today's file).

## Adversarial review (2 findings, both fixed)
1. The 20-week history ignored `grant.ended` (its line filter) → fixed + test.
2. A grant below `blocked` (a config edit released the latch) got the grant wording, but Save only forfeited and the
   grant kept lifting the block → Save now always ends a running grant.

## Surprise
The second restart (with the review fixes, 18:49) found **Hammerspoon not running**: it was quit after 17:42, not by
this session. So the daemon was stopped and not respawned. Nothing was relaunched — the owner restarts Hammerspoon
when he wants tracking back (the block returns until 04:00), as on 2026-10-08.

Not committed.
