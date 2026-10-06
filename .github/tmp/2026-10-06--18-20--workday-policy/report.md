# Office, home and personal-day policy

- Renamed the office policy to `officeWorkday` (Sun/Tue/Thu, 510 minutes).
- Added `homeWorkday` (Mon/Wed, 480 minutes), sharing all office-day effect flags.
- Renamed the quiet policy to `personalDay` (Fri/Sat): neutral menubar, no daily budget,
  reference colours or automatic effects. The owner explicitly approved this recommendation.
- Kept the weekly budget at 44 hours; occasional personal-day laptop use still counts.
- Updated current requirements, README and UI documentation (D-71).

## Verification

- `scripts/check`: typecheck and all **214 tests passed**.
- Updated old-default assertions across policy, menubar, summary, review, inactivity and enforcement tests.
  Tested exact office/home ladder thresholds, home inactivity, and Wednesday review after Tuesday's block.
  Retained explicit regression coverage for optional colour-only references.
- Read-only verification: the live last-good snapshot hash matches the edited policy, with daily budgets
  `[510, 480, 510, 480, 510, null, null]`. No restart or Hammerspoon reload needed.
- No synthetic live UI, data edits, commits or runtime logic changes. The config hash handles block-latch
  invalidation; no version bump needed.

Nothing remains for this request.

## Commit follow-up

The owner requested commit and push. The mandatory adversarial code-review subagent found no significant
issues. Commit scope is this session's policy, regression tests, documentation and report only; `data/` is excluded.
