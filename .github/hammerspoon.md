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

### Still to verify (do it before relying on it)

- `hs.webview` text entry needs `:allowTextEntry(true)` + window brought to front as key (needed from M7/M8 — needs a
  visible window, so verify with the owner's consent or in a `DEV PREVIEW` window).
- Overlay levels/behaviours for all spaces and full-screen apps (M7).
- Right-click vs left-click on `hs.menubar` (F-HS-4, M8).

---

## 2. Gotchas

- Hammerspoon garbage-collects unreferenced timers/watchers/menubar items — keep every handle referenced from the
  module table.
- `hs.shutdownCallback` is a single global slot, called on reload and quit: chain any previous value.
- Hammerspoon gives child processes no shell `PATH`: always launch through absolute paths (`scripts/run-daemon`).

---

## 3. Debugging via `hs`

- `hs -c 'return WorkBalancer.health()'`
- `hs -c 'return hs.console.getConsole()' | tail -40` — console tail (read only the tail).
- `scripts/reload-hammerspoon` — reload + health check (required after every edit of `work-balancer.lua`).
