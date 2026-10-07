# Data prune inspection — 2026-10-07

Owner's question: which old-format `data/` files should be pruned before building the reporting UI?
Read-only inspection; nothing under `data/` was modified (worked-time check ran on a scratch copy, since removed).

## Findings

| File | Written by | Lines | Worked (history arithmetic) | Verdict |
|---|---|---|---|---|
| `2026-10-04` (Sun) | daemon 0.1.0 / 0.3.0 (M3–M4 install day) | 2 619 | 0:24 | **Prune** |
| `2026-10-05` (Mon) | 0.3.0 → 0.7.1, 31 daemon starts | 907 | 8:47 | Keep (transitional) |
| `2026-10-06` (Tue) | 0.7.1 / 0.7.2 | 775 | 8:31 | Keep (current) |
| `2026-10-07` (Wed) | 0.7.2 | 85 (live) | — | Keep (current) |

All lines parse; all are `v: 1`; every minute is routed to the correct day file.

**2026-10-04** — pre-D-38 (F-HS-12 phantom-input bug):
- 2 596 `minute` records for only **91** distinct minutes (17:08–22:35), up to 60 rewrites per minute, still being
  re-emitted until 08:12 the next morning (828 records written on 10-05).
- **64 of 91** minutes claim input while fully locked/asleep (e.g. `inputs [[0,59057]]`, `lockedSeconds 60`) —
  physically impossible. The current `work` digest neutralises them (the 17:36 lock is never closed), but any report
  reading raw `inputs` / `activeSeconds` / "last activity" would show phantom evening work until 22:35.
- Partial day (tracking began at install, 17:08), no `prompt-history`, no `categories`, no `day.rollover`.
- No notes, tokens, reports or other entity records — nothing depends on it.

**2026-10-05** — real workday, format-compatible but transitional:
- No phantom inputs (D-38 fix live from 08:12). Three short `hs-down` gaps (Hammerspoon reloads during dev).
- `categories` only from 20:09 (D-67); `github/cli` prompts counted `unclassified` (pre-0.7.1, documented);
  no inactivity credits (M9 not yet live), no `policy.transition`, `day.rollover` only at 12:00 (M8 deploy).
- Contains 6 short M8-era notes (7–18 chars, all dismissed on 10-06) and dev-test `quick`/`notes`/`summary`
  window audits. Pruning would orphan the 10-06 `note.dismissed` records (harmless — unknown ids are ignored).
- It is part of the current week (Sun 10-04 → Sun 10-11): pruning it removes 8:47 from this week's 44 h budget.

**2026-10-06 / 07** — current format; the few "input while mostly locked" minutes are genuine (input right before a
lock or right after an unlock, matching `system` events).

## Recommendation

- Prune **2026-10-04** — move it out of `data/` (e.g. to an archive outside the repo) rather than deleting it:
  `data/` is untracked in git, so a delete is irreversible. Effect: this week's worked total drops by 0:24.
- Keep **2026-10-05**; the reporting UI should tolerate minutes without `categories` (documented: "Older minutes
  have no `categories`") and treat days before `dailyReportsStartDay` (2026-10-06) as "no report expected".
  Optional alternative if the owner wants a clean baseline: also move 10-05 out — but that frees 8:47 of this
  week's budget mid-week.
- Sessions must not delete/move `data/` files themselves (instructions §6); the owner does it or explicitly
  authorises it.

## Ledger delta

Session-log row added for 2026-10-07 (this inspection).

## Outcome (owner's decision)

The owner chose to **delete both `2026-10-04` and `2026-10-05` permanently** (explicit authorisation). Done at
~10:01; `data/` now starts at `2026-10-06`. Live daemon gracefully restarted (`scripts/restart-daemon`, 0.7.2,
healthy) so its in-memory week matches the data. Consequences: this week's worked total no longer includes
0:24 + 8:47; the six M8-era notes are gone (the 10-06 `note.dismissed` records now reference unknown ids — ignored
by the notes fold).
