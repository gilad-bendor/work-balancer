# Hammerspoon notes — `work-balancer`

**When to read me:** before touching [`hammerspoon/work-balancer.lua`](../hammerspoon/work-balancer.lua), the Lua⇄Node
bridge, the daemon supervisor, sensors, menubar or windows. Holds the **verified** behaviour of the Hammerspoon APIs
we rely on (with how each was verified), the gotchas, and how to debug through the `hs` CLI.

Environment: Hammerspoon **1.1.1**, `hs` CLI at `/opt/homebrew/bin/hs`, macOS, owner's other modules in
`~/.hammerspoon/` (`playwright-focus-guard`, `copilot-retry-watcher`) — never edit them.

---

## 1. Verified API behaviour

| # | API | Verified behaviour | How verified (date) |
|---|---|---|---|
| H-1 | `hs.host.idleTime()` | Returns **integer seconds** (`math.type` = `integer`) since the last HID input. ⇒ an input instant derived as `now − idle` is only known to ±1 s; sample every 1 s to bound the loss at the start of a busy stretch to ~1 s. | `hs -c` loop, 2026-10-04 |
| H-2 | `hs.http.asyncPost` | Connection refused → callback immediately with status `-1` and a "Could not connect" body. A server that never answers → callback after **~61 s** with status `-1`, "The request timed out" (NSURLRequest default). No cancel API. ⇒ own watchdog (≪ 60 s) + generation counter; ignore late callbacks. | scratch Node server with `?delay=`, 2026-10-04 |
| H-3 | `hs.task` across `hs.reload()` | A direct `hs.task` child is **killed** on reload. A grandchild started in the background by an `hs.task` shell (`/bin/sh -c '… </dev/null >… 2>&1 & echo $!'`) **survives** the reload. ⇒ to make adoption possible, spawn the daemon detached via a shell `hs.task`; supervise via `daemon.json` + `/health`, not via the task's exit callback. | spawn `sleep` both ways, `hs.reload`, `pgrep`, 2026-10-04 |
| H-4 | `hs.caffeinate.sessionProperties()` | Unlocked session: has no `CGSSessionScreenIsLocked` key (expected `true` while locked — confirm when observed). | `hs -c`, 2026-10-04 |
| H-5 | `hs.reload()` from the CLI | `hs -c 'hs.timer.doAfter(0.2, hs.reload)'` returns cleanly; the new Lua state is up within ~1–2 s; globals from the old state are gone. | 2026-10-04 |
| H-6 | `hs.task` **termination handler** | When the task's process exits, `hs.task` reads its remaining stdout **synchronously on the main thread** until EOF. If any surviving process still holds the stdout/stderr pipe (e.g. `sh -c 'a && b & echo $!'` — the `&` backgrounds a *subshell* that keeps the pipe), **all of Hammerspoon freezes** (every module; `hs` CLI → "send/receive timeout"). Fix: background only a simple command with `</dev/null >>file 2>&1`. Diagnose with `sample <HammerspoonPID> 1` (main thread in `__create_task_block_invoke_2 → readDataOfLength`); unfreeze by killing the pipe holder. | Happened live 2026-10-04 at the first M3 reload; fixed within minutes. |
| H-7 | `hs.host.idleTime()` **while locked + display asleep** | The counter grows *slower than the wall clock* (~11 s per 12 s), so `now − idle` creeps forward with no input. Only treat a **reset** (idle `0`, or lower than the previous sample) as an input. | Live data 2026-10-04 (phantom inputs re-emitting minutes up to 60×); fixed in Lua 0.3.1. |
| H-8 | `hs.caffeinate.watcher` `systemWillSleep` | Lua timers still fire for ~1 s after it (a regular heartbeat followed the one carrying `sleep`). | Live data 2026-10-04 (17:30:07 sleep → heartbeat 1.2 s later). |

