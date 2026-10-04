-- work-balancer — thin Hammerspoon layer: sensors, actuators, daemon supervision, transport.
-- No business logic here: every decision lives in the Node daemon (.github/copilot-instructions.md §3.2, §4).
-- Verified API behaviour and gotchas: .github/hammerspoon.md
-- Loaded by exactly one line in ~/.hammerspoon/init.lua: require("work-balancer")

require("hs.ipc") -- the `hs` CLI (scripts/reload-hammerspoon, health checks)

local VERSION = "0.3.0"
local PROTOCOL = 1
local HEARTBEAT_EVERY = 5      -- seconds
local HEARTBEAT_TIMEOUT = 15   -- our watchdog; asyncPost's own timeout is ~60 s and cannot be cancelled
local SPAWN_GRACE = 8          -- seconds to let a freshly spawned daemon come up before spawning again
local BACKOFF_MAX = 60
local LIVE_PORT_DEFAULT = 47621
local PANIC_HOLD = 1.5         -- seconds to hold the panic hotkey
local MAX_OUTBOX = 50000       -- per sample kind; oldest dropped beyond this (≈ 14 h of continuous input)
local BATCH = 5000             -- max samples per kind in one heartbeat

if WorkBalancer and WorkBalancer._unload then pcall(WorkBalancer._unload) end

local function log(fmt, ...) print(string.format("[work-balancer] " .. fmt, ...)) end
local function nowMs() return math.floor(hs.timer.secondsSinceEpoch() * 1000) end
local function shq(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end

-- Repo root from this file's real path (~/.hammerspoon/work-balancer.lua is a symlink into the repo).
local selfPath = hs.fs.pathToAbsolute(debug.getinfo(1, "S").source:sub(2)) or ""
local REPO = selfPath:match("^(.*)/hammerspoon/work%-balancer%.lua$")
local VAR = REPO and (REPO .. "/var/live") or nil
local DAEMON_JSON = VAR and (VAR .. "/daemon.json") or nil

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
  panicDay = nil,
  protocolMismatch = false,
  menu = nil,
  timers = {},
  hotkeys = {},
  previews = {},
  outbox = { inputs = {}, apps = {}, system = {} }, -- sensor samples not yet acknowledged by the daemon
  loadedAt = nil,       -- coverage starts here for the first heartbeat …
  ackedSentAt = nil,    -- … and at the last acknowledged heartbeat's sentAt afterwards
  lastInputAt = nil,
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
    since = S.ackedSentAt or S.loadedAt or sentAt,
  }
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
    ui = { windows = {}, dimmed = false, latches = M.latches, panicBy = S.panicBy },
    acks = {},
  }
  return hs.json.encode(body), counts, sentAt
end

local function dropSent(counts)
  for k, n in pairs(counts) do
    local list = S.outbox[k]
    if n >= #list then S.outbox[k] = {} else
      local rest = {}
      for i = n + 1, #list do rest[#rest + 1] = list[i] end
      S.outbox[k] = rest
    end
  end
end

local function onFailure(why)
  S.failures = S.failures + 1
  S.lastError = why
  downMenubar(why)
  if M.latches.quit then return end
  local now = hs.timer.secondsSinceEpoch()
  if why == "timeout" then return end -- a hung daemon still holds the port; spawning would not help
  if S.spawnedAt and now - S.spawnedAt < math.max(SPAWN_GRACE, S.backoff) then return end
  if S.spawnedAt then S.backoff = math.min(S.backoff * 2, BACKOFF_MAX) end
  log("daemon unavailable (%s) — spawning", why)
  spawnDaemon()
end

local function onSuccess(reply, info)
  S.failures = 0
  S.lastError = nil
  S.lastOkAt = hs.timer.secondsSinceEpoch()
  S.protocolMismatch = false
  if S.adopted == nil then S.adopted = (S.spawnedAt == nil) end
  if info.startedAt and (nowMs() - info.startedAt) > 60000 then S.backoff = 2 end
  if reply.dayKey then
    if M.latches.panic and S.panicDay and reply.dayKey ~= S.panicDay then
      M.latches.panic = false -- the panic latch lasts until the next 04:00 rollover (R-UI-ESC)
      S.panicBy = nil
      log("panic latch cleared by the 04:00 rollover")
    end
    S.dayKey = reply.dayKey
  end
  if reply.menubar then applyMenubar(reply.menubar) end
end

local sendHeartbeat

