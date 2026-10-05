# tbd-05 — successor top-level session (M10 → M11)

Tmp-folder: `.github/tmp/2026-10-05--08-37--answers-reviews-m5/tbd-03-continue-m7/tbd-04-continue-m8/tbd-05-continue-m10/`.
Launched 2026-10-05 14:28 as the successor top-level session (D-58); owns the ledger.

## Plan given to the owner

1. Escape hatches first (live, with consent). 2. `src/enforcement/`: warn + dim, countdown (pill), block (zero-limit
explanation, numbers + week strip, context + feedback, tokens two-step, bypass), break nudge; records; menubar; trial
mode; tests; docs. 3. Dev walk-through with a fake clock. 4. Owner: DEV PREVIEW + live trials. 5. Review (D-37) →
commit → owner decides `liveEffects`. 6. M11 hardening (the week of live use is not compressed).
Defaults announced (owner may object): bypass phrase compared ignoring case/punctuation/spacing; countdown draft carried
into the block; borrowed time shown in the menubar only (no re-warning, R-POL-3a); nudge ✕/Esc = snooze 15 min, "taking
a break" = quiet for the stretch; no block while data cannot be written (fail open); a compact week strip in the block.

## M10 checkpoint

### Escape hatches (verified first, live, owner consent 2026-10-05 ~15:33)
- Live test overlay (`perScreen`, 60 s) → on **both screens** with **2 eject labels** after ~4 s;
  `WorkBalancer._panicDryRun(15)` → closed at once; stayed away during the suppression; cleared.
- Overlay + `kill -TERM <live daemon>` → Lua closed it **2 s** later (fail open, "no daemon.json"); the supervisor
  respawned the daemon (health `up`).
- Overlay whose page never loads (`broken: true`) → closed **21 s** after appearing (15 s readiness + 5 s), then
  quarantined (not reopened).
- Hotkeys bound: `✧F12` (eject while ON — pressed by the owner in M7), `⌘⌃⌥P`, `⌘⌃⌥R`. Console clean.

### What was built
- `src/enforcement/enforcement.ts` — four audited, intrusive effects driven by the policy state + today's records:
  `warn` (+ one 3 s dim per level entry; dismissal = `effect.closed` by user/page after the entry), `countdown`
  (not dismissible; pill; park the thought; **Save = done for today** → `budget.forfeited` → `blocked`, owner D-60;
  draft carried into the block), `block` (overlay on all screens while `blockActive`; fail open while the store cannot
  write; tokens + bypass actions validated by `canUseToken` / `canBypass` / `phraseMatches`, `grantUntil`), `nudge`
  (90 min continuous; snooze from the `effect.closed` record; "taking a break" quiet for the stretch).
- Evaluator: `forfeited` input. Tracker: registration, `weekInfo`, menubar `⏳Nm` + borrowed-time / tokens tooltip
  lines (observe-mode line only while the gate is closed). Manager: `shownToday` rebuilt from today's audit (a restarted
  daemon re-shows the block without R-UI-QUIET deferral). `submitContextAndFeedback` shared (quick / countdown / block).
- Pages `warn`, `countdown` (+ pill), `block` (zero-limit explanation first; two-step tokens; bypass with paste/drop
  blocked; week strip), `nudge`; shared `park.ts`; `page.ts` `fill()`; all wording in `pageStrings`.
- Trial mode: `/api/test/window {page: block|countdown|warn|nudge|inactivity, zeroLimit?}` over synthetic numbers.
- Lua 0.6.0: titled windows use `fullSizeContentView` + `titled=1` (opaque, draggable title bar — owner; H-15).
- Daemon 0.7.0. Docs: data-format (`token.used`, `bypass.used`, `budget.forfeited` written), ui-and-tone §4a,
  hammerspoon H-15.

### Dev walk-through (fake clock) — AC
1. In-process (`src/enforcement/enforcement.test.ts`, fixed clock, Tuesday 2026-10-06, 9 h budget): orange + break
   nudge (snoozed) → 8:30 **warn** + dim pulse (gone once shown; dismissed → stays dismissed) → 8:50 **countdown**
   (no close; pill ⇄ open; empty Save forfeits nothing; Save → `budget.forfeited` → **block** at once) → block model
   (draft carried over, tokens 10/5/5, phrase, lifts 04:00, week strip) → token 7 refused, **token 10** → lifted, menubar
   `⏳10m`, used again refused → expiry → block back, tokens 5/5 → **bypass** (wrong sentence / short reason refused;
   lower-case without punctuation accepted) → 30 min → block back → **daemon restart** while the owner types: block
   re-shown at once (no R-UI-QUIET deferral) → **04:00** Wednesday: nothing. Plus zero limit (blocked only after the
   first worked second, `zeroLimit`), live gate closed / Saturday / write error → nothing, nudge rules, trial pages
   (nothing in data/, live needs `"live": true`).