| H-9 | `hs.hotkey` with **Esc + ⌘⌥** (e.g. ⌃⌥⌘⇧Esc) | **Never fires**: macOS consumes ⌘⌥Esc (Force Quit) before any app — even an `hs.eventtap` sees only the modifier changes, no Esc key-down. ⌃⌥⌘⇧**F12** arrives (key 111, with `fn` on the laptop keyboard). ⇒ panic/eject combo = ⌃⌥⌘⇧F12. | Owner pressed it under a logging `hs.eventtap` (key codes only), 2026-10-05 |
| H-10 | `hs.webview` text entry | Needs `:allowTextEntry(true)` **and** key focus: `webview:hswindow():focus()` after `show()`. With `bringToFront(true)` alone the owner could not type. | DEV PREVIEW of the fixture page, owner typed + echo, 2026-10-05 |
| H-11 | Overlay above everything | `level = windowLevels.screenSaver`, behaviour `canJoinAllSpaces | fullScreenAuxiliary | stationary | ignoresCycle`, borderless, Hammerspoon's dock icon hidden (it is: `hs.dockicon.visible()` = false) ⇒ shown on **both monitors**, **over full-screen apps**, above the menubar, and it **captures all input** (no app usable behind it). `webview:alpha(0.7)` works for the whole window. An `hs.canvas` at `level + 1` stays above it (the eject label). | Live test overlays with the owner's consent, 2026-10-05 |
| H-12 | `os.exit(0)` (= `hs._exit`) | Terminates Hammerspoon at once (every module stops); the detached daemon keeps running and is adopted on relaunch (`open -g -a Hammerspoon`). | Owner pressed the eject combo over a live test overlay, 2026-10-05 |
| H-13 | `print` inside an `hs.eventtap` callback | While an `hs -c` call is in flight, `print` is routed to the IPC client and raises `ipc.lua:402: attempt to index a nil value` (and the CLI times out). Diagnostics from callbacks: write to a file. | 2026-10-05 |
| H-15 | `hs.webview` **title bar** | The webview window is not opaque: a plain `titled` window's title bar is see-through (whatever is behind shows; the owner found it hard to see and drag). With `windowMasks.fullSizeContentView` the page renders under the title bar, so the page's background fills it (the page pads its top by 28 px; traffic lights + title stay on top, dragging works). | Screen-region snapshots before/after + owner dragged a live countdown trial, 2026-10-05 (Lua 0.6.0) |
| H-16 | `hs.webview:delete()` → `windowCallback("closing")` | The `closing` callback of a deleted view arrives **asynchronously** (after `delete()` returned — a guard flag set around the call is already reset). ⇒ ignore callbacks of views that are no longer current (`rec.views[key] ~= v`); a `closing` on a non-closable window is never a user act (drop + rebuild). Before the fix, unplugging a monitor under a per-screen overlay made Lua report the whole window closed `by user` (the block would have been lifted for up to 2 min). | Scratch webview with a logging callback; live trial-block hot-plug before/after (owner unplugged/replugged L24q-10), 2026-10-05, Lua 0.6.2 |
| H-17 | Screen hot-plug | Unplugging the primary monitor makes the remaining screen primary; per-screen views are keyed by screen UUID, so a view whose `primary` flag changed is rebuilt (the page shows the controls only when `primary=1`). Verified: plug → controls on L24q-10, unplug → back on the laptop, block never lifted; ~5–15 s per transition. | Live trial, 2026-10-05 |
| H-18 | Hammerspoon killed (`kill -9`) under a block | Relaunch (`open -g -a Hammerspoon`) → the module adopts the daemon and the block is back on both screens with eject labels within ~5 s. | Live trial, 2026-10-05 |
| H-19 | Window title via `hs.axuielement` | `hs.axuielement.applicationElement(app)` → `:setTimeout(s)` → `AXFocusedWindow` → `AXTitle` takes ~0.4 ms for a responsive app; the per-element timeout bounds a hung app. Lua 0.7.0 reads it 0.3 s after an activation (outside the watcher callback; the last known title meanwhile) and every 2 s, with a 0.1 s timeout per AX call (≤ 0.2 s worst case); an app slower than 0.05 s is skipped for 60 s and keeps its last title; titles are cut to 120 bytes and at most 1 500 app intervals go in one heartbeat. A title change starts a new app interval. The title goes to the daemon's categorizer only (D-67) — never stored. WhatsApp's app name starts with U+200E (LRM): match by bundle id. | `hs -c` probe, 2026-10-05 |
| H-14 | `hs.menubar:setMenu(fn)` | With a menu set, **both left and right click** open it (the function builds the items at click time). | Owner clicked both, 2026-10-05 (Lua 0.5.0) |

### Still to verify (do it before relying on it)

