# Daily energy reports

## Outcome

Implemented and deployed the agreed fresh/older daily-report flow, including menu access to today/yesterday for
short workdays. Initial activation is 2026-10-06, without pre-feature backlog.

- Calendar obligations include days without activity/files, Friday and Saturday.
- Today is offered inside the budget block; missing yesterday requires an energy score or confirmed skip in the
  Sun-Thu welcome. Mon/Wed are survey-only exceptions, not new budget/inactivity days.
- Older dates share one dismissible catch-up. Automatic catch-up starts on an older missing date and is not a
  second popup after the fresh welcome; the menu also includes today/yesterday.
- Every form shows date, weekday and calendar age. Skips explicitly record missing scores and can be filled later.
- Append-only `report.*` events retain target date separately from submission timestamp/file. Required energy 1-5,
  optional feelings/comment; amendments and failed-write handling are covered.
- Mandatory welcome interaction is excluded from work, including historical reconstruction and inactivity credits.
  Tokens, bypass, panic, eject, fail-open and Friday/Saturday quiet remain.
- The summary includes the last 28 days' report status and scores; richer trend charts remain backlog.

## Verification

- `scripts/check`: typecheck and **212/212 tests**, including DST/calendar age, Sunday catch-up, activation, persistence,
  write failures, confirmed skips, restart/04:00 behaviour, menu reopening, block priority/exits and interval boundaries.
- Isolated browser-only dev preview with a Sunday clock and scratch data: required-score validation, target dates,
  draft preservation across date switches, save/amend prefill, older skip/cancel, fresh skip/cancel/decision, and
  Escape protection for hidden drafts.
- Synthetic browser block model: no duplicate optional energy form, readable light-theme skip confirmation, context
  draft retained after report save. No live overlays/dims/popups were used for testing.
- One `scripts/restart-daemon`: new live process healthy. Read-only checks found no configuration error or menubar
  warning, the report menu and today's report. Pre-commit hardening later added Lua lifecycle metadata (Lua 0.7.1),
  with successful required reloads and console/health checks; daemon 0.7.2 releases latches under old accounting.
  No synthetic live windows or changes to existing data lines.
- Preview processes stopped; synthetic preview data and its launcher removed. Full check output remains in ignored
  `scratch/check.log`.

## Follow-up

Observe during the current M11 week. No implementation blocker remains. Richer feedback/energy trends are still the
existing post-M11 backlog.

## Adversarial pre-commit review

Owner authorized committing this implementation plus the pre-existing `.gitignore` exclusion; `data/` and the
private scratch file are excluded. Requested adversary: GPT-6 Astra. Findings and narrow re-checks were triaged:

1. Rapid welcome completion before its first reporting heartbeat counted report clicks as work. Fixed: actual
   opening time retained in Lua close metadata, synthesized shown audit uses it. Rapid-completion regression.
2. Delayed crash/reload close erased real prompts during an outage. Fixed: cap open/closed exclusions at continuous
   sensor coverage and exact monitoring-gap boundaries; live helper and historical reconstruction regressions.
3. Automatic catch-up adoption changed revision, rebuilding the webview and losing drafts. Fixed: recognize the
   automatic revision and retain its flags, even while fresh startup sensor data is not yet available. No-replacement
   regression.
4. First attempted command was not proof of appearance when a reply was lost. Replaced request-time assumption
   entirely with Lua actual timestamps; lost-reply regression preserves 290 worked seconds, rather than zero.
5. Initial timestamp patch landed in refocus rather than initial creation. Moved to `createView` immediately after
   `show()` and added a source-wiring regression ensuring ordinary open/quick close carries metadata without refocus.

All findings fixed, none deferred. Final full check: 212 tests and typecheck green.

## Ledger delta

Applied R-UI-REPORT and D-69/D-70, clarified the Mon/Wed survey-only exception to D-35, updated live status to Lua
0.7.1/daemon 0.7.2, retained the trend-chart backlog and added implementation/pre-commit session rows.