local function finish(gen)
  if gen ~= S.gen then return false end
  S.inflight = false
  if S.watchdog then S.watchdog:stop(); S.watchdog = nil end
  if S.pushPending or #S.outbox.inputs > BATCH or #S.outbox.apps > BATCH or #S.outbox.system > BATCH then
    S.pushPending = false
    S.timers.push = hs.timer.doAfter(0.1, function() sendHeartbeat() end)
  end
  return true
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
  local body, counts, sentAt = buildHeartbeat()
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
        S.ackedSentAt = sentAt
        onSuccess(reply, info)
      else
        onFailure("bad reply")
      end
    elseif status == 409 then
      S.protocolMismatch = true
      onFailure("protocol mismatch")
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

local function pushSample(kind, item)
  local list = S.outbox[kind]
  list[#list + 1] = item
  if #list > MAX_OUTBOX then table.remove(list, 1) end
end

-- Input instants. hs.host.idleTime() is whole seconds (H-1): sample every second; a new instant only when the
-- derived last-input time moved forward (jitter < 0.5 s is the same input).
local function sampleIdle()
  local t = nowMs() - hs.host.idleTime() * 1000
  if not S.lastInputAt or t > S.lastInputAt + 500 then
    S.lastInputAt = t
    pushSample("inputs", t)
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

function M.panic(by)
  M.latches.panic = true
  S.panicBy = by or "cli"
  S.panicDay = S.dayKey
  hs.screen.restoreGamma()
  for _, w in pairs(S.previews) do pcall(function() w:delete() end) end
  S.previews = {}
  log("PANIC latch set by %s — overlays off until 04:00 or WorkBalancer.resume()", S.panicBy)
  sendHeartbeat()
  return "panic latch set — enforcement suppressed until the next 04:00 (WorkBalancer.resume() to undo)"
end

function M.resume()
  M.latches.panic = false
  S.panicBy = nil
  S.panicDay = nil
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
  hs.screen.restoreGamma()
  return "work-balancer stopped until the next Hammerspoon reload"
end

-- ───────────────────────────── dev preview ─────────────────────────────

--- Opens a page of the DEV daemon in a normal, closable window labelled DEV PREVIEW. Never touches live state.
function M.preview(url)
  local port = tonumber((url or ""):match("^http://127%.0%.0%.1:(%d+)/") or (url or ""):match("^http://localhost:(%d+)/"))
  if not port then return "preview: only http://127.0.0.1:<port>/… URLs" end
  if port == ((S.daemon and S.daemon.port) or LIVE_PORT_DEFAULT) then return "preview: refusing the live daemon's port" end
  local f = hs.screen.mainScreen():frame()
  local w = hs.webview.new({ x = f.x + 80, y = f.y + 60, w = 960, h = 720 })
  w:windowTitle("DEV PREVIEW — " .. url)
  w:windowStyle({ "titled", "closable", "resizable", "miniaturizable" })
  w:deleteOnClose(true)
  w:url(url)
  w:show()
  w:bringToFront(true)
  table.insert(S.previews, w)
  return "preview opened"
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
  S.gen = S.gen + 1
  hs.screen.restoreGamma()
end

local previousShutdown = hs.shutdownCallback
hs.shutdownCallback = function()
  pcall(M._unload)
  if previousShutdown then pcall(previousShutdown) end
end

-- Panic hotkey: hold ⌃⌥⌘⇧Esc for 1.5 s (⌘⌃⌥P / ⌘⌃⌥R are taken by the owner's other modules).
S.hotkeys.panic = hs.hotkey.bind({ "ctrl", "alt", "cmd", "shift" }, "escape",
  function()
    S.timers.panicHold = hs.timer.doAfter(PANIC_HOLD, function()
      M.panic("hotkey")
      hs.alert.show("work-balancer: paused until 04:00 — breathe. (WorkBalancer.resume() undoes it)", 4)
    end)
  end,
  function()
    if S.timers.panicHold then S.timers.panicHold:stop(); S.timers.panicHold = nil end
  end)

if not REPO then
  log("ERROR: cannot locate the repo from %s", selfPath)
else
  downMenubar("connecting")
  startSensors()
  S.timers.heartbeat = hs.timer.doEvery(HEARTBEAT_EVERY, function() sendHeartbeat() end)
  S.timers.first = hs.timer.doAfter(0.2, function() sendHeartbeat() end)
end

M._S = S -- debugging only: hs -c 'return hs.inspect(WorkBalancer._S.outbox)'
WorkBalancer = M
log("loaded %s (repo %s)", VERSION, tostring(REPO))
return M