- A `focus = false` floating window really never takes key focus (`nonactivating` mask) — owner checked a live
  top-right test window on 2026-10-05 ("looks good"); re-check with the inactivity dialog in M9.

---

## 2. How `work-balancer.lua` is built (M3)

- **Supervisor = heartbeat loop.** Every 5 s: read `var/live/daemon.json` (port, token) → `POST /bridge/heartbeat`.
  One heartbeat in flight at most; a 15 s watchdog + generation counter makes late `asyncPost` callbacks no-ops.
  Failure → grey menubar `⏱ –:––`; `not running` / `no daemon.json` → spawn (grace 8 s, then exponential backoff
  2 → 60 s, reset once a daemon has lived > 60 s). After 3 spawns without a 200 the grey menubar gets a ⚠︎ "The daemon
  failed to start N times — nothing is enforced meanwhile" (M11; verified live with `run-daemon` made non-executable). Only `not running` / `no daemon.json` spawn (any HTTP answer means a
  daemon is there). `503` = daemon still starting: samples stay in the outbox, nothing else happens. After 4
  consecutive `timeout`s the daemon is considered hung: `ps -o command= -p <pid>` must show `<repo>/src/main.ts`, then
  `kill -TERM`, 3 s later `kill -KILL`, then spawn (plain short `hs.task`s — H-6 safe). Backlog fast-drain (0.1 s) only
  after a 200, never after a failure.
- **Spawn** (D-24): `hs.task` running `/bin/sh -c "mkdir -p …; WB_ENV=live nohup scripts/run-daemon >>var/live/logs/daemon.out.log 2>&1 </dev/null &"`.
  The daemon outlives `hs.reload()`; the next load **adopts** it (`health()` shows `adopted=true`). See H-6 before
  touching this line.
- **Outbox:** sensor samples (M4) stay queued until a heartbeat carrying them returns 200; the daemon's ingest is
  idempotent, so a re-send after a lost reply is harmless.
- **Latches:** `panic` (hotkey: hold ⌃⌥⌘⇧F12 1.5 s **when the debug eject is off**, or `WorkBalancer.panic()`; persisted in `var/live/panic.json`
  so a reload keeps it; heartbeats carry `panicAt` and the daemon answers `panicExpired` after the next 04:00, or
  `WorkBalancer.resume()`), `quit` (`WorkBalancer.quit()`: shutdown request, menubar removed, no
  respawn until the next module load).
- **Sensors (M4):** a 1 s timer samples `hs.host.idleTime()` → an input instant `now − idle` whenever it moves
  forward by > 0.5 s; `hs.application.watcher` (activated) closes the previous app interval `{id = bundleID, name,
  from, to}` (the still-open interval is added to every heartbeat); `hs.caffeinate.watcher` → `system` samples
  (`sleep`/`wake`/`lock`/`unlock`/`display-sleep`/`display-wake`) and an immediate heartbeat. Each heartbeat also
  carries `locked` (`sessionProperties().CGSSessionScreenIsLocked`) and `since` (coverage start: load time, then the
  last acknowledged `sentAt`). Outbox ≤ 50 000 per kind; ≤ 5 000 per heartbeat (drains faster when backlogged).
- **Code changes in `src/`** need `scripts/restart-daemon` (the supervisor adopts the running daemon across reloads).
- **Window manager (M7):** heartbeat replies carry idempotent commands (`window.open` with a full spec + `rev`,
  `window.close`, `dim`); Lua executes them, acks their ids in the next heartbeat, and reports `ui.windows`
  (id → rev on screen) and `ui.closed` (`{id, by, at}`: `user` = native close button, `page` = the page asked,
  `system` = daemon command, `panic`, `failopen`, `load-failed`) until a 200. Modes → level/behaviour: `normal`
  (titled), `floating` (`floating` level, all spaces + full-screen auxiliary, `nonactivating` unless `focus`),
  `overlay` (H-11, borderless). `perScreen` = one webview per screen (keyed by screen UUID), followed on
  `hs.screen.watcher`; levels re-asserted every beat and on `hs.spaces.watcher`. Pages talk back through a
  `hs.webview.usercontent` port named `wb` (`close` / `push` / `failed`). A navigation failure shows inline fallback
  HTML and closes the window after 60 s (that id+rev is not reopened for 5 min).
  **Kill-switches in Lua:** panic latch (and `WorkBalancer._panicDryRun(sec)` — the same teardown + suppression, local
  only: nothing persisted, nothing sent) refuses intrusive windows/dims and closes them; **fail open**: daemon gone
  (`not running` / no `daemon.json`) or 2 failed heartbeats in a row ⇒ intrusive windows closed + gamma restored;
  dims are capped at 15 s and never darker than 0.3, ended early by input when `cancelOnInput`, restored on screen
  changes, panic, quit and unload.
