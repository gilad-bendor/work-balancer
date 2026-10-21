// Days the tracker does not keep in memory (it loads only the current week): the summary's 20-week trend — worked
// time and what its timelines need (D-80). Each request builds throwaway providers from an uncached scan of the days'
// raw records, exactly like the tracker does at startup, so history follows the same `work` arithmetic (R-INFO-3).
// Settled days are cached.
import type { Logger } from '../core/log.ts';
import { addDays, dayEnd, dayKey, dayKeysBetween, dayStart, type DayKey } from '../core/time.ts';
import { clip, total, type Interval } from '../core/intervals.ts';
import { DEFAULT_CATEGORY } from '../categories/categories.ts';
import { blockedIntervals, categoryLayers, type TimelineLayer } from '../timeline/timeline.ts';
import type { Store } from '../store/store.ts';
import { createInteractiveProvider } from '../providers/interactive/index.ts';
import { createPromptHistoryProvider } from '../providers/prompt-history/index.ts';
import { createWorkProvider } from '../providers/work/index.ts';
import { creditsFromRecords } from '../inactivity/inactivity.ts';
import { reportPeriods, reportWorkSource, withoutReportWork } from '../reports/work.ts';

/** One past day, as the summary needs it. */
export interface DayDetail {
  seconds: number;
  /** Worked time (`work.busy`) inside the day. */
  busy: Interval[];
  /** Under a budget block (timeline `Blocked`). */
  blocked: Interval[];
  /** Worked time in another app category (timeline layers, D-67). */
  categories: TimelineLayer[];
}

export interface History {
  /** Worked seconds per day in [from, to] (both inclusive). */
  daySeconds(from: DayKey, to: DayKey): Map<DayKey, number>;
  /** Details per day in [from, to] (both inclusive). */
  days(from: DayKey, to: DayKey): Map<DayKey, DayDetail>;
}

const RAW_LINE = (line: string): boolean =>
  line.includes('"type":"minute"') || line.includes('"type":"system"') || line.includes('"type":"inactivity.resolved"') || line.includes('"type":"monitor.gap"') || line.includes('"windowId":"review:fresh"')
  || line.includes('"type":"policy.transition"') || line.includes('"type":"token.used"') || line.includes('"type":"bypass.used"') || line.includes('"type":"grant.ended"');

export function createHistory(deps: { store: Store; log: Logger; now: () => number; graceMs: () => number }): History {
  const cache = new Map<DayKey, { grace: number; detail: DayDetail }>();

  function compute(from: DayKey, to: DayKey): Map<DayKey, DayDetail> {
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
    const unmonitored = records.filter((r) => r.type === 'monitor.gap' && typeof r.from === 'number' && typeof r.to === 'number').map((r) => [r.from as number, r.to as number] as const);
    const credits = creditsFromRecords(records, deps.graceMs, {
      activity: (a, b) => [...interactive.workSource.activity!(a, b), ...prompts.workSource.activity!(a, b)].sort((x, y) => x[0] - y[0] || x[1] - y[1]),
      unseen: (t) => unmonitored.some(([a, b]) => t >= a && t < b),
    });
    // Once per pass: the records never change here, and re-scanning them for every input run is quadratic (review).
    const reported = reportPeriods(records, now(), (at) => interactive.coveredUntil(at, 15_000));
    const periods = () => reported;
    const version = () => 0;
    const work = createWorkProvider({
      sources: () => [withoutReportWork(interactive.workSource, periods, version), withoutReportWork(prompts.workSource, periods, version), withoutReportWork(credits, periods, version), reportWorkSource(periods, version)],
      graceMs: deps.graceMs, now,
    });
    const blocked = blockedIntervals(records, (ts) => dayEnd(dayKey(ts)), work.busy(dayStart(from), dayEnd(to)));
    return new Map(dayKeysBetween(from, to).map((k) => {
      const busy = work.busy(dayStart(k), dayEnd(k));
      return [k, {
        seconds: total(busy) / 1000, busy,
        blocked: clip(blocked, dayStart(k), dayEnd(k)),
        categories: categoryLayers(busy, (m) => interactive.getMinuteInfo(m)?.categories, DEFAULT_CATEGORY),
      }];
    }));
  }

  const empty = (): DayDetail => ({ seconds: 0, busy: [], blocked: [], categories: [] });

  function days(from: DayKey, to: DayKey): Map<DayKey, DayDetail> {
    const grace = deps.graceMs();
    const keys = dayKeysBetween(from, to);
    const missing = keys.filter((k) => cache.get(k)?.grace !== grace);
    const fresh = missing.length ? compute(missing[0]!, missing.at(-1)!) : new Map<DayKey, DayDetail>();
    const out = new Map<DayKey, DayDetail>();
    for (const k of keys) {
      const d = cache.get(k)?.grace === grace ? cache.get(k)!.detail : (fresh.get(k) ?? empty());
      out.set(k, d);
      if (dayEnd(k) <= deps.now()) cache.set(k, { grace, detail: d });
    }
    return out;
  }

  return {
    days,
    daySeconds: (from, to) => new Map([...days(from, to)].map(([k, d]) => [k, d.seconds])),
  };
}
