# work-balancer

A pre-commitment device for a healthier work week: a small Node daemon tracks worked time on this Mac, and a thin
Hammerspoon layer shows status (and, later, enforces the limits the rested owner configured in advance) — with
friction, not prohibition, and kind wording. Design and status: [.github/copilot-instructions.md](.github/copilot-instructions.md)
and [.github/ledger.md](.github/ledger.md).

## Setup

1. Node 26 via nvm (`nvm install 26`). Scripts never use the `node` on `PATH`; they go through `scripts/run-node`.
2. [Hammerspoon](https://www.hammerspoon.org/) with the `hs` CLI (`/opt/homebrew/bin/hs`).
3. `scripts/run-node --npm install` (dev dependencies only: `typescript`, `@types/node`).
4. `scripts/reload-hammerspoon` — symlinks `hammerspoon/work-balancer.lua` into `~/.hammerspoon/`, adds the single
   `require("work-balancer")` line to `~/.hammerspoon/init.lua` (backing it up first), reloads Hammerspoon and
   checks health. Safe to re-run.

## Everyday commands

- `scripts/check` — typecheck + all tests.
- `hs -c 'return WorkBalancer.health()'` — is the Hammerspoon side alive?
- `hs -c 'WorkBalancer.panic()'` — escape hatch: tear down every overlay until the next 04:00 (`WorkBalancer.resume()` undoes it).
