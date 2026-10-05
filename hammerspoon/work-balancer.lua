-- work-balancer — thin Hammerspoon layer: sensors, actuators, daemon supervision, transport.
-- No business logic here: every decision lives in the Node daemon (.github/copilot-instructions.md §3.2, §4).
-- Verified API behaviour and gotchas: .github/hammerspoon.md
-- Loaded by exactly one line in ~/.hammerspoon/init.lua: require("work-balancer")

require("hs.ipc") -- the `hs` CLI (scripts/reload-hammerspoon, health checks)

local VERSION = "0.4.0"
local PROTOCOL = 1
local HEARTBEAT_EVERY = 5      -- seconds
local HEARTBEAT_TIMEOUT = 15   -- our watchdog; asyncPost's own timeout is ~60 s and cannot be cancelled
local SPAWN_GRACE = 8          -- seconds to let a freshly spawned daemon come up before spawning again
local BACKOFF_MAX = 60
local LIVE_PORT_DEFAULT = 47621
local PANIC_HOLD = 1.5         -- seconds to hold the panic hotkey
local MAX_OUTBOX = 50000       -- per sample kind; oldest dropped beyond this (≈ 14 h of continuous input)
local BATCH = 5000             -- max samples per kind in one heartbeat
local HUNG_AFTER = 4           -- consecutive heartbeat timeouts before a hung daemon is killed and respawned

if WorkBalancer and WorkBalancer._unload then pcall(WorkBalancer._unload) end