2. Dev daemon over HTTP (`scratch/dev-walk.sh`, `WB_FAKE_NOW`, seeded fake Tue 2026-10-13 in `var/dev/data`) — output
   `scratch/dev-walk.out`:
   ```
   Tue 16:31 level=warn      windows=['review','warn','nudge']   menubar='⏱ 8:31 / 9:00'
   Tue 16:51 level=countdown windows=['review','countdown']      menubar='⏱ 8:51 / 9:00'
   Tue 17:03 level=blocked   blockActive=True  tokensLeft=[10,5,5] windows=['review','block']
     token 7 → unavailable; token 10 → ok until 17:13
   Tue 17:03 blocked blockActive=False grant=17:13 tokensLeft=[5,5]  menubar='⏱ 9:03 / 9:00 ⏳10m'
   Tue 17:14 (restart) blocked blockActive=True grant=None → bypass wrong sentence → phrase; bypass → ok until 17:44
   Tue 17:46 (restart) blocked blockActive=True bypasses=1 (latched until 04:00)
   Wed 04:01 level=ok windows=[]
   ```
   Records: `day.rollover`, `policy.transition` ok→warn→countdown→blocked (`…@0.7.0`), `token.used`, `bypass.used`.
3. Screenshots of every page against the dev daemon (`scratch/shot-*.png`): warn, nudge, countdown, pill, block
   (primary / other screen), zero-limit explanation.
4. Performance: tick + heartbeat + menubar ≈ 19 ms per 5 s beat on a heavy synthetic week (`scratch/perf.ts`).

### Owner (live trials, consent, ~15:55–16:10)
- Block trial on both screens (2 eject labels), used a 5-min token (two-step) → "All good!".
- Warn + 3 s dim, nudge ("taking a break"), countdown (pill ⇄ open, save) → "They looked good", with two requests:
  (1) countdown Save = forfeit the remaining minutes → block for the night (**D-60**, done); (2) the title bar of
  non-full windows was see-through → made opaque/draggable (**H-15**, Lua 0.6.0; verified by screen snapshot; owner:
  "All looks good"), and the countdown a little shorter (0.86 of the screen → 820 px, spacing compacted).

### Adversarial review (D-37)
Round 1 — 6 findings, all fixed: (high) unplugging the primary monitor left only a `primary=0` block view (no tokens /
bypass) → Lua rebuilds a view whose primary flag changed; (medium) the block returned up to 120 s late after a grant
while typing (R-UI-QUIET) → `WindowInput.immediate` once a token/bypass was used today; (medium) with a write error the
warn/nudge came back after every dismissal → dismissals also in memory; (low–medium) the pill keyed on a
`policy.transition` record that may fail → in-memory state + transition writes retried; (medium) a token grant exposed
Quit = the rest of the day unenforced → no Quit at countdown/blocked (D-61); (low) Cmd+Enter in the countdown forfeited
the day → Cmd+Enter only shows a hint there. Round 2: fixes hold (the reviewer's reproductions now fail their
"bug exists" assertions); 2 lows fixed: Quit stays when nothing can be enforced (panic / write error), a recreated
view resets the readiness check. 184 tests.

### Live enforcement (D-62)
Owner approved; the session set `liveEffects: true` (~16:40 Monday — nothing intrusive on Mondays). Verified: config
reloaded (`config.loaded f16eb7d057d4`), gate open, nothing desired today. First intrusive day: Tue 2026-10-06 04:00.

Commit: `e7ce3e4` "M10: enforcement — …".

## M11 checkpoint (hardening — the week of live use starts Tue 2026-10-06)

| Case | How verified | Result |
|---|---|---|
| Sleep/wake across 04:00 while blocked | test `M11: the Mac sleeps through 04:00 …` | new day: no block, one `day.rollover`, no `monitor.gap` |
| Lid closed / sleep = not a gap | tracker tests (M4) + the test above | ok |
| DST day (23 h, spring forward) while blocked | test `M11: DST spring-forward …` | blocked until the real 04:00; a token clipped to it |
| External monitor hot-plug under the block | **live trial with the owner** (2× plug/unplug of L24q-10) | first run found a bug (H-16: the async `closing` callback of a deleted view was taken for a user close → the block vanished); fixed in Lua 0.6.2; second run: controls follow the primary screen, block never lifted, token from the primary worked |
| Hammerspoon crash (`kill -9`) under the block | **live trial**, relaunch `open -g -a Hammerspoon` | block back on both screens with eject labels in ~5 s (H-18) |
| Daemon crash loop | **live**: `scripts/run-daemon` made non-executable, daemon stopped | backoff spawns; after 3 the menubar shows `⚠︎ ⏱ –:––` + tooltip "failed to start N times — nothing is enforced meanwhile"; restored → recovered in ~25 s, warning cleared, no false `monitor.gap` |
| Disk full / unwritable data dir while blocked | dev daemon, data dir `chmod a-w` (`scratch/dev-diskfull.out`) | block steps aside (fail open), menubar warning names the error, note save → "write" (text kept), token refused cleanly |
| Config errors | test `M11: cold start with a broken policy …` + config tests (M2) | tracking only, nothing enforced, menubar says so, Quit allowed; hot-reload keeps the previous policy |
| Daemon death / page failure under an overlay | live at the start of M10 | fail open in 2 s / 21 s |

Also: tests no longer depend on the owner's `liveEffects` (`src/testing/config.ts`). 187 tests.
