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
import { createNotes } from '../notes/notes.ts';
import { noteView, registerProductEffects } from '../effects/product.ts';
import { createHistory } from './history.ts';
import { createInactivity } from '../inactivity/inactivity.ts';
import { createEnforcement, type WeekInfo } from '../enforcement/enforcement.ts';

/** Coverage holes longer than this (and not explained by sleep) are recorded as `monitor.gap`. */
export const GAP_MIN_MS = 30_000;
const DEFAULT_GRACE_MIN = 5;

export async function createTracker(deps: TrackerDeps): Promise<Tracker> {
  const { store, clock, log, policy } = deps;
  const now0 = clock.now();
  const today0 = dayKey(now0);
  const loadFrom = addDays(weekStartKey(today0), -1);
  const history = store.readDays(loadFrom, today0);

  const interactive = createInteractiveProvider({
    store, log, now: () => clock.now(),
    ...(deps.categories ? { categorize: deps.categories.categorize } : {}),
  });
  interactive.load(history);
  const promptHistory = createPromptHistoryProvider({
    store, log, now: () => clock.now(), home: deps.copilotHome,
    inputActivity: (from, to) => interactive.workSource.activity!(from, to),
  });
  promptHistory.load(history);
  promptHistory.poll(now0, { force: true });
  // The owner's activity: input runs and human prompts (a prompt ends a gap too — review M9#1).
  // (Closed runs; an instant is [t, t] — so sorted, not normalize()d, which drops empty intervals.)
  const ownerActivity = (from: number, to: number): Interval[] =>
    [...interactive.workSource.activity!(from, to), ...promptHistory.workSource.activity!(from, to)].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const inactivity = createInactivity({
    store, log, now: () => clock.now(),
    graceMs: () => (policy.state().config?.busyGraceMin ?? DEFAULT_GRACE_MIN) * 60_000,
    lastInputAt: (since, now) => {
      // The max end (a prompt instant can sit inside the last input run — review M9b#1).
      const ends = ownerActivity(since, now + 1).map(([, b]) => b).filter((b) => b <= now);
      return ends.length ? Math.max(...ends) : null;
    },
    inputStartsAfter: (t, now) => ownerActivity(t + 1, now + 1).map(([a]) => a).filter((a) => a > t),
    activity: ownerActivity,
    away: (from, to) => interactive.blocked(from, to),
    coverageEnd: () => interactive.coverageEnd(),
    coveredUntil: (t) => interactive.coveredUntil(t, 15_000),
    allowed: (now) => {
      // Not while panicking: nothing would be shown, and a stale gap must not pop up after resume (review M9#3).
      if (!deps.effects?.gateOpen() || deps.effects.suppressed() || !policy.state().config) return false;
      const st = policyState(now);
      return st.dayPolicy?.inactivityDialog === true && st.weekday !== 'sat' && st.level !== 'blocked';
    },
  });
  inactivity.load(history);
  const work = createWorkProvider({
    sources: () => [interactive.workSource, promptHistory.workSource, inactivity.workSource],
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

  const graceMs = (): number => (policy.state().config?.busyGraceMin ?? DEFAULT_GRACE_MIN) * 60_000;
  const notes = createNotes({ store, log, now: () => clock.now(), feedbackChoices: () => policy.state().config?.feedbackChoices ?? [] });
  const dayHistory = createHistory({ store, log, now: () => clock.now(), graceMs });
  /** Day whose `day.rollover` record is known to exist (written by this daemon or found in the file). */
  let rolloverDay: DayKey | null = null;

  /** One `day.rollover` per day (current day's file): written on the first tick of a day — at 04:00, on the first
   * tick after a wake, or at a start on a day the daemon has not seen. It also decides the morning review (D-35). */
  function rollover(now: number): void {
    const today = dayKey(now);
    if (rolloverDay === today) return;
    if (!store.readDay(today).some((r) => r.type === 'day.rollover')) {
      const c = policy.state().config;
      const review = c?.days[weekday(today)].morningReview === true && notes.active().length > 0;
      if (!store.append({ type: 'day.rollover', fromDay: rolloverDay ?? addDays(today, -1), toDay: today, review })) return; // retried next tick
      log.info('day rollover', { toDay: today, review });
    }
    rolloverDay = today;
  }

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
      forfeited: records.some((r) => r.type === 'budget.forfeited'),
    });
  }

  function weekNumbers(now: number) {
    const today = dayKey(now);
    const earlier = dayKeysBetween(weekStartKey(today), addDays(today, -1)).reduce((s, k) => s + work.daySeconds(k), 0);
    const todaySeconds = work.daySeconds(today);
    return { today, earlier, todaySeconds, weekSeconds: earlier + todaySeconds };
  }

  /** The activity summary (R-UI-MENU-3): today, this week per day vs budgets, the last 4 weeks, recent feedback. */
  function summary(now: number) {
    const c = policy.state().config;
    const { today, todaySeconds, weekSeconds } = weekNumbers(now);
    const start = dayStart(today);
    const end = minuteKey(now) + 60_000;
    const st = c ? policyState(now) : null;
    const w = work.getRangeInfo(start, end);
    const ia = interactive.getRangeInfo(start, end);
    const pr = promptHistory.getRangeInfo(start, end);
    const weekStart = weekStartKey(today);
    const weekRecords = store.readDays(weekStart, today);
    const count = (type: string, from: DayKey): number => weekRecords.filter((r) => r.type === type && dayKey(r.ts) >= from).length;
    const budgets = (k: DayKey) => {
      const dp = c?.days[weekday(k)];
      return {
        budgetSeconds: dp?.dailyBudgetMin != null ? dp.dailyBudgetMin * 60 : null,
        referenceSeconds: dp?.referenceMin != null ? dp.referenceMin * 60 : null,
        enforced: dp?.enforce === true,
      };
    };
    const past = dayHistory.daySeconds(addDays(weekStart, -21), addDays(weekStart, -1));
    const weeks = [3, 2, 1].map((i) => {
      const ws = addDays(weekStart, -7 * i);
      return { start: ws, workedSeconds: dayKeysBetween(ws, addDays(ws, 6)).reduce((sum, k) => sum + (past.get(k) ?? 0), 0), current: false };
    });
    weeks.push({ start: weekStart, workedSeconds: weekSeconds, current: true });
    return {
      now,
      today: {
        day: today, weekday: weekday(today), workedSeconds: todaySeconds,
        limitSeconds: st?.limitSeconds ?? null, referenceSeconds: st?.referenceSeconds ?? null, remainingSeconds: st?.remainingSeconds ?? null,
        level: st?.level ?? 'ok', enforcing: st?.enforcing ?? false,
        tokensLeft: st?.tokensLeft ?? [], tokensUsed: st?.tokensUsed ?? 0, bypassesUsed: st?.bypassesUsed ?? 0,
        prompts: pr?.prompts ?? 0, answers: pr?.answers ?? 0,
        topApps: (ia?.topApps ?? []).map((a) => ({ name: a.name, seconds: a.s })),
        longestStretchSeconds: w?.longestStretchSeconds ?? 0, breaks: w?.breaks ?? 0,
        currentStretchSeconds: work.currentStretch()?.seconds ?? null,
        firstActivityAt: w?.firstActivityAt ?? null, lastActivityAt: w?.lastActivityAt ?? null,
        unmonitoredMinutes: Math.round(total(clip(gaps, start, now)) / 60_000),
      },
      week: {
        start: weekStart, workedSeconds: weekSeconds, budgetSeconds: c ? c.weeklyBudgetMin * 60 : null,
        tokensUsed: count('token.used', weekStart), bypassesUsed: count('bypass.used', weekStart),
        days: dayKeysBetween(weekStart, addDays(weekStart, 6)).map((k) => ({
          day: k, weekday: weekday(k), workedSeconds: k <= today ? work.daySeconds(k) : null, isToday: k === today, ...budgets(k),
        })),
      },
      weeks,
      feedback: notes.recentFeedback(8).map(noteView),
      activeNotes: notes.active().length,
    };
  }

  if (deps.effects) {
    deps.effects.register(inactivity.effect);
    registerProductEffects({ effects: deps.effects, notes, store, now: () => clock.now(), config: () => policy.state().config, summary, quitAllowed });
    const enforcement = createEnforcement({
      store, log, now: () => clock.now(), notes, config: () => policy.state().config,
      state: (now) => (policy.state().config ? policyState(now) : null),
      week: weekInfo,
      currentStretch: () => work.currentStretch(),
    });
    for (const e of enforcement.effects) deps.effects.register(e);
  }

  /** No Quit while enforcement is due on the live-enabled instance (review M10#5): the countdown or the block —
   * including a token's minutes, when the menubar is reachable. */
  function quitAllowed(now: number): boolean {
    // Nothing is enforced while the block cannot show (store write error — fail open; panic): Quit stays (review M10b#1).
    if (!deps.effects?.gateOpen() || deps.effects.suppressed() || store.health().writeError || !policy.state().config) return true;
    const st = policyState(now);
    return !(st.enforcing && (st.level === 'countdown' || st.level === 'blocked'));
  }

  /** This week's days up to today vs their budgets (the block's numbers, R-UI-BLOCK). */
  function weekInfo(now: number): WeekInfo {
    const c = policy.state().config;
    const today = dayKey(now);
    const days = dayKeysBetween(weekStartKey(today), today).map((k) => {
      const dp = c?.days[weekday(k)];
      return { day: k, weekday: weekday(k), workedSeconds: work.daySeconds(k), budgetSeconds: dp?.dailyBudgetMin != null ? dp.dailyBudgetMin * 60 : null, isToday: k === today };
    });
    return { workedSeconds: days.reduce((s, x) => s + x.workedSeconds, 0), budgetSeconds: c ? c.weeklyBudgetMin * 60 : null, days };
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
      rollover(clock.now());
      interactive.flushMinutes(now);
      promptHistory.poll(now);
      try {
        inactivity.tick(now);
      } catch (e) {
        log.error('inactivity tick failed', { error: e as Error });
      }
      const st = policyState(now);
      // The tick may straddle 04:00 (flush/poll take time): never file a transition into the next day.
      if (st.level !== lastLevel && dayKey(clock.now()) === st.day) {
        const written = store.append({
          type: 'policy.transition', from: lastLevel, to: st.level, configHash: latchKey(), workedMin: Math.floor(st.workedSeconds / 60),
          limitMin: st.limitSeconds === null ? null : Math.floor(st.limitSeconds / 60),
          weekMin: Math.floor(weekNumbers(now).weekSeconds / 60),
        });
        // Not written (disk error): retried next tick — a level entry is what the warn/countdown key on.
        if (written) {
          log.info('policy level', { from: lastLevel, to: st.level });
          lastLevel = st.level;
        }
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
      const gate = deps.effects?.gateOpen() ?? false;
      const grantLeft = st.grant ? Math.max(0, st.grant.until - now) / 1000 : null;
      const lines = [
        wd === 'sat' ? strings.tooltipShabbat : wd === 'fri' ? strings.tooltipFriday : strings.tooltipToday(todaySeconds, st.limitSeconds, st.referenceSeconds),
        ...(wd === 'sat' || wd === 'fri' ? [strings.tooltipToday(todaySeconds, null, null)] : []),
        strings.tooltipWeek(weekSeconds, c.weeklyBudgetMin * 60),
        strings.tooltipStretch(stretch ? stretch.seconds : null),
        ...(st.grant ? [strings.tooltipGrant(st.grant.until)] : []),
        ...(st.enforcing && gate ? [strings.tooltipTokens(st.tokensLeft)] : []),
        ...(gate ? [] : [strings.observeMode]),
      ];
      const menu = quitAllowed(now) ? undefined : strings.menu.filter((m) => m.id !== 'quit' && m.id !== '-');
      return {
        title: strings.menubarTitle(todaySeconds, base, grantLeft), colour: st.colour, tooltip: lines.join('\n'), warning: promptHistory.warning(now, todaySeconds),
        ...(menu ? { menu: menu.map((m) => ({ ...m })) } : {}),
      };
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
