# Session report — answers, adversarial reviews, M5 investigation (2026-10-05)

Tmp-folder: `.github/tmp/2026-10-05--08-37--answers-reviews-m5/`. Continuation of the kickoff session
(`../2026-10-04--16-19--kickoff-m1-m4/`).

## 1. Owner's answers (Q-1 … Q-10) → ledger

Recorded as D-32 … D-36 (+ D-37 for the new review rule); requirement texts R-POL-2, R-UI-MENU-2/3, R-UI-INACT,
R-UI-QUIET (new), notes model updated; `config/policy.ts` now makes only Sun/Tue/Thu intrusive (D-35, hot-reloaded
live). New open question Q-13 (maximum deferral for R-UI-QUIET; default 2 min).

## 2. Live-data bugs found this morning (fixed, deployed)

- **Phantom inputs while locked** (`hs.host.idleTime()` slower than the wall clock while locked + display asleep) →
  2 596 minute lines for 91 minutes on 2026-10-04. Fix: only an idle-counter reset is an input (H-7). Verified on
  today's data after the fix: 33 minute records for 31 minutes (the 2 doubles are restart flushes).
- **False wake** 1.2 s after `sleep` (H-8) and, found by review, **dark wakes**. Fix: a synthetic wake needs evidence
  (input/unlock after the sleep).

## 3. Adversarial reviews (D-37)

Reports (scratch, gitignored): `scratch/review-m1-m2.txt`, `review-m3.txt`, `review-fixes.txt`; the M4 review is in this
session's transcript (5 findings).

| Review | Findings | Fixed | Not fixed (why) |
|---|---|---|---|
| M1+M2 (ff0c901, 5fae13e) | 8 (3 medium) | all: write-failure retry (minutes/system), live env refuses `WB_PORT`/`WB_FAKE_NOW`, `ts: undefined`, config hash throw, `run-node` `sort -V`, `init.lua` byte-transparent + atomic, store cache identity (ino + head), date-only `WB_FAKE_NOW`, sparse arrays, commented-out `require` = disabled, paren-less `require`, `--force` for another checkout | gap/daemon/config event writes are logged-only on failure (D-41: rare, low value) |
| M3 (67d93d7) | 8 (1 high) | all: 10/s retry loop, 503 during startup, hung daemon (verify → TERM → KILL → spawn), persistent panic latch with daemon-decided expiry, spawn only on refused/missing, panic/resume logging, `restart-daemon` pid checks + KILL escalation | — |
| M4+Q-11 (91295c7, 0199005) | 5 | fake lock/unlock pair on unlock (10 s flag grace), future locked seconds in a shutdown flush, test name, outbox overflow alignment + gap | synthetic clicks from copilot-retry-watcher count as input — owner's Q-8: ignore |
| Fix batch (round 2) | 7 | all (panic expiry ordering, in-flight panic, dark wake, retry flood, disabled exit 3, symlinked `init.lua`, quit during hung recovery) | — |
| Fix batch (round 3) | 3 | all (unlogged expired panic, one failing day stalls others, log throttle) | — |

`scripts/check`: 106/106. Live: Lua 0.3.2 + daemon restarted after each round; health OK.

## 4. M5 investigation (tbd-02, ⟂)

Completed by a separate session: `.github/copilot-history-formats.md`, synthetic fixtures in
`test-fixtures/prompt-history/` (privacy spot-checked here: only placeholders + runner boilerplate), report in
`tbd-02-copilot-history/report.md`. Delta applied to the ledger (its D-38 renumbered D-43; Q-14, Q-15; F-COP-2/5
corrected; F-COP-6…9). Key result: agent-host sessions can be classified deterministically by the turn id in
`agentSessionData/*/session.db` (`request_*` = VS Code UI = human).

## 5. Next

M5 implementation: reader + classifier per the topic file, minute records, `work` source (prompt instants), live
dry-run report (counts only) for the owner.

## 6. M5 implementation (done)

`src/providers/prompt-history/`: `files.ts` (chunked cursor reader with rewrite guard), `cli.ts` (S-CLI, byte-prefix
filters, per-file isolation, oldest-session-first), `turns.ts` (agent-host index, `mode=ro&nolock=1` — never locks or
copies VS Code's dbs), `vscode.ts` (op-log replay, splices, compaction-safe dedupe), `classify.ts`, `index.ts`
(provider, minute records with counts + human times only, work source, drift warning), `report.ts` +
`scripts/prompt-history-report`. Tracker wiring; `WB_COPILOT_HOME` (dev only).

Verified: 116/116 tests (fixtures vs `expected.json`); live dry run 79 ms, numbers consistent with tbd-02. Review: 8
findings, then 3 on the fixes, then clean — all fixed (most notable: the first db-reading fix copied whole dbs, incl.
drafts/terminal output, into `var/`; replaced by lock-free in-place reads; no copy ever persisted). Open: owner's
sanity check of the dry-run numbers; daemon RSS ≈ 150 MB (mostly Node + imports).