- **Debug panic-eject (R-UI-EJECT, D-49):** while `WorkBalancer.debugEject()` is ON (default; persisted in
  `var/live/debug-eject.json`), every screen-covering window gets a red bottom label "Press Shift+Ctrl+Alt+Cmd+F12 to
  PANIC-EJECT" (an `hs.canvas` one level above), and ⌃⌥⌘⇧F12 terminates Hammerspoon (`restoreGamma`, a detached
  `kill -9` fallback after 3 s, `os.exit(0)`). `WorkBalancer.debugEject(false)` turns it off (the combo becomes the
  1.5 s panic hold again).
- **Menu (M8):** `setMenu(buildMenu)`; items come from the daemon's menubar spec (`menu: [{id, title}]`, wording in
  `src/ui/strings.ts`); a click → `POST /bridge/ui-request {open: id}` → heartbeat now. Daemon down → a disabled status
  line + *Quit work-balancer…* confirmed with the non-blocking `hs.dialog.alert` (never `blockAlert`: it would freeze
  every module). Pages may send `focus` (raise + key focus) and `quit` (honoured only from window `quit` →
  `M.quit("menu")`); the daemon may send `window.focus`. Window `w`/`h` in (0, 1] = fraction of the screen.
- **Dev preview:** `WorkBalancer.preview(url)` opens a normal, closable `DEV PREVIEW — <url>` webview; it refuses the
  live port and non-local URLs.

## 3. Gotchas

- Hammerspoon garbage-collects unreferenced timers/watchers/menubar items — keep every handle referenced from the
  module table.
- `hs.shutdownCallback` is a single global slot, called on reload and quit: chain any previous value.
- `hs.json.decode` turns JSON `null` into `nil` (there is no `hs.json.null`); `hs.json.encode({})` → `[]` (the daemon
  accepts objects/arrays interchangeably for lists). `hs.json.read` of a missing file logs an ERROR — use `io.open`.
- One-shot `hs.timer.doAfter` timers must be referenced too (store them in the module's timer table).
- Hammerspoon gives child processes no shell `PATH`: always launch through absolute paths (`scripts/run-daemon`).

---

## 4. Debugging via `hs`

- `hs -c 'return WorkBalancer.health()'` → `ok <ver> daemon=up|starting|down|stopped(quit) pid=… adopted=… lastHeartbeat=…s panic=on|off [lastError=…]`
- `hs -c 'return hs.inspect(WorkBalancer.status())'` — supervisor state (failures, backoff, seq, outbox sizes).
- `hs -c 'return hs.inspect(WorkBalancer.windows())'` — windows on screen (mode, rev, webviews, eject labels, failed).
- `hs -c 'return WorkBalancer.debugEject()'` — eject state; `(false)` / `(true)` to toggle.
- Test windows (live only with the owner's consent): `curl -X POST -H "x-wb-token: $T" -d '{"mode":"overlay","perScreen":true,"ttlSeconds":60,"live":true}' http://127.0.0.1:47621/api/test/window`; `/api/test/clear` removes them.
- `hs -c 'local o={} for _,h in ipairs(hs.hotkey.getHotkeys()) do o[#o+1]=h.idx end return table.concat(o," ")'` — bound hotkeys (`✧` = ⌘⌥⌃⇧).
- `hs` CLI answers "send/receive timeout" → Hammerspoon's main thread is blocked: `sample $(pgrep -x Hammerspoon) 1` (see H-6).
- Daemon side: `var/live/logs/daemon-<dayKey>.log`, `var/live/logs/daemon.out.log` (stdout/stderr),
  `curl "http://127.0.0.1:47621/api/status?token=$(jq -r .token var/live/daemon.json)"`.
- `hs -c 'return hs.console.getConsole()' | tail -40` — console tail (read only the tail).
- `scripts/reload-hammerspoon` — reload + health check (required after every edit of `work-balancer.lua`).
