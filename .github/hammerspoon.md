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

### Still to verify (do it before relying on it)

- `hs.webview` text entry needs `:allowTextEntry(true)` + window brought to front as key (needed from M7/M8 — needs a
  visible window, so verify with the owner's consent or in a `DEV PREVIEW` window).
- Overlay levels/behaviours for all spaces and full-screen apps (M7).
- Right-click vs left-click on `hs.menubar` (F-HS-4, M8).

---

## 2. How `work-balancer.lua` is built (M3)

- **Supervisor = heartbeat loop.** Every 5 s: read `var/live/daemon.json` (port, token) → `POST /bridge/heartbeat`.
  One heartbeat in flight at most; a 15 s watchdog + generation counter makes late `asyncPost` callbacks no-ops.
  Failure → grey menubar `⏱ –:––`; `not running` / `no daemon.json` → spawn (grace 8 s, then exponential backoff
  2 → 60 s, reset once a daemon has lived > 60 s). `timeout` never spawns (a hung daemon still holds the port).
- **Spawn** (D-24): `hs.task` running `/bin/sh -c "mkdir -p …; WB_ENV=live nohup scripts/run-daemon >>var/live/logs/daemon.out.log 2>&1 </dev/null &"`.
  The daemon outlives `hs.reload()`; the next load **adopts** it (`health()` shows `adopted=true`). See H-6 before
  touching this line.
- **Outbox:** sensor samples (M4) stay queued until a heartbeat carrying them returns 200; the daemon's ingest is
  idempotent, so a re-send after a lost reply is harmless.
- **Latches:** `panic` (hotkey: hold ⌃⌥⌘⇧Esc 1.5 s, or `WorkBalancer.panic()`; cleared by the 04:00 day-key change
  in a reply or `WorkBalancer.resume()`), `quit` (`WorkBalancer.quit()`: shutdown request, menubar removed, no
  respawn until the next module load).
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
- `hs -c 'local o={} for _,h in ipairs(hs.hotkey.getHotkeys()) do o[#o+1]=h.idx end return table.concat(o," ")'` — bound hotkeys (`✧` = ⌘⌥⌃⇧).
- `hs` CLI answers "send/receive timeout" → Hammerspoon's main thread is blocked: `sample $(pgrep -x Hammerspoon) 1` (see H-6).
- Daemon side: `var/live/logs/daemon-<dayKey>.log`, `var/live/logs/daemon.out.log` (stdout/stderr),
  `curl "http://127.0.0.1:47621/api/status?token=$(jq -r .token var/live/daemon.json)"`.
- `hs -c 'return hs.console.getConsole()' | tail -40` — console tail (read only the tail).
- `scripts/reload-hammerspoon` — reload + health check (required after every edit of `work-balancer.lua`).
