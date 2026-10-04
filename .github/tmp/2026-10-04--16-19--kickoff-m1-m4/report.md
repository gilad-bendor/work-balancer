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

## M2 checkpoint

**Done:** `src/core/{clock,time,env,log,registry,effects}.ts`, `src/store/{records,store}.ts`,
`src/policy/config.ts`, `config/policy.ts` (R-POL-2 values), `src/testing/tmp.ts` (scratch under `var/test/`),
`.github/data-format.md` (schema v1, incl. the `interactive` minute layout planned for M4).

**Verified:** `scripts/check` green — 58 tests (time/DST under Asia/Jerusalem, store routing/torn lines/tolerance/
last-wins/write errors, config validation/hot-reload/snapshot/cold start, registry).

**Design notes:** store reads are incremental per file (cache by size; unterminated tail held back until terminated).
`aboutTime()` centralises routing. `PolicyConfig` carries all R-POL-2 knobs now (ladder, tokens, bypass phrase,
break nudge, feedback choices) so later milestones do not change the owner's file shape.

## M3 checkpoint

**Done:** `src/bridge/{protocol,server}.ts`, `src/daemon/{daemon,tracker}.ts` (tracker = M3 placeholder),
`src/main.ts`, Lua supervisor (heartbeat loop, watchdog/generation, outbox, spawn detached + adopt, backoff, grey
"down" menubar, panic hotkey ⌃⌥⌘⇧Esc hold 1.5 s + `panic()/resume()`, `quit()`, `preview()`, `health()/status()`),
README dev-instance section, `.github/hammerspoon.md` §2–4.

**Verified:** see ledger M3 "AC verified" (unit + live: kill→restart ~9 s with grey meanwhile; reload→adopted;
second live daemon exits; dev isolation by stat snapshot).

**Incident:** first live spawn froze Hammerspoon ~67 s (H-6). Root cause found with `sample`; fixed and documented.
Not done on live on purpose: triggering `panic()` (would write a fake record into `data/`).
