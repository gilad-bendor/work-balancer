# tbd-06 — M11 wrap-up (2026-10-15)

Top-level successor session (D-66). **Outcome: M11 done**, tuning D-79. Counts and times only — no note, report or
bypass-reason text appears here.

## Live period summary (from a read-only copy of `data/`)

Script: [week-summary.ts](./week-summary.ts) (`scripts/run-node week-summary.ts <copy> 2026-10-06 2026-10-15`).
It refuses `data/` itself. Full per-day output is in `scratch/week-summary.out` (gitignored).

| Day | Worked (seen + reported) | Budget | Ladder | Exits | Inactivity (choices) | Nudges / breaks | Reports for the day |
|---|---|---|---|---|---|---|---|
| Tue 10-06 | 8:31 (8:29 + 0:01) | 8:30¹ | orange → warn → countdown → **blocked 19:50** (Save) | — | 9 (7 back, 2 whole) | 3 / 0 | 1 |
| Wed 10-07 | 8:13 (7:49 + 0:24) | 8:00 | … → countdown → **blocked 17:09** (limit) | 2 tokens (5+5) | 5 (4 whole, 1 some) | 5 / 0 | 2 |
| Thu 10-08² | 6:26 | 8:30 | **Early End-Of-Day 14:12** → blocked | — | 2 (1 whole, 1 back) | 2 / 2 | 1 |
| Fri 10-09 | — (personal, no file) | — | — | — | — | — | 1 (catch-up) |
| Sat 10-10 | — (personal, no file) | — | — | — | — | — | 1 (catch-up) |
| Sun 10-11 | 4:58 (4:41 + 0:16) | 8:30 | ok | — | 3 (2 whole, 1 expired) | 0 / 0 | 1 |
| Mon 10-12³ | 7:58 (7:25 + 0:33) | 8:00 | orange → warn → **Early End-Of-Day 17:26** | 1 token (10) | 6 (5 whole, 1 back) | 3 / 3 | 2 |
| Tue 10-13 | 8:26 (8:22 + 0:04) | 8:30 | … → countdown → **blocked 16:51** (Save) | 1 token (10) | 2 (2 whole) | 2 / 2 | 1 |
| Wed 10-14 | 0:00 (day off) | 8:00 | — | — | — | — | 1 (+1 dismissed) |
| Thu 10-15⁴ (partial) | 7:33 (5:48 + 1:45) | 8:30 | orange (warn 16:34, after this summary) | — | 12 (12 whole) | 1 / 1 | 1 |

Mid-period changes: ¹ D-71 office/home budgets that evening (9 h → 8.5/8 h). ² D-73/D-74 (notes/reports split, Early
End-Of-Day) deployed 10-07/08; 10-06 was migrated. ³ D-75/D-76/D-77 (everyday morning review, end-of-day report for
yesterday, half energy). ⁴ D-78 (welcome asks about today after a day without work) and Q-16.

- **Weeks:** week of 10-04: 23:11 (from 10-06; 10-04/05 were deleted on 10-07). Week of 10-11: 28:56 by 10-15 16:00.
- **Exits:** 4 tokens of 24 offered. **No bypass, no panic, no Quit**, and no `config.invalid` under a block. The
  one invalid edit (10-08, an old `feedbackChoices` key) kept the previous policy.
- **Warn:** shown once per warn day, dismissed within 0–16 s. **Countdown:** 1–2 min after its threshold (R-UI-QUIET
  deferral while typing).
- **Reports:** 13 created, 1 dismissed (the 10-14 correction, D-78), 0 skips. Energy 1–4 (1 on 10-14 and 10-15).
  2 notes created (block, countdown) and 2 dismissed.
- **Morning review / welcome:** the review was shown and closed by the page every workday. The full-screen welcome was
  shown on 10-11 and 10-15 (yesterday without a report).
