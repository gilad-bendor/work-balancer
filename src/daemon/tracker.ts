// Wires the providers to the daemon (M4 observe mode): sensor ingest, minute records, monitor gaps, the `work`
// digest, today/week aggregates, and the menubar text/colour.
import { DAEMON_VERSION, type Tracker, type TrackerDeps } from './daemon.ts';
import { createInfoRepository } from '../core/registry.ts';
import { addDays, dayEnd, dayKey, dayKeysBetween, dayStart, minuteKey, weekday, weekStartKey, type DayKey } from '../core/time.ts';
import { clip, normalize, subtract, total, type Interval } from '../core/intervals.ts';
import type { MenubarSpec } from '../core/effects.ts';
import type { GapCause } from '../store/records.ts';
import { createInteractiveProvider } from '../providers/interactive/index.ts';
import { createWorkProvider } from '../providers/work/index.ts';
import { createPromptHistoryProvider } from '../providers/prompt-history/index.ts';
import { evaluate, type GrantRecord, type Level, type PolicyState } from '../policy/evaluate.ts';
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
  const promptHistory = createPromptHistoryProvider({
    store, log, now: () => clock.now(), home: deps.copilotHome,
    inputActivity: (from, to) => interactive.workSource.activity!(from, to),
  });
  promptHistory.load(history);
  promptHistory.poll(now0, { force: true });
  const work = createWorkProvider({
    sources: () => [interactive.workSource, promptHistory.workSource],
    graceMs: () => (policy.state().config?.busyGraceMin ?? DEFAULT_GRACE_MIN) * 60_000,
    now: () => clock.now(),
  });
  const repo = createInfoRepository();
  repo.register('interactive', { perMinute: interactive, timeRange: interactive });
  repo.register('prompt-history', { perMinute: promptHistory, timeRange: promptHistory });
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

  /** Last logged ladder level per day (restored from today's `policy.transition` records after a restart). */
  let levelDay: DayKey | null = null;
  let lastLevel: Level = 'ok';

  // A block latches until 04:00 under this key: a config edit — or a daemon version bump shipping a bug fix — releases
  // it (principle 5: never trap the owner because of a bug). Bump package.json's version for fixes that change worked time.
  const latchKey = (): string => `${policy.state().hash ?? 'none'}@${DAEMON_VERSION}`;

  function policyState(now: number): PolicyState {
    const { today, earlier, todaySeconds } = weekNumbers(now);
    const records = store.readDay(today);
    const grants = records.filter((r) => (r.type === 'token.used' || r.type === 'bypass.used') && typeof r.until === 'number' && typeof r.minutes === 'number') as unknown as GrantRecord[];
    if (levelDay !== today) {
      levelDay = today;
      const last = records.filter((r) => r.type === 'policy.transition').at(-1);
      lastLevel = (typeof last?.to === 'string' ? last.to : 'ok') as Level;
    }
    const lastBlocked = records.filter((r) => r.type === 'policy.transition' && r.to === 'blocked').at(-1);
    return evaluate({
      config: policy.state().config, now, day: today, workedTodaySeconds: todaySeconds, workedEarlierThisWeekSeconds: earlier, grants,
      activeToday: (work.getRangeInfo(dayStart(today), now)?.firstActivityAt ?? null) !== null,
      blockedTodayUnderConfig: typeof lastBlocked?.configHash === 'string' ? lastBlocked.configHash : null,
      configHash: latchKey(),
    });
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
      promptHistory.poll(now);
      const st = policyState(now);
      // The tick may straddle 04:00 (flush/poll take time): never file a transition into the next day.
      if (st.level !== lastLevel && dayKey(clock.now()) === st.day) {
        store.append({
          type: 'policy.transition', from: lastLevel, to: st.level, configHash: latchKey(), workedMin: Math.floor(st.workedSeconds / 60),
          limitMin: st.limitSeconds === null ? null : Math.floor(st.limitSeconds / 60),
          weekMin: Math.floor(weekNumbers(now).weekSeconds / 60),
        });
        log.info('policy level', { from: lastLevel, to: st.level });
        lastLevel = st.level;
      }
      const today = dayKey(now);
      if (today !== lastPruneDay) {
        lastPruneDay = today;
        interactive.prune(dayStart(addDays(weekStartKey(today), -1)));
      }
    },

    flush(now) {
      interactive.flushMinutes(now, { all: true });
    },

    lastInputAt(now) {
      return interactive.workSource.activity!(now - 10 * 60_000, now + 1).at(-1)?.[1] ?? null;
    },

    menubar(now): MenubarSpec {
      const c = policy.state().config;
      const { today, earlier, todaySeconds, weekSeconds } = weekNumbers(now);
      const stretch = work.currentStretch();
      const wd = weekday(today);
      if (!c) {
        return { title: strings.menubarTitle(todaySeconds, null), colour: 'none', tooltip: [strings.tooltipToday(todaySeconds, null, null), strings.trackingOnly].join('\n'), warning: null };
      }
      const st = policyState(now);
      const base = st.limitSeconds ?? st.referenceSeconds;
      const lines = [
        wd === 'sat' ? strings.tooltipShabbat : wd === 'fri' ? strings.tooltipFriday : strings.tooltipToday(todaySeconds, st.limitSeconds, st.referenceSeconds),
        ...(wd === 'sat' || wd === 'fri' ? [strings.tooltipToday(todaySeconds, null, null)] : []),
        strings.tooltipWeek(weekSeconds, c.weeklyBudgetMin * 60),
        strings.tooltipStretch(stretch ? stretch.seconds : null),
        strings.observeMode,
      ];
      return { title: strings.menubarTitle(todaySeconds, base), colour: st.colour, tooltip: lines.join('\n'), warning: promptHistory.warning(now, todaySeconds) };
    },

    status(now) {
      const c = policy.state().config;
      const { today, earlier, todaySeconds, weekSeconds } = weekNumbers(now);
      const start = dayStart(today);
      const end = minuteKey(now) + 60_000;
      const policyNow = c ? policyState(now) : null;
      return {
        today,
        weekday: weekday(today),
        workedSeconds: todaySeconds,
        weekSeconds,
        workedEarlierThisWeekSeconds: earlier,
        policy: policyNow,
        currentStretch: work.currentStretch(),
        work: work.getRangeInfo(start, end),
        interactive: interactive.getRangeInfo(start, end),
        prompts: promptHistory.getRangeInfo(start, end),
        promptDiagnostics: promptHistory.diagnostics(start, now),
        unmonitoredMinutes: Math.round(total(clip(gaps, start, now)) / 60_000),
        week: dayKeysBetween(weekStartKey(today), today).map((k) => ({ day: k, weekday: weekday(k), workedSeconds: work.daySeconds(k) })),
      };
    },
  };
}
