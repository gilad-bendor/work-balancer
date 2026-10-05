// Worked time of days the tracker does not keep in memory (it loads only the current week): the summary's 4-week
// trend. Each request builds throwaway providers from an uncached scan of the days' raw records, exactly like the
// tracker does at startup, so history follows the same `work` arithmetic (R-INFO-3). Settled days are cached.
import type { Logger } from '../core/log.ts';
import { addDays, dayEnd, dayKeysBetween, type DayKey } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { createInteractiveProvider } from '../providers/interactive/index.ts';
import { createPromptHistoryProvider } from '../providers/prompt-history/index.ts';
import { createWorkProvider } from '../providers/work/index.ts';

export interface History {
  /** Worked seconds per day in [from, to] (both inclusive). */
  daySeconds(from: DayKey, to: DayKey): Map<DayKey, number>;
}

const RAW_LINE = (line: string): boolean => line.includes('"type":"minute"') || line.includes('"type":"system"');

export function createHistory(deps: { store: Store; log: Logger; now: () => number; graceMs: () => number }): History {
  const cache = new Map<DayKey, { grace: number; seconds: number }>();

  function compute(from: DayKey, to: DayKey): Map<DayKey, number> {
    // The day before `from` too: a grace window that started before 04:00 still counts after it.
    const records = dayKeysBetween(addDays(from, -1), to).flatMap((k) => deps.store.scanDay(k, RAW_LINE));
    const now = (): number => Math.min(deps.now(), dayEnd(to));
    const interactive = createInteractiveProvider({ store: deps.store, log: deps.log, now });
    interactive.load(records);
    const prompts = createPromptHistoryProvider({
      store: deps.store, log: deps.log, now, home: '/nonexistent-history-home',
      inputActivity: (a, b) => interactive.workSource.activity!(a, b),
    });
    prompts.load(records);
    const work = createWorkProvider({ sources: () => [interactive.workSource, prompts.workSource], graceMs: deps.graceMs, now });
    return new Map(dayKeysBetween(from, to).map((k) => [k, work.daySeconds(k)]));
  }

  return {
    daySeconds(from, to) {
      const grace = deps.graceMs();
      const days = dayKeysBetween(from, to);
      const missing = days.filter((k) => cache.get(k)?.grace !== grace);
      const fresh = missing.length ? compute(missing[0]!, missing.at(-1)!) : new Map<DayKey, number>();
      const out = new Map<DayKey, number>();
      for (const k of days) {
        const s = cache.get(k)?.grace === grace ? cache.get(k)!.seconds : (fresh.get(k) ?? 0);
        out.set(k, s);
        if (dayEnd(k) <= deps.now()) cache.set(k, { grace, seconds: s });
      }
      return out;
    },
  };
}
