# 2026-10-20 — worked-time grants (D-86) and the outage dialog (D-87)

**Owner's report.** At 18:18 he was blocked and used the 10-min token. He worked about 1 min, then left. The token ran
out on the wall clock at 18:28, so at 19:14 he came back to the block. He expected the "I am back" dialog first, so he
could say he had not been working and keep a few minutes. He then ejected Hammerspoon at 19:15, and expected the dialog
when Hammerspoon comes back after being off for more than 10 min.

## What changed

- **D-86: grants count worked minutes.** Tokens and the bypass now last a number of minutes of `work.busy`
  (`grantSpans` in `src/policy/evaluate.ts`).
  - A grant taken while another is running adds its minutes to what is left.
  - `grant.ended` ends the running grants.
  - No grant runs past 04:00.
  - The inactivity dialog can show during a grant (tracker `allowed`: no block on screen).
  - The `until` field in grant records is now informational only.
  - The evaluator, timelines and history all use this, so older days are reinterpreted.
  - Daemon version bumped to 0.9.0.
- **D-87: the dialog after a sensor outage.** When a `monitor.gap` of ≥ 10 min ended in the last 2 min,
  `detectOutage` asks about the time since the last activity before it. It does not ask if a block, a panic or the
  closed gate was seen during the outage.
  - Activity that no sensor saw (`unseen`, taken from the persisted gaps) does not end a gap and is not cut by one.

## Verification

- `scripts/check`: typecheck clean, 251 tests pass.
- New tests:
  - evaluator: worked-time grants, including time away;
  - enforcement: away during a token → dialog → "back" keeps 4 min, "whole" brings the block back at once;
  - inactivity: asks after an 18-min outage, not after an 8-min one, and not when a panic was on during the outage;
  - inactivity: prompts no sensor saw stay as work.
- I disabled the new guard and confirmed the outage test then fails.
- Adversarial review subagent (scratch scripts, including a replay on a copy of `data/` and a benchmark):
  - 2 medium and 2 low findings, all fixed.
  - Performance with a grant running is about 37 ms per beat, against 27 ms without.

## Deployment and what is left

- The live 0.8.5 daemon was stopped gracefully. Hammerspoon is down (ejected by the owner), so nothing respawned it.
  **The next Hammerspoon launch spawns 0.9.0.**
- Today stays blocked: the 16:54 + 18:18 tokens, chained, ran out at about 19:24 on the prompts he made while
  Hammerspoon was off.
- The outage dialog will not show for today's outage, because the block was up during it.
- Nothing is committed. D-85 (2026-10-18) is still uncommitted too.
- Open for the owner: a menu Quit (`cause: quit`) also triggers the outage dialog. I kept that on purpose.
