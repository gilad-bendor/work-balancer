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

## Current policy

The menubar shows today's worked time against today's limit, e.g. `⏱ 5:12 / 8:30`; hover for the week total and
the current stretch. Office days (Sun/Tue/Thu) have an **8.5-hour** daily budget; home days (Mon/Wed) have an
**8-hour** budget. Both use warnings, countdown, blocking, inactivity dialogs, break nudges and morning review.
Personal days (Fri/Sat) are tracking-only with a neutral menubar and no automatic interruptions or daily limit.
The **44-hour weekly budget** includes all days and can reduce a workday's effective limit. Activity is
recorded per minute in `data/YYYY-MM/YYYY-MM-DD.jsonl` (format: [.github/data-format.md](.github/data-format.md));
the policy lives in [config/policy.ts](config/policy.ts) and is hot-reloaded.

## Everyday commands

- `scripts/check` — typecheck + all tests.
- `hs -c 'return WorkBalancer.health()'` — is the Hammerspoon side alive (and the daemon up)?
- `curl "http://127.0.0.1:47621/api/status?token=$(jq -r .token var/live/daemon.json)"` — today/week numbers as JSON.
- `scripts/restart-daemon` — after changing `src/` (Hammerspoon keeps adopting the running daemon otherwise).
- `scripts/prompt-history-report` — today's Copilot prompts/answers as classified by the `prompt-history` provider (counts only; writes nothing).
- `scripts/reload-hammerspoon` — after changing `hammerspoon/work-balancer.lua`.
- `hs -c 'WorkBalancer.panic()'` — escape hatch: tear down every overlay until the next 04:00 (`WorkBalancer.resume()` undoes it).

## Dev instance (browser-only, safe beside the live one)

```sh
WB_ENV=dev scripts/run-daemon                      # port 47622, runtime files + data under var/dev/
WB_ENV=dev WB_FAKE_NOW=2026-10-08T17:30 scripts/run-daemon   # start at a fake time (then runs in real time)
curl "http://127.0.0.1:47622/api/status?token=$(jq -r .token var/dev/daemon.json)"
hs -c 'return WorkBalancer.preview("http://127.0.0.1:47622/…")'   # look at a dev page in an hs.webview
```

The dev daemon never touches `data/` or `var/live/`, and Hammerspoon never talks to it (except `preview`).
