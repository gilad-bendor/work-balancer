# Session report — kickoff M1 → M4 (observe mode)

Session started 2026-10-04 16:19. Tmp-folder: `.github/tmp/2026-10-04--16-19--kickoff-m1-m4/`.

## M1 checkpoint

**Done:** `package.json` (`typecheck`/`test`/`check`), `tsconfig.json` (baseline), `.nvmrc`, `.gitignore`,
`scripts/run-node` (newest nvm v26; `--npm`, `--bin-dir`), `scripts/run-daemon`, `scripts/check`, README,
`hammerspoon/work-balancer.lua` stub (`hs.ipc`, `WorkBalancer.health/panic/resume`, gamma restore on unload via a
chained `hs.shutdownCallback`), `scripts/reload-hammerspoon` (tbd-01, 36 tests), `.github/hammerspoon.md`.

**Verified:**
- `scripts/check` green (typecheck + 36 tests).
- Experiments: `hs.host.idleTime()` integer seconds; `asyncPost` refused/timeout(~61 s) behaviour; `hs.task` child
  killed by reload vs detached grandchild survives; Node 26 stripping (`satisfies`, `import type`, enum rejection,
  `?v=` re-import, `module.stripTypeScriptTypes`).
- Live install (owner consented): symlink + one line + backup; health `ok 0.1.0`; second run no-op; console clean.

**Surprises:** tbd-01's first launch opened in the storm VS Code window (runner bug; the owner stopped it and had it
fixed); relaunch worked. The owner granted standing permission to change/reload Hammerspoon (D-26).
