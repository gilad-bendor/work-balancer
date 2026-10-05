# tbd-03 — successor top-level session (M7 → M11)

Tmp-folder: `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/`. Launched 2026-10-05 10:47 as the
successor top-level session (D-47); owns the ledger.

## Plan given to the owner

M7 first (daemon page serving + JSON API → effects manager/reconciler with the live gate and R-UI-QUIET → Lua window
manager + dim → tests → visual checks with the owner → docs → review → commit), then M8 → M11 in order, checkpoint per
milestone (D-27). Mid-M7 the owner added two requirements: **DEBUG PANIC-EJECT** (R-UI-EJECT, D-49) and
**`overlayOpacity`** (full-screen effects at 70 % so he can read through them).

## M7 checkpoint

### What was built
- `src/core/effects.ts` — contracts: `WindowInput`/`WindowSpec` (mode, placement, perScreen, focus, intrusive,
  opacity, rev), `DimSpec`, `ActualUi`, `UiCommand` (`window.open` / `window.close` / `dim`), `Effect`.
- `src/effects/reconcile.ts` — pure reconciler: open missing / rebuild changed rev / close unwanted, run each pulse
  once, panic drops intrusive things, R-UI-QUIET deferral of *new* intrusive things (10 s after input, max 2 min — Q-13
  default), updates/closes never deferred.
- `src/effects/manager.ts` — effect registry, **live gate** (`liveEffects` in `config/policy.ts`, default false — D-48),
  `overlayOpacity`, `effect.shown`/`effect.closed` audit (only `audit: true` effects), page API (`/api/ui/strings`,
  `/api/ui/model`, `/api/ui/action`, `/api/ui/state`).
- `src/effects/test-effect.ts` — M7 fixture windows/dims (`/api/test/window|dim|clear`); live only with `"live": true`,
  TTL ≤ 120 s, never logged to `data/`.
- `src/ui/serve.ts` + `src/ui/pages/` (`page.ts` helper, `style.css`, `fixture.html/.ts`); `pageStrings` in
  `src/ui/strings.ts`. Bridge server: prefix routes + raw bodies.
- Protocol (backward compatible, still 1): `ui.windows` id → rev, `ui.closed`, acks carry executed command ids.
- Lua 0.4.0: window manager (modes/levels/behaviours, per-screen, screen + space watchers, re-assert each beat,
  `allowTextEntry` + focus, usercontent port `wb`, load-failure fallback + 60 s close + 5 min quarantine), dim pulse
  (capped 15 s, ≥ 0.3, restored on everything), fail-open on daemon death, panic teardown, `_panicDryRun`, quit
  teardown, **debug eject** (label + ⌃⌥⌘⇧F12 → `os.exit`), `WorkBalancer.windows()`, `debugEject()`.
- Docs: `.github/ui-and-tone.md` (new, registered in §11), `hammerspoon.md` (H-9…H-13 + window manager + eject),
  `data-format.md` (`effect.*` written).

### Verified
- `scripts/check`: typecheck clean, 143/143 tests (10 new: reconciler incl. every R-UI-QUIET edge, page serving +
  traversal, test-window lifecycle through the daemon, panic suppression, pulse once, live gate + consent flag, audit,
  opacity).
- Live (owner consented in this session, ~11:05–11:22): DEV PREVIEW of the fixture — typing failed at first (H-10:
  needs window focus), fixed, owner typed and the echo came back. Test overlay (`perScreen`, 70 %): on **both
  monitors** with the eject label; **over full-screen apps on both screens**; owner confirmed no app was usable behind
  it. ⌃⌥⌘⇧**Esc** never reached Hammerspoon (macOS Force Quit swallows ⌘⌥Esc — found with a key-code-only eventtap
  log, H-9); owner chose ⌃⌥⌘⇧**F12**; pressing it over the overlay **terminated Hammerspoon** (twice); daemon survived
  and was re-adopted. Panic teardown verified with `WorkBalancer._panicDryRun(30)`: the overlay vanished at 11:22:01,
  stayed suppressed; `data/` has no `panic` record, no `var/live/panic.json`.
- Live gate: `/api/ui/state` on live → `gateOpen: false`, no desired windows.

### Adversarial review (D-37)
Round 1: 8 findings (1 high: removing a per-screen view reported as a user dismissal; medium: undetected page
failures, failed overlay trapping input 60 s, non-intrusive overlay escaping panic, R-UI-QUIET deferring re-opens after
a reload; low: 503 never failing open, audit drift after restarts, unbounded test windows) — all fixed (D-50). Round 2
on the fixes: 2 (dismissed windows skipping R-UI-QUIET forever; user-initiated covering windows silently gated) —
fixed. Round 3: holds. 147/147. Review text: `scratch/review-m7.txt` (round 1).

### Not yet / notes
- Owner's sanity check of the M5 dry-run numbers (`scripts/prompt-history-report`) still pending.
- Panic hotkey while eject is ON = eject (same combo); `WorkBalancer.panic()` via CLI unchanged.
- The dev daemon was started with `WB_ENV=dev nohup scripts/run-daemon` (stop: `scripts/restart-daemon --env dev`).

## Handover (D-51)

Owner chose a fresh session for M8 at the M7 checkpoint. Successor prompt `tbd-04-continue-m8.md` (in this
tmp-folder; includes M8 design notes and the owner's call-to-action preference), registered in the ledger §5,
launched with `scripts/execute-copilot-session --model claude-opus --context long --questions free-to-ask --no-wait`.
From its launch on, it owns the ledger; this session stops writing it. The dev daemon was stopped.