- **`monitor.gap`:** only `daemon-down` ≤ 1 min at the reboots of 10-13 11:19 and 10-15 08:38.
- **Daemon log:** no `ERROR`s. Warnings: 1 invalid policy edit (10-08), plus 112 `data auto-commit failed` from 10-14
  04:00 to 10-15 08:31 (see below). `daemon.out.log` holds only Node's `stripTypeScriptTypes` experimental warning.
- **Data auto-commit (D-72):** committed `2026-10-06` (10-08, not pushed — unpushed code underneath, as designed),
  `07`+`08` (10-11, pushed), `11`–`13` (10-14, committed). Its push failed with `No user exists for uid 502`
  (ssh could not resolve the user) until the reboot. It then pushed by itself on 10-15 08:40 (F-ENV-7). No code change.
- **Hammerspoon console:** our module only logs normal events (load, spawn, fail open at a daemon restart, dim pulses).
  The repeated `wfilter … STILL not registered` warnings come from the owner's `playwright-focus-guard` (not ours).
  `WorkBalancer.health()` → `ok 0.7.1 daemon=up`.
- **RSS:** 147 MB after 4 h uptime (≈ 150 MB before) — stable.
- **M5 numbers:** `scripts/prompt-history-report` for 10-15 gives 50 human prompts and 1 answer. That matches the
  `prompt-history` minutes in `data/` exactly (last-wins per minute).

Observation shown to the owner (no change asked): inactivity dialogs on 10-15 were 12, all "whole" (1:45 reported).

## Owner feedback and tuning (D-79)

Owner: "Change the home Mon/Wed from 8 h to 8.5 h; screen dimming 0.8 → 0.9; the emergency eject key: keep. Other
than that — nothing is important."

- `config/policy.ts`: `homeWorkday.dailyBudgetMin` 8 h → 8.5 h (kept as its own const); `overlayOpacity` 0.8 → 0.9.
  Saved on Thursday at `orange`. Thursday's budget is unchanged, so the level was unaffected and no block was active.
  Hot-reloaded live: `policy loaded c312879c`, last-good snapshot = budgets `[510×5, null, null]`, opacity 0.9.
  No daemon logic changed → no version bump (D-45 not needed).
- Tests that read his policy were updated: `config.test.ts`, `evaluate.test.ts` (the ladder test keeps an 8 h Monday
  via its own config, so a second budget stays covered), `observe.test.ts`, `product.test.ts`. README updated.
- `scripts/check`: **240/240 + typecheck**.
- Debug eject stays ON. The M5 sanity check is closed as not needed.

## Review (D-37)

The first review run was cancelled while the laptop slept (commute) and returned nothing. The second run found nothing
unsafe: 240/240 tests; opacity 0.9 is inside the validated range; the ladder test still covers two budgets; the script
cannot write (`readDay`/`listDays` only; torn-line repair lives in `append`); no private text. It made 2 findings, both fixed:
1. `WorkBalancer.preview(url, true)` hard-coded `alpha(0.8)` while documented as "the overlay opacity". It is now
   `PREVIEW_OPACITY = 0.9` with a comment to keep it in step with `config/policy.ts`. Lua **0.7.2**,
   `scripts/reload-hammerspoon` exit 0, `ok 0.7.2 daemon=up adopted=true`.
2. D-79's reason said "13 days of data" → "the live period 10-06 → 10-15 (8 day files)".

## Evening of 10-15 (after the summary above)

- Countdown 16:54, then **blocked 17:08** at the limit. Tokens: 5 (17:10), 5 (19:05), 10 (19:10).
- The block returned at 19:21:06. 17 s later Hammerspoon stopped (`effect.closed block by reload`, `monitor.gap hs-down`
  19:21–19:46). There is no crash report, so this was most likely the **debug eject**, the intended escape hatch.
- `scripts/reload-hammerspoon` for the Lua fix found Hammerspoon not running and started it (19:46). The block
  returned at once, as designed (R-DATA-2). I told the owner in the chat right away.

## Remains

Nothing for M11. Backlog when he wants it: the "Feedback & energy" window, then the daily timelines.
