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

## Countdown feedback draft fix

- Bug: in the countdown, energy/choices/comment were lost after "Make it small" → "Open" because the window is
  rebuilt and only the context text was kept as a daemon-side draft.
- Fix: `enforcement.ts` keeps `feedbackDraft` beside the text draft (partial `draft` payloads, sanitised, forgotten
  only for parts a save actually wrote, carried into the block); `park.ts` drafts both parts and `flush()`es before
  `countdown.ts` toggles; a pending draft is cancelled at Save so it cannot resurrect saved values.
- Verified: new enforcement regression test (215 tests + typecheck green); browser walkthrough against an isolated
  dev daemon (`WB_VAR_DIR` in scratch, fake clock at countdown) — energy 2, "Feeling tired" and the text survived
  full → pill → Open → full, with "Make it small" clicked inside the debounce window. Live daemon restarted healthy.
- Pre-commit review (D-37): one medium finding — Save cancelled a pending draft, so a part cleared just before Save
  came back in the block. Fixed: Save now flushes the draft first; drafts are chained so they reach the daemon in
  order and a flush also waits for one in flight (closes the re-check's remaining ms race). Regression assertion
  added; browser re-run of clear-then-Save: block draft empty. Page-only change after the restart (served by mtime).
