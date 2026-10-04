// Observe mode (M4): today's limit and colour for the menubar. Pure. The full ladder (warn/countdown/block, tokens,
// bypass) is M6's evaluator, which will build on effectiveLimit().
import type { StatusColour } from '../core/effects.ts';
import type { Weekday } from '../core/time.ts';
import type { PolicyConfig } from './config.ts';

export interface DayLimit {
  weekday: Weekday;
  /** Enforced limit in seconds: min(daily budget, weekly budget − worked earlier this week), floor 0. Null = no budget. */
  limitSeconds: number | null;
  /** Colour-only reference on non-enforcing days. */
  referenceSeconds: number | null;
  enforcing: boolean;
  colours: boolean;
}

export function effectiveLimit(config: PolicyConfig, weekday: Weekday, workedEarlierThisWeekSeconds: number): DayLimit {
  const d = config.days[weekday];
  const limitSeconds = d.dailyBudgetMin === null
    ? null
    : Math.max(0, Math.min(d.dailyBudgetMin * 60, config.weeklyBudgetMin * 60 - workedEarlierThisWeekSeconds));
  return {
    weekday,
    limitSeconds,
    referenceSeconds: d.referenceMin === null ? null : d.referenceMin * 60,
    enforcing: d.enforce,
    colours: d.colours,
  };
}

/** green < orange (≥ fraction) < red (≥ limit). Saturday → grey; no reference (Friday) → none. */
export function statusColour(config: PolicyConfig, limit: DayLimit, workedSeconds: number): StatusColour {
  if (!limit.colours) return 'grey';
  const base = limit.limitSeconds ?? limit.referenceSeconds;
  if (base === null) return 'none';
  if (base === 0) return workedSeconds > 0 ? 'red' : 'orange';
  if (workedSeconds >= base) return 'red';
  if (workedSeconds >= config.ladder.orangeAtFraction * base) return 'orange';
  return 'green';
}
