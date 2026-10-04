-- work-balancer — thin Hammerspoon layer (sensors, actuators, daemon supervision).
-- All decisions live in the Node daemon; see .github/copilot-instructions.md §3.2 and §4.
-- Loaded by exactly one line in ~/.hammerspoon/init.lua: require("work-balancer")

require("hs.ipc") -- so the `hs` CLI works (scripts/reload-hammerspoon, health checks)

local VERSION = "0.1.0"

-- Clean up a previous load of this module (hs.reload re-runs init.lua in a fresh Lua state, but a manual
-- `require` re-load or package.loaded reset would otherwise leave timers/watchers behind).
if WorkBalancer and WorkBalancer._unload then
  pcall(WorkBalancer._unload)
end

local M = {
  version = VERSION,
  latches = { panic = false, quit = false },
}

function M.health()
  return "ok " .. VERSION
end

function M.panic()
  M.latches.panic = true
  hs.screen.restoreGamma()
  return "panic latch set"
end

function M.resume()
  M.latches.panic = false
  return "panic latch cleared"
end

function M._unload()
  hs.screen.restoreGamma()
end

-- hs.reload / quit: Hammerspoon calls hs.shutdownCallback (one global slot — chain any existing one).
local previousShutdown = hs.shutdownCallback
hs.shutdownCallback = function()
  pcall(M._unload)
  if previousShutdown then pcall(previousShutdown) end
end

WorkBalancer = M
return M
