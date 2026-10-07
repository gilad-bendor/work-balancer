# Data auto-commit (D-72) — 2026-10-07

**Done.** `src/daemon/data-commit.ts` (+ 7 tests), wired into the daemon tick (live env only); daemon 0.7.3.

## When it runs
Once per 04:00 day, on the daemon's first eligible tick: ≥ 60 s after a start, at 04:00, or on the first tick after a
wake (the Mac is usually asleep at 04:00). Skips (merge/rebase/cherry-pick/revert/bisect/sequencer in progress, not on
`main`, HEAD moved) and failures (e.g. `index.lock` held, offline) retry every 15 min; ≥ 3 consecutive failures show a
menubar warning. Rationale: files only become eligible at a day boundary, and a start covers days the Mac was off.

## What it does
1. Selects `data/YYYY-MM/YYYY-MM-DD.jsonl` files that are new/changed with mtime < yesterday's 04:00, plus day files
   missing from the working tree that exist in HEAD.
2. `git add -A -- <paths>` + `git commit --only --no-verify -m "data: auto-commit day files" -- <paths>`
   (`--amend --allow-empty` when HEAD is a single-parent pure-`data/` commit). Other staged work is untouched; on a
   failed commit our paths are unstaged.
3. Pushes **only that commit**: `git push --force-with-lease=<merge>:<upstream> <remote> <sha>:<merge>`, only for a
   fast-forward by one data commit or an amend replacing an upstream pure-data tip with the same parent. Otherwise
   skipped + logged (never publishes unpushed code, never overwrites a rewound/diverged remote). An unpushed
   auto-commit is retried on later runs.

## Verified
- `scripts/check`: typecheck + 225 tests (10 in `data-commit.test.ts`, incl. bulk-deletion hold-back). Tests use real git in `var/test/` with a bare remote: selection, deletions,
  `AD`, staged owner work preserved, amend, empty amend, push retry, fetched foreign commit not overwritten, unpushed
  code not published, rewound main not force-pushed, skips, scheduler.
- Push works non-interactively from the daemon's environment (repo `core.sshCommand`, no TTY): dry-run in 1.5 s.
- Live: daemon 0.7.3 restarted healthy; first run logged `{"kind":"nothing"}` (10-06 settles on 10-08).

## Review (code-review subagent, 3 rounds) — triage
- Public GitHub repo → asked the owner; he chose main repo + amend + force-with-lease (D-72 records it).
- Commits on other branches would make checkouts delete day files → main only.
- Plain force push of `main` could delete remote commits / publish code → push only the data commit, exact lease,
  pushed sha re-verified as a data commit.
- `AD` entries failed the batch → deletions only of files in HEAD. Unstage failure now logged.
- Residual (accepted, documented): a commit landing in the ~ms between the HEAD re-check and `commit --amend` gets its
  message replaced (content kept, not pushed).

- Round 4 (empty own commit counts as data; `nothing` logged): clean. Its design note — an amend that deletes files
  the amended commit added removes them from remote history — led to a guard: a missing `data/` folder is skipped.
- Round 5 (that guard): insufficient — the store recreates `data/<month>/<today>.jsonl` within a minute, after which
  every committed day file looks deleted and would be amended away + force-pushed. Fix: > 2 deletions in one run are
  held back (changes still commit), with a menubar warning and 15-min re-checks until restored or committed by hand.
- Round 6: small totals (≤ 2 committed files in a month) and partial restores slipped through → also hold when a
  whole month folder of HEAD would be emptied, and keep holding while anything is missing after a hold (in memory;
  a daemon restart forgets it — accepted).
- Round 7: a committed day file restored from an older backup (not an append) would be committed over the full
  version → held back unless the new content starts with HEAD's content (append-only invariant).

## Notes for the owner
- Pushed data is public (notes/feedback/report text, app names, hours).
- A day file stays local while `main` has unpushed code commits under the data commit; it goes out with your push.
- Committed on the owner's request (not pushed). Until `main` is pushed, data auto-commits stay local (push skipped).