local function log(fmt, ...) print(string.format("[work-balancer] " .. fmt, ...)) end
local function nowMs() return math.floor(hs.timer.secondsSinceEpoch() * 1000) end
local function shq(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end

-- Repo root from this file's real path (~/.hammerspoon/work-balancer.lua is a symlink into the repo).
local selfPath = hs.fs.pathToAbsolute(debug.getinfo(1, "S").source:sub(2)) or ""
local REPO = selfPath:match("^(.*)/hammerspoon/work%-balancer%.lua$")
local VAR = REPO and (REPO .. "/var/live") or nil
local DAEMON_JSON = VAR and (VAR .. "/daemon.json") or nil
local PANIC_JSON = VAR and (VAR .. "/panic.json") or nil -- the panic latch survives reloads (R-UI-ESC)

local M = {
  version = VERSION,
  latches = { panic = false, quit = false },
}

-- Runtime state. Every handle is referenced here (Hammerspoon GCs unreferenced timers/watchers/menubars).
local S = {
  loadId = hs.host.uuid(),
  seq = 0,
  gen = 0,
  inflight = false,
  pushPending = false,
  watchdog = nil,
  failures = 0,
  lastOkAt = nil,
  lastError = nil,
  spawnedAt = nil,
  backoff = 2,
  daemon = nil,         -- last daemon.json content
  adopted = nil,        -- true if the first healthy daemon was already running when we loaded
  dayKey = nil,
  panicBy = nil,
  panicAt = nil,
  timeouts = 0,
  recovering = false,
  protocolMismatch = false,
  menu = nil,
  timers = {},
  hotkeys = {},
  previews = {},
  outbox = { inputs = {}, apps = {}, system = {} }, -- sensor samples not yet acknowledged by the daemon
  headDrops = {},       -- per kind: oldest samples dropped (outbox full) while a heartbeat was in flight
  lostUntil = nil,      -- samples before this were dropped: coverage restarts here (the daemon records a gap)
  loadedAt = nil,       -- coverage starts here for the first heartbeat …
  ackedSentAt = nil,    -- … and at the last acknowledged heartbeat's sentAt afterwards
  lastInputAt = nil,
  prevIdle = nil,
  app = nil,            -- current foreground app { id, name, from }
  sensors = { watchers = {} },
}

-- ───────────────────────────── daemon.json & spawning ─────────────────────────────

local function readDaemonInfo()
  if not DAEMON_JSON then return nil end
  local f = io.open(DAEMON_JSON, "r")
  if not f then return nil end
  local text = f:read("a")
  f:close()
  local ok, info = pcall(hs.json.decode, text)
  if ok and type(info) == "table" and info.port and info.token then return info end
  return nil
end

local function spawnDaemon()
  if not REPO then
    log("cannot locate the repo from %s — not spawning", selfPath)
    return
  end
  local logDir = VAR .. "/logs"
  -- Detached on purpose: a direct hs.task child is killed by hs.reload(); a backgrounded grandchild survives, so
  -- the next module load can adopt it (ledger D-24).
  -- DANGER: only a *simple command* may be backgrounded, with stdin/stdout/stderr all redirected. hs.task reads the
  -- task's remaining stdout synchronously on the main thread when sh exits; any surviving process that still holds
  -- that pipe (e.g. a backgrounded `a && b &` subshell) freezes ALL of Hammerspoon (.github/hammerspoon.md H-6).
  local cmd = string.format("mkdir -p %s; WB_ENV=live nohup %s >>%s 2>&1 </dev/null &",
    shq(logDir), shq(REPO .. "/scripts/run-daemon"), shq(logDir .. "/daemon.out.log"))
  S.spawnTask = hs.task.new("/bin/sh", function(code)
    log("daemon spawn requested (sh exit %s)", tostring(code))
  end, { "-c", cmd })
  S.spawnTask:start()
  S.spawnedAt = hs.timer.secondsSinceEpoch()
end

-- ───────────────────────────── menubar ─────────────────────────────

local COLOURS = {
  green = { red = 0.20, green = 0.66, blue = 0.33 },
  orange = { red = 0.93, green = 0.55, blue = 0.05 },
  red = { red = 0.86, green = 0.22, blue = 0.18 },
  grey = { white = 0.55 },
}

local function applyMenubar(spec)
  if M.latches.quit then return end
  if not S.menu then
    S.menu = hs.menubar.new(true, "work-balancer")
    if not S.menu then return end
  end
  local title = spec.title or "⏱"
  if spec.warning then title = "⚠︎ " .. title end
  local attrs = { font = hs.styledtext.defaultFonts.menuBar }
  if COLOURS[spec.colour] then attrs.color = COLOURS[spec.colour] end
  S.menu:setTitle(hs.styledtext.new(title, attrs))
  local tip = spec.tooltip or "work-balancer"
  if spec.warning then tip = tip .. "\n⚠︎ " .. spec.warning end
  S.menu:setTooltip(tip)
end

local function downMenubar(why)
  applyMenubar({
    title = "⏱ –:––",
    colour = "grey",
    tooltip = "work-balancer: the daemon is not answering (" .. why .. ") — restarting it.",
    warning = S.protocolMismatch and "Protocol mismatch — run scripts/reload-hammerspoon." or nil,
  })
end

-- ───────────────────────────── windows, dim, eject (M7) ─────────────────────────────
-- Dumb actuator for the daemon's reconciler: open/update/close webviews by id, report what is on screen. The only
-- decisions made here are the kill-switches: the panic latch refuses intrusive windows and dims, a dead daemon or a
-- page that fails to load closes them (fail open), and the debug eject terminates Hammerspoon (R-UI-EJECT).

local sendHeartbeat -- defined in the heartbeat section

local EJECT_LABEL = "Press Shift+Ctrl+Alt+Cmd+F12 to PANIC-EJECT"
local LOAD_FAIL_CLOSE = 60     -- seconds a small window whose page failed stays (with a kind message) before closing
local LOAD_FAIL_CLOSE_COVER = 5 -- … a screen-covering one (it captures all input: close almost at once)
local LOAD_FAIL_QUARANTINE = 300 -- the same id+rev is not reopened for this long after a failure (doubles each time)
local READY_TIMEOUT = 15       -- a page that has not said "ready" by then has failed (404, script error, …)
local FAILOPEN_503 = 6         -- consecutive "starting" answers (≈ 30 s) before intrusive windows are closed
local DIM_MAX = 15             -- hard cap of any dim pulse, whatever the daemon asks
local DIM_MIN_LEVEL = 0.3      -- never darker than this
local MAX_ACKS = 200
local LEVEL = hs.drawing.windowLevels
local BEH = hs.drawing.windowBehaviors
local MASK = hs.webview.windowMasks
local WINDOW_LEVEL = { normal = LEVEL.normal, floating = LEVEL.floating, overlay = LEVEL.screenSaver }
local WINDOW_BEHAVIOR = {
  normal = BEH.default,
  floating = BEH.canJoinAllSpaces | BEH.fullScreenAuxiliary,
  overlay = BEH.canJoinAllSpaces | BEH.fullScreenAuxiliary | BEH.stationary | BEH.ignoresCycle,
}
local EJECT_JSON = VAR and (VAR .. "/debug-eject.json") or nil

S.wins = {}          -- id -> { spec, views = { key = webview }, labels = { key = canvas }, closing, failed }
S.closedOut = {}     -- { id, by, at } not yet acknowledged by a 200
S.acks = {}          -- executed command ids, sent with the next heartbeat
S.failedRevs = {}    -- "id@rev" -> { at, n }: page failed to load n times (not reopened for LOAD_FAIL_QUARANTINE · 2^(n-1))
S.internalDelete = false -- our own webview:delete() in progress: its "closing" callback is not the owner's
S.starting = 0       -- consecutive 503 answers
S.pulsesDone = {}    -- dim pulse ids already run (never twice)
S.pulseOrder = {}
S.dim = nil          -- { cancelOnInput } while a pulse is on
S.panicSimUntil = nil -- WorkBalancer._panicDryRun(): local-only suppression, never reported or persisted
S.oneShots = 0

local function later(secs, fn)
  S.oneShots = S.oneShots + 1
  local key = "once" .. S.oneShots
  S.timers[key] = hs.timer.doAfter(secs, function()
    S.timers[key] = nil
    fn()
  end)
end

local function suppressed()
  return M.latches.panic or (S.panicSimUntil ~= nil and hs.timer.secondsSinceEpoch() < S.panicSimUntil)
end

local function coversScreen(spec) return spec.mode == "overlay" or spec.placement == "full" end
--- Subject to panic, fail-open and suppression: system-initiated windows and anything that covers a screen.
local function guarded(spec) return spec.intrusive or coversScreen(spec) end

-- Debug eject: on unless the owner turned it off (persisted, survives reloads).
M.ejectEnabled = true
if EJECT_JSON then
  local f = io.open(EJECT_JSON, "r")
  if f then
    local ok, v = pcall(hs.json.decode, f:read("a"))
    f:close()
    if ok and type(v) == "table" and v.enabled == false then M.ejectEnabled = false end
  end
end

local function restoreDim(why)
  if S.timers.dimEnd then S.timers.dimEnd:stop(); S.timers.dimEnd = nil end
  if S.dim then log("dim pulse ended (%s)", why or "done") end
  S.dim = nil
  hs.screen.restoreGamma()
end

local function dimPulse(d)
  if type(d) ~= "table" or not d.pulseId or S.pulsesDone[d.pulseId] then return end
  S.pulsesDone[d.pulseId] = true
  table.insert(S.pulseOrder, d.pulseId)
  if #S.pulseOrder > 100 then S.pulsesDone[table.remove(S.pulseOrder, 1)] = nil end
  if suppressed() then return end
  local level = math.max(DIM_MIN_LEVEL, math.min(tonumber(d.level) or 0.6, 1))
  local secs = math.max(0.5, math.min(tonumber(d.seconds) or 3, DIM_MAX))
  for _, s in ipairs(hs.screen.allScreens()) do
    pcall(function() s:setGamma({ red = level, green = level, blue = level }, { red = 0, green = 0, blue = 0 }) end)
  end
  S.dim = { cancelOnInput = d.cancelOnInput == true }
  if S.timers.dimEnd then S.timers.dimEnd:stop() end
  S.timers.dimEnd = hs.timer.doAfter(secs, function() S.timers.dimEnd = nil; restoreDim("done") end)
end

local function frameFor(spec, screen)
  local f = spec.mode == "overlay" and screen:fullFrame() or screen:frame()
  if spec.placement == "full" then return f end
  local w = math.min(tonumber(spec.w) or 560, f.w - 40)
  local h = math.min(tonumber(spec.h) or 380, f.h - 40)
  if spec.placement == "top-right" then return { x = f.x + f.w - w - 16, y = f.y + 16, w = w, h = h } end
  if spec.placement == "bottom-right" then return { x = f.x + f.w - w - 16, y = f.y + f.h - h - 16, w = w, h = h } end
  return { x = f.x + (f.w - w) / 2, y = f.y + (f.h - h) / 2, w = w, h = h }
end

--- Screens a window lives on: one per screen (perScreen) or the screen with the focused window.
local function targetScreens(spec)
  local out = {}
  if spec.perScreen then
    local primary = hs.screen.primaryScreen()
    for _, s in ipairs(hs.screen.allScreens()) do
      out[s:getUUID() or tostring(s:id())] = { screen = s, primary = s == primary }
    end
  else
    out.main = { screen = hs.screen.mainScreen(), primary = true }
  end
  return out
end

local function makeEjectLabel(screen, level)
  local f = screen:fullFrame()
  local h = 72
  local c = hs.canvas.new({ x = f.x, y = f.y + f.h - h, w = f.w, h = h })
  c:appendElements(
    { type = "rectangle", action = "fill", fillColor = { white = 0.05, alpha = 0.95 } },
    { type = "text", text = hs.styledtext.new(EJECT_LABEL, {
        font = { name = ".AppleSystemUIFontBold", size = 36 }, color = { red = 1, green = 0.23, blue = 0.19 },
        paragraphStyle = { alignment = "center" } }),
      frame = { x = 0, y = 12, w = f.w, h = h - 12 } })
  c:level(level)
  c:behavior(WINDOW_BEHAVIOR.overlay)
  c:show()
  return c
end

local function fallbackHtml()
  return [[<html><body style="font:24px -apple-system;display:flex;align-items:center;justify-content:center;height:100%;margin:0;background:#1f2124;color:#e8e6e1">
<p style="max-width:780px;text-align:center">This window couldn't load its content. It will close by itself in a minute — nothing is blocked.</p></body></html>]]
end

local closeWindow

local function loadFailed(id)
  local rec = S.wins[id]
  if not rec or rec.failed then return end
  rec.failed = true
  local key = id .. "@" .. rec.spec.rev
  local prev = S.failedRevs[key]
  S.failedRevs[key] = { at = hs.timer.secondsSinceEpoch(), n = (prev and prev.n or 0) + 1 }
  local wait = coversScreen(rec.spec) and LOAD_FAIL_CLOSE_COVER or LOAD_FAIL_CLOSE
  log("window %s: page failed to load — closing in %ds", id, wait)
  later(wait, function()
    if S.wins[id] == rec then closeWindow(id, "load-failed"); sendHeartbeat() end
  end)
end

local function onPageMessage(msg)
  local body = type(msg) == "table" and msg.body or nil
  if type(body) ~= "table" or type(body.win) ~= "string" then return end
  if body.op == "close" then
    later(0, function() closeWindow(body.win, "page"); sendHeartbeat() end)
  elseif body.op == "push" then
    later(0, function() sendHeartbeat() end)
  elseif body.op == "failed" then
    later(0, function() loadFailed(body.win) end)
  elseif body.op == "ready" then
    local rec = S.wins[body.win]
    if rec then rec.ready = true end
  end
end

local function pageUrl(spec, key, primary)
  local d = S.daemon
  if not d then return nil end
  local sep = spec.path:find("?", 1, true) and "&" or "?"
  return string.format("http://127.0.0.1:%d%s%stoken=%s&win=%s&screen=%s&primary=%s", d.port, spec.path, sep,
    hs.http.encodeForQuery(d.token), hs.http.encodeForQuery(spec.id), hs.http.encodeForQuery(key), primary and "1" or "0")
end

local function createView(rec, key, target)
  local spec = rec.spec
  local url = pageUrl(spec, key, target.primary)
  if not url then return end
  local ucc = hs.webview.usercontent.new("wb")
  ucc:setCallback(onPageMessage)
  local v = hs.webview.new(frameFor(spec, target.screen), { developerExtrasEnabled = false, javaScriptCanOpenWindowsAutomatically = false }, ucc)
  local style = MASK.borderless
  if spec.mode ~= "overlay" then
    style = MASK.titled | (spec.closable and MASK.closable or 0)
    if spec.mode == "floating" and not spec.focus then style = style | MASK.nonactivating end
  end
  v:windowStyle(style)
  v:windowTitle(spec.title or "work-balancer")
  v:allowTextEntry(true)
  v:closeOnEscape(false)
  v:deleteOnClose(spec.closable == true)
  v:level(WINDOW_LEVEL[spec.mode] or LEVEL.normal)
  v:behavior(WINDOW_BEHAVIOR[spec.mode] or BEH.default)
  local opacity = tonumber(spec.opacity)
  if opacity then v:alpha(math.max(0.2, math.min(opacity, 1))) end
  local id = spec.id
  v:windowCallback(function(action)
    if action == "closing" and not rec.closing and not S.internalDelete then
      rec.userClosed = true
      later(0, function() if S.wins[id] == rec then closeWindow(id, "user"); sendHeartbeat() end end)
    end
  end)
  v:navigationCallback(function(action, _, _, err)
    if action == "didFailNavigation" or action == "didFailProvisionalNavigation" then
      log("window %s: navigation failed (%s)", id, err and err.description or "?")
      later(0, function() loadFailed(id) end)
      return fallbackHtml()
    end
  end)
  v:url(url)
  v:show()
  if spec.focus and target.primary then
    local w = v:hswindow()
    if w then pcall(function() w:focus() end) end
  end
  rec.views[key] = v
  rec.uccs[key] = ucc
  if M.ejectEnabled and coversScreen(spec) then rec.labels[key] = makeEjectLabel(target.screen, v:level() + 1) end
  -- Readiness handshake: a page that never says "ready" (HTTP 404 page, script error) fails open too.
  later(READY_TIMEOUT, function()
    if S.wins[id] == rec and not rec.ready and not rec.failed then
      log("window %s: page not ready after %ds", id, READY_TIMEOUT)
      loadFailed(id)
    end
  end)
end

local function deleteView(rec, key)
  if rec.views[key] then
    S.internalDelete = true
    pcall(function() rec.views[key]:delete() end)
    S.internalDelete = false
  end
  if rec.labels[key] then pcall(function() rec.labels[key]:delete() end) end
  rec.views[key], rec.labels[key], rec.uccs[key] = nil, nil, nil
end

local function destroy(rec)
  rec.closing = true
  for key in pairs(rec.views) do deleteView(rec, key) end
  for key, c in pairs(rec.labels) do pcall(function() c:delete() end); rec.labels[key] = nil end
end

closeWindow = function(id, by)
  local rec = S.wins[id]
  if not rec then return end
  S.wins[id] = nil
  destroy(rec)
  table.insert(S.closedOut, { id = id, by = by, at = nowMs() })
  if #S.closedOut > MAX_ACKS then table.remove(S.closedOut, 1) end
end

local function closeWhere(pred, by)
  local ids = {}
  for id, rec in pairs(S.wins) do if pred(rec.spec) then ids[#ids + 1] = id end end
  for _, id in ipairs(ids) do closeWindow(id, by) end
  return #ids
end

local function closeIntrusive(by) return closeWhere(guarded, by) end

--- Fail open / panic: every intrusive window gone, gamma restored.
local function teardownIntrusive(by)
  local n = closeIntrusive(by)
  restoreDim(by)
  return n
end

local function openWindow(spec)
  if type(spec) ~= "table" or type(spec.id) ~= "string" or type(spec.path) ~= "string" or type(spec.rev) ~= "string" then return end
  if guarded(spec) and suppressed() then return end
  local failed = S.failedRevs[spec.id .. "@" .. spec.rev]
  if failed and hs.timer.secondsSinceEpoch() - failed.at < LOAD_FAIL_QUARANTINE * 2 ^ (failed.n - 1) then return end
  local rec = S.wins[spec.id]
  if rec and rec.spec.rev == spec.rev then return end
  if rec then destroy(rec) end -- a new rev: rebuild (not reported as closed)
  rec = { spec = spec, views = {}, labels = {}, uccs = {} }
  S.wins[spec.id] = rec
  for key, target in pairs(targetScreens(spec)) do createView(rec, key, target) end
end

--- Screens changed / space switched / every beat: per-screen instances follow the screens, overlays stay on top.
local function reassert(screensChanged)
  for _, rec in pairs(S.wins) do
    local spec = rec.spec
    local targets = targetScreens(spec)
    if spec.perScreen then
      for key in pairs(rec.views) do if not targets[key] then deleteView(rec, key) end end
      for key, target in pairs(targets) do if not rec.views[key] then createView(rec, key, target) end end
    end
    for key, v in pairs(rec.views) do
      local target = targets[key]
      if screensChanged and target then
        pcall(function() v:frame(frameFor(spec, target.screen)) end)
        if rec.labels[key] then pcall(function() rec.labels[key]:delete() end); rec.labels[key] = nil end
      end
      if spec.mode ~= "normal" then
        pcall(function()
          v:level(WINDOW_LEVEL[spec.mode])
          if not v:isVisible() then v:show() end
        end)
      end
      local wantLabel = M.ejectEnabled and coversScreen(spec)
      if wantLabel and not rec.labels[key] then
        local s = (target and target.screen) or hs.screen.mainScreen()
        rec.labels[key] = makeEjectLabel(s, v:level() + 1)
      elseif not wantLabel and rec.labels[key] then
        pcall(function() rec.labels[key]:delete() end)
        rec.labels[key] = nil
      elseif rec.labels[key] then
        pcall(function() rec.labels[key]:show() end)
      end
    end
  end
end

local function applyCommands(cmds)
  if type(cmds) ~= "table" then return end
  for _, c in ipairs(cmds) do
    if type(c) == "table" and type(c.id) == "string" then
      local ok, err = pcall(function()
        if c.op == "window.open" then openWindow(c.window)
        elseif c.op == "window.close" then closeWindow(c.windowId, "system")
        elseif c.op == "dim" then dimPulse(c.dim)
        end
      end)
      if not ok then log("command %s failed: %s", c.id, tostring(err)) end
      table.insert(S.acks, c.id)
      if #S.acks > MAX_ACKS then table.remove(S.acks, 1) end
    end
  end
end

local function actualWindows()
  local out = {}
  for id, rec in pairs(S.wins) do out[id] = rec.spec.rev end
  return out
end

--- PANIC-EJECT (R-UI-EJECT): terminate Hammerspoon. A detached killer finishes the job if termination is refused.
local function eject()
  log("PANIC-EJECT — terminating Hammerspoon")
  pcall(hs.screen.restoreGamma)
  local pid = hs.processInfo.processID
  -- H-6: a simple backgrounded command with every fd redirected — it never holds the hs.task pipe.
  local cmd = string.format("nohup /bin/sh -c 'sleep 3; /bin/ps -p %d -o comm= | /usr/bin/grep -q Hammerspoon && /bin/kill -9 %d' </dev/null >/dev/null 2>&1 &", pid, pid)
  pcall(function() hs.task.new("/bin/sh", nil, { "-c", cmd }):start() end)
  os.exit(0)
end

--- Turns the debug eject on/off (persisted). No argument: current state.
function M.debugEject(on)
  if on == nil then return "debug eject is " .. (M.ejectEnabled and "ON" or "OFF") end
  M.ejectEnabled = on == true
  if EJECT_JSON then
    local f = io.open(EJECT_JSON, "w")
    if f then f:write(hs.json.encode({ enabled = M.ejectEnabled })); f:close() end
  end
  reassert(false)
  return "debug eject " .. (M.ejectEnabled and "ON — ⌃⌥⌘⇧F12 terminates Hammerspoon" or "OFF — ⌃⌥⌘⇧F12 (hold 1.5 s) is the panic latch again")
end

--- Test aid: the panic teardown + suppression, locally only (no latch, nothing persisted, nothing sent).
function M._panicDryRun(seconds)
  S.panicSimUntil = hs.timer.secondsSinceEpoch() + math.max(1, math.min(tonumber(seconds) or 20, 120))
  local n = teardownIntrusive("panic")
  return string.format("panic dry run: %d intrusive window(s) closed; suppression for %ds (local only)", n, math.floor(S.panicSimUntil - hs.timer.secondsSinceEpoch() + 0.5))
end

function M.windows()
  local out = {}
  for id, rec in pairs(S.wins) do
    local n, labels = 0, 0
    for _ in pairs(rec.views) do n = n + 1 end
    for _ in pairs(rec.labels) do labels = labels + 1 end
    out[id] = { mode = rec.spec.mode, rev = rec.spec.rev, views = n, ejectLabels = labels, failed = rec.failed or false }
  end
  return out
end

-- ───────────────────────────── heartbeat ─────────────────────────────

local function buildHeartbeat()
  local o = S.outbox
  -- At most BATCH per kind: after a long daemon outage the outbox drains over several beats (body limit 1 MB).
  local counts = { inputs = math.min(#o.inputs, BATCH), apps = math.min(#o.apps, BATCH), system = math.min(#o.system, BATCH) }
  local sentAt = nowMs()
  local samples = {
    inputs = { table.unpack(o.inputs, 1, counts.inputs) },
    apps = { table.unpack(o.apps, 1, counts.apps) },
    system = { table.unpack(o.system, 1, counts.system) },
    locked = S.sensors.isLocked and S.sensors.isLocked() or false,
    since = math.max(S.ackedSentAt or S.loadedAt or sentAt, S.lostUntil or 0),
  }
  S.headDrops = {}
  if S.sensors.openAppInterval then
    local open = S.sensors.openAppInterval()
    if open then table.insert(samples.apps, open) end
  end
  local body = {
    protocol = PROTOCOL,
    loadId = S.loadId,
    seq = S.seq,
    sentAt = sentAt,
    samples = samples,
    ui = {
      windows = actualWindows(), closed = { table.unpack(S.closedOut) }, dimmed = S.dim ~= nil,
      latches = M.latches, panicBy = S.panicBy, panicAt = S.panicAt,
    },
    acks = { table.unpack(S.acks) },
  }
  return hs.json.encode(body), counts, sentAt, S.panicAt, { acks = #S.acks, closed = #S.closedOut }
end

--- After a 200: forget the acks / closed reports that heartbeat carried.
local function dropSentUi(n)
  for _, k in ipairs({ "acks", "closed" }) do
    local list = k == "acks" and S.acks or S.closedOut
    local rest = {}
    for i = (n[k] or 0) + 1, #list do rest[#rest + 1] = list[i] end
    if k == "acks" then S.acks = rest else S.closedOut = rest end
  end
end

local function dropSent(counts)
  for k, sent in pairs(counts) do
    local n = math.max(0, sent - (S.headDrops[k] or 0)) -- the front shifted by that many since the beat was built
    local list = S.outbox[k]
    if n >= #list then S.outbox[k] = {} else
      local rest = {}
      for i = n + 1, #list do rest[#rest + 1] = list[i] end
      S.outbox[k] = rest
    end
  end
end

-- A daemon that accepts connections but never answers (blocked event loop) holds the port: SIGTERM cannot be handled
-- by a blocked loop, so TERM, then KILL — but only after checking the pid really is our daemon (pids get reused).
-- Every hs.task here is a plain, short command (no backgrounding — H-6).
local function recoverHung(pid)
  if S.recovering or not pid or not REPO then return end
  S.recovering = true
  local done = function()
    S.recovering = false
    S.timeouts = 0
  end
  S.psTask = hs.task.new("/bin/ps", function(code, out)
    local cmd = out or ""
    if code ~= 0 or not cmd:find(REPO .. "/src/main.ts", 1, true) then
      log("hung daemon: pid %s is not our daemon (%s) — not killing", tostring(pid), cmd:gsub("%s+$", ""))
      done()
      return
    end
    log("daemon pid %d does not answer — terminating it", pid)
    S.termTask = hs.task.new("/bin/kill", nil, { "-TERM", tostring(pid) })
    S.termTask:start()
    S.timers.kill = hs.timer.doAfter(3, function()
      S.killTask = hs.task.new("/bin/kill", function()
        done()
        if not M.latches.quit then spawnDaemon() end
      end, { "-KILL", tostring(pid) })
      S.killTask:start()
    end)
  end, { "-o", "command=", "-p", tostring(pid) })
  S.psTask:start()
end

local function onFailure(why)
  S.failures = S.failures + 1
  S.lastError = why
  downMenubar(why)
  -- Fail open (principle 5): nobody is kept behind a block or a dim that no daemon is managing.
  if why == "not running" or why == "no daemon.json" or S.failures >= 2 then
    if teardownIntrusive("failopen") > 0 then log("daemon unavailable (%s) — intrusive windows closed (fail open)", why) end
  end
  if M.latches.quit then return end
  local now = hs.timer.secondsSinceEpoch()
  if why == "timeout" then
    S.timeouts = S.timeouts + 1
    if S.timeouts >= HUNG_AFTER then recoverHung(S.daemon and S.daemon.pid) end
    return
  end
  -- Spawn only when nothing answers on the port; any HTTP answer means a daemon is running.
  if why ~= "not running" and why ~= "no daemon.json" then return end
  if S.spawnedAt and now - S.spawnedAt < math.max(SPAWN_GRACE, S.backoff) then return end
  if S.spawnedAt then S.backoff = math.min(S.backoff * 2, BACKOFF_MAX) end
  log("daemon unavailable (%s) — spawning", why)
  spawnDaemon()
end

local function onSuccess(reply, info, sentPanicAt)
  S.failures = 0
  S.starting = 0
  S.timeouts = 0
  S.lastError = nil
  S.lastOkAt = hs.timer.secondsSinceEpoch()
  S.protocolMismatch = false
  if S.adopted == nil then S.adopted = (S.spawnedAt == nil) end
  if info.startedAt and (nowMs() - info.startedAt) > 60000 then S.backoff = 2 end
  -- Only the latch this heartbeat reported: a panic pressed while it was in flight has a newer panicAt.
  if reply.panicExpired and M.latches.panic and S.panicAt == sentPanicAt then
    -- The daemon decides: the panic latch lasts until the next 04:00 (R-UI-ESC).
    M.latches.panic = false
    S.panicBy = nil
    S.panicAt = nil
    if PANIC_JSON then os.remove(PANIC_JSON) end
    log("panic latch cleared by the 04:00 rollover")
  end
  if reply.dayKey then S.dayKey = reply.dayKey end
  if reply.menubar then applyMenubar(reply.menubar) end
  applyCommands(reply.commands)
  reassert(false)
end

local function finish(gen)
  if gen ~= S.gen then return false end
  S.inflight = false
  if S.watchdog then S.watchdog:stop(); S.watchdog = nil end
  if S.pushPending then
    S.pushPending = false
    S.timers.push = hs.timer.doAfter(0.1, function() sendHeartbeat() end)
  end
  return true
end

-- After a 200 only (never after a failure: that would retry 10×/s on the main thread): drain a backlog faster.
local function drainBacklog()
  if #S.outbox.inputs > BATCH or #S.outbox.apps > BATCH or #S.outbox.system > BATCH then
    S.timers.push = hs.timer.doAfter(0.1, function() sendHeartbeat() end)
  end
end

sendHeartbeat = function()
  if M.latches.quit then return end
  if S.inflight then S.pushPending = true; return end
  local info = readDaemonInfo()
  if not info then onFailure("no daemon.json"); return end
  S.daemon = info
  S.seq = S.seq + 1
  S.gen = S.gen + 1
  local gen = S.gen
  local body, counts, sentAt, sentPanicAt, uiCounts = buildHeartbeat()
  S.inflight = true
  S.watchdog = hs.timer.doAfter(HEARTBEAT_TIMEOUT, function()
    if gen == S.gen and S.inflight then
      S.gen = S.gen + 1 -- the late callback (if any) is ignored
      S.inflight = false
      S.watchdog = nil
      onFailure("timeout")
    end
  end)
  local url = string.format("http://127.0.0.1:%d/bridge/heartbeat", info.port)
  hs.http.asyncPost(url, body, { ["Content-Type"] = "application/json", ["X-WB-Token"] = info.token }, function(status, resp)
    if not finish(gen) then return end
    if status == 200 then
      local ok, reply = pcall(hs.json.decode, resp)
      if ok and type(reply) == "table" then
        dropSent(counts)
        dropSentUi(uiCounts)
        S.ackedSentAt = sentAt
        onSuccess(reply, info, sentPanicAt)
        drainBacklog()
      else
        onFailure("bad reply")
      end
    elseif status == 409 then
      S.protocolMismatch = true
      onFailure("protocol mismatch")
    elseif status == 503 then
      S.lastError = "starting" -- daemon not ready yet; samples stay in the outbox
      S.starting = S.starting + 1
      if S.starting == FAILOPEN_503 and teardownIntrusive("failopen") > 0 then
        log("daemon still starting after %d beats — intrusive windows closed (fail open)", FAILOPEN_503)
      end
    elseif status == 401 then
      onFailure("token rejected") -- daemon.json is re-read on the next beat
    elseif status == -1 then
      onFailure("not running")
    else
      onFailure("HTTP " .. tostring(status))
    end
  end)
end

--- Sends a heartbeat now (sensors call this on sleep/wake/lock/unlock).
function M.pushNow() sendHeartbeat() end

-- ───────────────────────────── sensors ─────────────────────────────

local function sampleTime(item) return type(item) == "number" and item or item.to or item.at end

local function pushSample(kind, item)
  local list = S.outbox[kind]
  list[#list + 1] = item
  if #list > MAX_OUTBOX then
    local dropped = table.remove(list, 1)
    S.lostUntil = math.max(S.lostUntil or 0, sampleTime(dropped) + 1)
    if S.inflight then S.headDrops[kind] = (S.headDrops[kind] or 0) + 1 end
  end
end

-- Input instants. hs.host.idleTime() is whole seconds (H-1), sampled every second. Only a *reset* of the idle
-- counter (0, or lower than the previous sample) is an input: while locked with the display asleep the counter runs
-- slower than the wall clock, so `now − idle` creeps forward without any input (H-7). The derived instant must also
-- move forward by > 0.5 s (same input otherwise).
local function sampleIdle()
  local idle = hs.host.idleTime()
  local prev = S.prevIdle
  S.prevIdle = idle
  if prev ~= nil and idle ~= 0 and idle >= prev then return end
  local t = nowMs() - idle * 1000
  if not S.lastInputAt or t > S.lastInputAt + 500 then
    S.lastInputAt = t
    pushSample("inputs", t)
    if S.dim and S.dim.cancelOnInput then restoreDim("input") end
  end
end

local function appIdentity(app, fallbackName)
  local name = (app and app:name()) or fallbackName or "?"
  return (app and app:bundleID()) or name, name
end

local function switchApp(id, name)
  local t = nowMs()
  if S.app then
    if S.app.id == id then return end
    pushSample("apps", { id = S.app.id, name = S.app.name, from = S.app.from, to = t })
  end
  S.app = { id = id, name = name, from = t }
end

S.sensors.openAppInterval = function()
  if not S.app then return nil end
  return { id = S.app.id, name = S.app.name, from = S.app.from, to = nowMs() }
end

S.sensors.isLocked = function()
  local p = hs.caffeinate.sessionProperties()
  return (p and p.CGSSessionScreenIsLocked == true) or false
end

local CAFF = hs.caffeinate.watcher
local SYSTEM_EVENTS = {
  [CAFF.systemWillSleep] = "sleep", [CAFF.systemDidWake] = "wake",
  [CAFF.screensDidLock] = "lock", [CAFF.screensDidUnlock] = "unlock",
  [CAFF.screensDidSleep] = "display-sleep", [CAFF.screensDidWake] = "display-wake",
}

local function startSensors()
  S.loadedAt = nowMs()
  S.timers.idle = hs.timer.doEvery(1, sampleIdle)
  sampleIdle()
  local front = hs.application.frontmostApplication()
  if front then switchApp(appIdentity(front)) end
  S.sensors.watchers.apps = hs.application.watcher.new(function(name, event, app)
    if event == hs.application.watcher.activated then switchApp(appIdentity(app, name)) end
  end):start()
  S.sensors.watchers.caffeinate = CAFF.new(function(e)
    local ev = SYSTEM_EVENTS[e]
    if not ev then return end
    pushSample("system", { event = ev, at = nowMs() })
    sendHeartbeat() -- now, not in 5 s (before sleeping, and right after waking/unlocking)
  end):start()
end

-- ───────────────────────────── escape hatch ─────────────────────────────

local function savePanic()
  if not PANIC_JSON then return end
  local f = io.open(PANIC_JSON, "w")
  if f then
    f:write(hs.json.encode({ by = S.panicBy, at = S.panicAt }))
    f:close()
  end
end

function M.panic(by)
  M.latches.panic = true
  S.panicBy = by or "cli"
  S.panicAt = nowMs()
  savePanic()
  teardownIntrusive("panic")
  for _, w in pairs(S.previews) do pcall(function() w:delete() end) end
  S.previews = {}
  log("PANIC latch set by %s — overlays off until 04:00 or WorkBalancer.resume()", S.panicBy)
  sendHeartbeat()
  return "panic latch set — enforcement suppressed until the next 04:00 (WorkBalancer.resume() to undo)"
end

function M.resume()
  M.latches.panic = false
  S.panicBy = nil
  S.panicAt = nil
  if PANIC_JSON then os.remove(PANIC_JSON) end
  sendHeartbeat()
  return "panic latch cleared"
end

-- ───────────────────────────── stop (quit latch) ─────────────────────────────

--- Stops the daemon and keeps it stopped until the next module load (login / reload). Menu entry arrives in M8.
function M.quit()
  M.latches.quit = true
  local info = readDaemonInfo()
  if info then
    hs.http.asyncPost(string.format("http://127.0.0.1:%d/bridge/shutdown", info.port), '{"reason":"quit"}',
      { ["Content-Type"] = "application/json", ["X-WB-Token"] = info.token }, function() end)
  end
  if S.menu then S.menu:delete(); S.menu = nil end
  closeWhere(function() return true end, "system")
  restoreDim("quit")
  return "work-balancer stopped until the next Hammerspoon reload"
end

-- ───────────────────────────── dev preview ─────────────────────────────

--- Opens a page of the DEV daemon in a normal, closable window labelled DEV PREVIEW. Never touches live state.
function M.preview(url)
  local port = tonumber((url or ""):match("^http://127%.0%.0%.1:(%d+)/") or (url or ""):match("^http://localhost:(%d+)/"))
  if not port then return "preview: only http://127.0.0.1:<port>/… URLs" end
  if port == ((S.daemon and S.daemon.port) or LIVE_PORT_DEFAULT) then return "preview: refusing the live daemon's port" end
  local f = hs.screen.mainScreen():frame()
  -- The page's own Close button posts {op = "close"} on the `wb` port: close the preview (it is not a managed window).
  local ucc = hs.webview.usercontent.new("wb")
  local w
  ucc:setCallback(function(msg)
    local body = type(msg) == "table" and msg.body or nil
    if type(body) == "table" and (body.op == "close" or body.op == "failed") then
      S.timers.previewClose = hs.timer.doAfter(0, function() M.closePreviews(w) end)
    end
  end)
  w = hs.webview.new({ x = f.x + 80, y = f.y + 60, w = 960, h = 720 }, {}, ucc)
  w:windowTitle("DEV PREVIEW — " .. url)
  w:windowStyle({ "titled", "closable", "resizable", "miniaturizable" })
  w:closeOnEscape(true)
  w:deleteOnClose(true)
  w:allowTextEntry(true)
  w:url(url)
  w:show()
  local hw = w:hswindow()
  if hw then pcall(function() hw:focus() end) end
  table.insert(S.previews, w)
  return "preview opened"
end

--- Closes one preview window (or all of them).
function M.closePreviews(only)
  local keep, n = {}, 0
  for _, w in ipairs(S.previews) do
    if only == nil or w == only then
      pcall(function() w:delete() end)
      n = n + 1
    else
      keep[#keep + 1] = w
    end
  end
  S.previews = keep
  return n .. " preview(s) closed"
end

-- ───────────────────────────── introspection ─────────────────────────────

local function daemonState()
  if M.latches.quit then return "stopped(quit)" end
  if S.lastOkAt and S.failures == 0 then return "up" end
  if S.spawnedAt and hs.timer.secondsSinceEpoch() - S.spawnedAt < SPAWN_GRACE then return "starting" end
  return "down"
end

function M.health()
  local ago = S.lastOkAt and string.format("%.0fs", hs.timer.secondsSinceEpoch() - S.lastOkAt) or "never"
  return string.format("ok %s daemon=%s pid=%s adopted=%s lastHeartbeat=%s panic=%s%s",
    VERSION, daemonState(), tostring(S.daemon and S.daemon.pid or "-"), tostring(S.adopted),
    ago, M.latches.panic and "on" or "off", S.lastError and (" lastError=" .. S.lastError) or "")
end

function M.status()
  return {
    version = VERSION, repo = REPO, daemon = daemonState(), daemonInfo = S.daemon and { pid = S.daemon.pid, port = S.daemon.port } or nil,
    adopted = S.adopted, failures = S.failures, lastError = S.lastError, backoff = S.backoff, seq = S.seq,
    latches = M.latches, dayKey = S.dayKey,
    outbox = { inputs = #S.outbox.inputs, apps = #S.outbox.apps, system = #S.outbox.system },
  }
end

-- ───────────────────────────── lifecycle ─────────────────────────────

function M._unload()
  for _, t in pairs(S.timers) do pcall(function() t:stop() end) end
  for _, w in pairs(S.sensors.watchers or {}) do pcall(function() w:stop() end) end
  for _, h in pairs(S.hotkeys) do pcall(function() h:delete() end) end
  for _, w in pairs(S.previews) do pcall(function() w:delete() end) end
  if S.watchdog then pcall(function() S.watchdog:stop() end) end
  if S.menu then pcall(function() S.menu:delete() end) end
  for _, rec in pairs(S.wins or {}) do pcall(destroy, rec) end
  S.wins = {}
  S.gen = S.gen + 1
  hs.screen.restoreGamma()
end

local previousShutdown = hs.shutdownCallback
hs.shutdownCallback = function()
  pcall(M._unload)
  if previousShutdown then pcall(previousShutdown) end
end

-- ⌃⌥⌘⇧F12 (⌘⌃⌥P / ⌘⌃⌥R are taken by the owner's other modules; macOS swallows Esc with ⌘⌥ — Force Quit, H-9):
-- while the debug eject is on, a press terminates
-- Hammerspoon (R-UI-EJECT); otherwise holding it 1.5 s sets the panic latch (R-UI-ESC).
S.hotkeys.panic = hs.hotkey.bind({ "ctrl", "alt", "cmd", "shift" }, "f12",
  function()
    if M.ejectEnabled then eject(); return end
    S.timers.panicHold = hs.timer.doAfter(PANIC_HOLD, function()
      M.panic("hotkey")
      hs.alert.show("work-balancer: paused until 04:00 — breathe. (WorkBalancer.resume() undoes it)", 4)
    end)
  end,
  function()
    if S.timers.panicHold then S.timers.panicHold:stop(); S.timers.panicHold = nil end
  end)

-- Restore a panic latch from before a reload; the daemon expires it at the next 04:00.
if PANIC_JSON then
  local f = io.open(PANIC_JSON, "r")
  if f then
    local ok, p = pcall(hs.json.decode, f:read("a"))
    f:close()
    if ok and type(p) == "table" and p.at then
      M.latches.panic = true
      S.panicBy = p.by or "unknown"
      S.panicAt = p.at
      log("panic latch restored (set by %s)", S.panicBy)
    end
  end
end

if not REPO then
  log("ERROR: cannot locate the repo from %s", selfPath)
else
  downMenubar("connecting")
  startSensors()
  S.sensors.watchers.screens = hs.screen.watcher.new(function()
    restoreDim("screens changed")
    reassert(true)
  end):start()
  S.sensors.watchers.spaces = hs.spaces.watcher.new(function() reassert(false) end):start()
  S.timers.heartbeat = hs.timer.doEvery(HEARTBEAT_EVERY, function() sendHeartbeat() end)
  S.timers.first = hs.timer.doAfter(0.2, function() sendHeartbeat() end)
end

M._S = S -- debugging only: hs -c 'return hs.inspect(WorkBalancer._S.outbox)'
WorkBalancer = M
log("loaded %s (repo %s)", VERSION, tostring(REPO))
return M
