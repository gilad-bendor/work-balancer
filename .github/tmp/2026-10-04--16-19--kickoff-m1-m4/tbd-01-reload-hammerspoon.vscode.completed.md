# tbd-01 — implement `scripts/reload-hammerspoon` (work-balancer M1)

Read `.github/copilot-instructions.md` and `.github/ledger.md` first (the ledger's §3 M1 holds the normative spec of
this script — follow it exactly).

Your tmp-folder is `.github/tmp/2026-10-04--16-19--kickoff-m1-m4/tbd-01-reload-hammerspoon/` (create it; throwaway
artefacts go in its `scratch/` sub-folder, which is gitignored).

Write your final report to `.github/tmp/2026-10-04--16-19--kickoff-m1-m4/tbd-01-reload-hammerspoon/report.md`, ending
with a `## Ledger delta` section (exact proposed ledger changes). **Do not edit `.github/ledger.md` yourself** — the
launching session applies the delta.

## Goal

Implement `scripts/reload-hammerspoon` per ledger §3 M1 (symlink `~/.hammerspoon/work-balancer.lua` →
`<repo>/hammerspoon/work-balancer.lua`; exactly one canonical `require("work-balancer")` line in `init.lua`, with
`init.lua.bak.<epochMs>` backup before any modification; ensure Hammerspoon runs and `hs` CLI answers; reload via
`hs -c 'hs.timer.doAfter(0.2, hs.reload)'`; poll `WorkBalancer.health()` until it returns a string starting with
`ok` (timeout ~15 s); on failure print the Hammerspoon console tail and exit ≠ 0; flags `--check`,
`--hammerspoon-dir <dir>` (implies no reload), `--quiet`, `--help`; idempotent).

## Context

- The repo is scaffolded already: `package.json`, `tsconfig.json`, `scripts/run-node` (always use it — never `node`
  from PATH), `scripts/check` (typecheck + `node --test "src/**/*.test.ts" "scripts/**/*.test.ts"`).
- Another session (the parent) is concurrently writing `hammerspoon/work-balancer.lua` and `src/**`. Do not touch them.
- `hs` CLI is `/opt/homebrew/bin/hs` (Hammerspoon does not give child processes a shell PATH; scripts run from a normal
  shell, so resolving `hs` via PATH with a `/opt/homebrew/bin/hs` fallback is fine).

## Exact scope (files you may create/modify — nothing else)

- `scripts/reload-hammerspoon` — thin `#!/bin/bash` wrapper: resolve the repo root from its own location
  (`readlink -f` of `BASH_SOURCE[0]`, works via symlinks and from any cwd) and
  `exec "$repo/scripts/run-node" "$repo/scripts/_reload-hammerspoon.ts" "$@"`.
- `scripts/_reload-hammerspoon.ts` — the logic, in erasable TS (instructions §3.1). Export the pure/FS functions
  (e.g. `normaliseInitLua(text): { text, changed, ... }`, `ensureSymlink(dir, target)`, `ensureInitLua(dir)`) so tests
  can call them; only run the CLI when it is the main module (`import.meta.main`).
- `scripts/reload-hammerspoon.test.ts` — `node:test` tests against **scratch dirs** created under `os.tmpdir()`-free
  locations: use `.github/tmp/2026-10-04--16-19--kickoff-m1-m4/tbd-01-reload-hammerspoon/scratch/` or
  `fs.mkdtempSync` inside it (never `/tmp`), cleaned up after. Cover: missing dir, missing line, duplicate lines,
  `'`-quoted line, surrounding whitespace, no trailing newline, other lines byte-identical, wrong symlink (fixed and
  old target printed), regular-file conflict (refuses, exit ≠ 0, file untouched), backup written only when changed,
  idempotency (second run: no change, no new backup). Also test the CLI end-to-end via `--hammerspoon-dir` (spawn the
  wrapper script).

## Hard safety rules

- **Never modify the owner's real `~/.hammerspoon/`** and never reload Hammerspoon. Only `--hammerspoon-dir <scratch>`
  runs and `--check` against the real dir (read-only) are allowed. The parent session does the first live install
  after asking the owner.
- Don't commit. Don't touch `data/`, `var/`, `.github/ledger.md`, `hammerspoon/`, `src/`.

## Acceptance criteria

- `scripts/check` is green (typecheck + all tests, including yours).
- `scripts/reload-hammerspoon --help` prints usage; `--hammerspoon-dir <scratch>` works from any cwd and via a symlink
  to the wrapper.
- `scripts/reload-hammerspoon --check` against the real dir reports the current state read-only, with a non-zero exit
  if not installed, and changes nothing (verify with `ls -la ~/.hammerspoon` before/after).
- Report lists what was verified and how.
