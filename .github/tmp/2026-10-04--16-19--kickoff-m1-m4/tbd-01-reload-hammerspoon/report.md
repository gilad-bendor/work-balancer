# tbd-01 report — `scripts/reload-hammerspoon`

## What was done
- `scripts/reload-hammerspoon` — thin bash wrapper (`readlink -f` repo resolution → `run-node _reload-hammerspoon.ts`).
- `scripts/_reload-hammerspoon.ts` — logic; exports `normaliseInitLua`, `ensureInitLua`, `inspectSymlink`,
  `ensureSymlink`, `reloadAndVerify`, `consoleTail`, `checkInstall`, `installFiles`, `main`.
- `scripts/reload-hammerspoon.test.ts` — 36 tests (pure normaliser, init.lua FS, symlink, fake-`hs` reload
  orchestration, spawned-CLI end-to-end via `--hammerspoon-dir`), in `fs.mkdtempSync` dirs under this tmp-folder's
  `scratch/`, removed afterwards.

## Behaviour notes (beyond the ledger spec)
- Reload verification uses a **pending marker**: before the reload it sets the global `_WB_RELOAD_PENDING = true` in the
  old Lua state; the health poll answers `reloading` while that global exists. A fresh state after `hs.reload` has no
  such global, so the *old* instance answering `ok` in the 0.2 s before the reload can never be a false success.
- `--check` exits 0 only when symlink and the single require line are both correct; read-only (no mkdir).
- Regular file (or directory) at `work-balancer.lua` → refuse, exit 1, `init.lua` also left untouched.
- Backup name collision never overwrites (`COPYFILE_EXCL`, bumps the epoch ms). No backup when init.lua is created
  new or unchanged.
- Duplicate lines removed keep the first position; quoted/whitespace/`;` variants normalised; CRLF eol of the kept line
  preserved; commented-out and look-alike lines are not matches.
- Refuses (exit 1) if `<repo>/hammerspoon/work-balancer.lua` does not exist (would create a dangling link).
- If `hs` does not answer after we launched/or found Hammerspoon: explains the first-load / `hs.ipc` manual-reload
  caveat (the files are already in place). The owner's current init.lua does **not** load `hs.ipc`, so the first live
  install will need one manual "Reload Config" click, exactly as the ledger anticipated.
- Exit codes: 0 ok, 1 failure/not installed, 2 usage error.

## Verified
- `scripts/check` green: typecheck (`tsc --noEmit`) + 36 tests, 0 failures.
- `--help` works; CLI works from cwd `/` and via a symlink to the wrapper (tests).
- `scripts/reload-hammerspoon --check` on the **real** `~/.hammerspoon`: prints "not installed … work-balancer.lua is
  missing" + "init.lua needs a change: add require(\"work-balancer\")", exit 1; `ls -laR ~/.hammerspoon` before/after
  identical (only the parent `..` mtime moved — home dir, unrelated), `init.lua` md5 unchanged.
- Read-only live probes of the running Hammerspoon: `hs -c 'return 1'` → `1`; the console-tail Lua snippet returns
  real console text. (`hs.console.getConsole(true)` returns an `hs.styledtext`, not a string — hence `:string()`.)
- **Not verified live (by design):** the reload + health-poll path against a real Hammerspoon (forbidden: no reload, no
  real-dir writes). It is covered by fake-`hs` tests; the parent's first approved live install is its real test.

## Ledger delta
- §3 M1: tick `scripts/reload-hammerspoon` (⟂ item) — **done** (files: `scripts/reload-hammerspoon`,
  `scripts/_reload-hammerspoon.ts`, `scripts/reload-hammerspoon.test.ts`; 36 tests; `--check` against the real dir
  verified read-only, exit 1 = not installed).
- §8 Facts, Hammerspoon: add **F-HS-6** `hs.console.getConsole()` returns an `hs.styledtext`; use
  `getConsole():string()` to get text (`getConsole(true)` is still styledtext). Add **F-HS-7** the owner's `init.lua`
  does not load `hs.ipc` yet (the `hs` CLI works today only because it was loaded elsewhere/previously — verified
  `hs -c 'return 1'` → `1`), so first-install reload may or may not need a manual step.
- §7 Decisions: **D-new** reload success is verified through a `_WB_RELOAD_PENDING` marker global (see report) to avoid
  mistaking the pre-reload instance for a healthy one.
- Session log: row for this tbd (tmp-folder `.github/tmp/2026-10-04--16-19--kickoff-m1-m4/tbd-01-reload-hammerspoon/`).
- Remaining M1 live step stays open: first live install (`ask_user` first).
