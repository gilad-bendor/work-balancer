// Wires the providers to the daemon (M4 observe mode): sensor ingest, minute records, monitor gaps, the `work`
// digest, today/week aggregates, and the menubar text/colour.
import type { Tracker, TrackerDeps } from './daemon.ts';
import { createInfoRepository } from '../core/registry.ts';
import { addDays, dayEnd, dayKey, dayKeysBetween, dayStart, minuteKey, weekday, weekStartKey, type DayKey } from '../core/time.ts';
import { clip, normalize, subtract, total, type Interval } from '../core/intervals.ts';
import type { MenubarSpec } from '../core/effects.ts';
import type { GapCause } from '../store/records.ts';
import { createInteractiveProvider } from '../providers/interactive/index.ts';
import { createWorkProvider } from '../providers/work/index.ts';
import { effectiveLimit, statusColour } from '../policy/observe.ts';
import { strings } from '../ui/strings.ts';

/** Coverage holes longer than this (and not explained by sleep) are recorded as `monitor.gap`. */
export const GAP_MIN_MS = 30_000;
const DEFAULT_GRACE_MIN = 5;

export async function createTracker(deps: TrackerDeps): Promise<Tracker> {
  const { store, clock, log, policy } = deps;
  const now0 = clock.now();
  const today0 = dayKey(now0);
  const loadFrom = addDays(weekStartKey(today0), -1);
  const history = store.readDays(loadFrom, today0);

  const interactive = createInteractiveProvider({ store, log, now: () => clock.now() });
  interactive.load(history);
  const work = createWorkProvider({
    sources: () => [interactive.workSource],
    graceMs: () => (policy.state().config?.busyGraceMin ?? DEFAULT_GRACE_MIN) * 60_000,
    now: () => clock.now(),
  });
  const repo = createInfoRepository();
  repo.register('interactive', { perMinute: interactive, timeRange: interactive });
  repo.register('work', { perMinute: work, timeRange: work });
  await repo.startAll({ clock, log, store });

  let gaps: Interval[] = normalize(
    history.filter((r) => r.type === 'monitor.gap' && typeof r.from === 'number' && typeof r.to === 'number').map((r) => [r.from as number, r.to as number] as const),
  );
  const lastStop = history.filter((r) => r.type === 'daemon.stopped' || r.type === 'daemon.started').at(-2);
  const previousStopReason = lastStop?.type === 'daemon.stopped' ? String(lastStop.reason ?? '') : null;
  let lastPruneDay: DayKey = today0;

  function recordGap(from: number, to: number, cause: GapCause): void {
    // Locked or asleep time is not a monitoring gap (nothing to monitor; and idle locked minutes have no records).
    const unexplained = subtract([[from, to]], interactive.blocked(from, to)).filter(([a, b]) => b - a > GAP_MIN_MS);
    for (const [a, b] of unexplained) {
      // One record per day (gaps are clipped to their day).
      for (let k = dayKey(a); dayStart(k) < b; k = addDays(k, 1)) {
        const [pa, pb] = [Math.max(a, dayStart(k)), Math.min(b, dayEnd(k))];
        if (pb - pa <= 0) continue;
        store.append({ type: 'monitor.gap', from: pa, to: pb, cause });
        gaps = normalize([...gaps, [pa, pb]]);
        log.info('monitor gap', { from: new Date(pa).toISOString(), to: new Date(pb).toISOString(), cause });
      }
    }
  }

  function weekNumbers(now: number) {
    const today = dayKey(now);
    const earlier = dayKeysBetween(weekStartKey(today), addDays(today, -1)).reduce((s, k) => s + work.daySeconds(k), 0);
    const todaySeconds = work.daySeconds(today);
    return { today, earlier, todaySeconds, weekSeconds: earlier + todaySeconds };
  }

  return {
    ingest(samples, receivedAt) {
      const since = samples.since ?? receivedAt;
      const until = receivedAt;
      const end = interactive.coverageEnd();
      if (end !== null && since - end > GAP_MIN_MS) {
        const cause: GapCause = end < deps.startedAt ? (previousStopReason === 'quit' ? 'quit' : 'daemon-down') : 'hs-down';
        recordGap(end, since, cause);
      }
      interactive.ingest(samples, { since, until }, receivedAt);
    },

    tick(now) {
      interactive.flushMinutes(now);
      const today = dayKey(now);
      if (today !== lastPruneDay) {
        lastPruneDay = today;
        interactive.prune(dayStart(addDays(weekStartKey(today), -1)));
      }
    },

    flush(now) {
      interactive.flushMinutes(now, { all: true });
    },

    menubar(now): MenubarSpec {
      const c = policy.state().config;
      const { today, earlier, todaySeconds, weekSeconds } = weekNumbers(now);
      const stretch = work.currentStretch();
      const wd = weekday(today);
      if (!c) {
        return { title: strings.menubarTitle(todaySeconds, null), colour: 'none', tooltip: [strings.tooltipToday(todaySeconds, null, null), strings.trackingOnly].join('\n'), warning: null };
      }
      const limit = effectiveLimit(c, wd, earlier);
      const base = limit.limitSeconds ?? limit.referenceSeconds;
      const lines = [
        wd === 'sat' ? strings.tooltipShabbat : wd === 'fri' ? strings.tooltipFriday : strings.tooltipToday(todaySeconds, limit.limitSeconds, limit.referenceSeconds),
        ...(wd === 'sat' || wd === 'fri' ? [strings.tooltipToday(todaySeconds, null, null)] : []),
        strings.tooltipWeek(weekSeconds, c.weeklyBudgetMin * 60),
        strings.tooltipStretch(stretch ? stretch.seconds : null),
        strings.observeMode,
      ];
      return { title: strings.menubarTitle(todaySeconds, base), colour: statusColour(c, limit, todaySeconds), tooltip: lines.join('\n'), warning: null };
    },

    status(now) {
      const c = policy.state().config;
      const { today, earlier, todaySeconds, weekSeconds } = weekNumbers(now);
      const start = dayStart(today);
      const end = minuteKey(now) + 60_000;
      const limit = c ? effectiveLimit(c, weekday(today), earlier) : null;
      return {
        today,
        weekday: weekday(today),
        workedSeconds: todaySeconds,
        weekSeconds,
        workedEarlierThisWeekSeconds: earlier,
        limit,
        currentStretch: work.currentStretch(),
        work: work.getRangeInfo(start, end),
        interactive: interactive.getRangeInfo(start, end),
        unmonitoredMinutes: Math.round(total(clip(gaps, start, now)) / 60_000),
        week: dayKeysBetween(weekStartKey(today), today).map((k) => ({ day: k, weekday: weekday(k), workedSeconds: work.daySeconds(k) })),
      };
    },
  };
}
