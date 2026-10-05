// Inactivity dialog (ledger R-UI-INACT, D-11, D-19, D-33, D-35). After `busyGraceMin` without input on a day with
// `inactivityDialog`, a ~10 s pre-warning dim (any input cancels it — the owner was just reading); otherwise a gap is
// detected and a full-screen dialog on every screen — no Esc, no timeout (owner, D-56) — asks how the time away should
// count (the escape hatches still apply: panic, the debug eject, fail-open, the 04:00 expiry):
//   back  — the default busy rule (nothing credited)
//   whole — the whole gap [lastInput, nextInput) is work, locked/asleep time included (D-19)
//   some  — N minutes from the gap start, [from, from + N)
// Unresolved gaps expire at the next 04:00 (= default rule). A later resolution of the same gap replaces the earlier.
// Once the dialog is on screen, input does NOT end the gap (owner, D-56: moving the mouse over the dialog is not being
// back) — the gap runs until he answers; only one gap is ever open. Inside a gap, the resolution overrides the busy rule
// (R-INFO-3): [from + grace, to) counts only what was credited (his clicks on the dialog are not work). Credits and that
// override are a `work` source, so every total (day, week, ladder) honours them retroactively (R-INFO-5).
import type { DimSpec, Effect, WindowInput } from '../core/effects.ts';
import type { Logger } from '../core/log.ts';
import type { Interval } from '../core/intervals.ts';
import { normalize } from '../core/intervals.ts';
import { dayEnd, dayKey, dayStart } from '../core/time.ts';
import type { AnyRecord } from '../store/records.ts';
import type { Store } from '../store/store.ts';
import type { WorkSource } from '../providers/work/index.ts';

export const CHOICES = ['back', 'whole', 'some', 'expired'] as const;
export type Choice = (typeof CHOICES)[number];

/** Pre-warning dim (D-33). */
export const PREWARN_DIM: Omit<DimSpec, 'pulseId'> = { level: 0.6, seconds: 10, cancelOnInput: true };
/** From the decision to dim until a gap is declared: ≤ 5 s until the next heartbeat delivers the dim, 10 s of dim,
 * ≤ 5 s until the heartbeat that would carry a cancelling input, + margin. */
export const PREWARN_WAIT_MS = 22_000;
/** Idle beyond grace + this when first noticed (after a sleep, a daemon restart): no pre-warning, the gap is real. */
export const PREWARN_WINDOW_MS = 30_000;
/** Lua reports a new window with the next heartbeat (≤ 5 s after it appeared). */
const HEARTBEAT_SLACK_MS = 5_000;
/** Sensors older than this: Lua is not sampling (ejected, crashed, reloading) — nothing is detected, and a dialog
 * period without a close record ends where the coverage ends (review M9#1). */
export const SENSORS_FRESH_MS = 15_000;
/** A return this recent after an absence nobody saw (the Mac slept; the wake heartbeat already carried his key press)
 * is still asked about (review M9b#1). */
export const RETRO_RECENT_MS = 2 * 60_000;

export interface Resolution {
  gapId: string;
  from: number;
  to: number;
  choice: Choice;
  creditedMinutes: number;
}

export const gapIdFor = (lastInputAt: number): string => `g-${lastInputAt}`;

/** Credited interval of a resolution (normative arithmetic, R-UI-INACT). */
export function creditOf(r: Pick<Resolution, 'from' | 'to' | 'creditedMinutes'>): Interval | null {
  const end = Math.min(r.to, r.from + r.creditedMinutes * 60_000);
  return end > r.from ? [r.from, end] : null;
}

/** Minutes credited for a choice on the gap [from, to). `some` is clamped to [0, gap length]. */
export function creditedMinutesFor(choice: Choice, from: number, to: number, minutes?: unknown): number {
  const gapMin = Math.max(0, (to - from) / 60_000);
  if (choice === 'whole') return gapMin;
  if (choice === 'some') return typeof minutes === 'number' && Number.isFinite(minutes) ? Math.min(gapMin, Math.max(0, Math.round(minutes))) : 0;
  return 0;
}

export interface InactivityDeps {
  store: Store;
  log: Logger;
  now: () => number;
  graceMs: () => number;
  /** End of the latest input run at/before `now` within [since, now], or null. */
  lastInputAt: (since: number, now: number) => number | null;
  /** Starts of the owner's activity (input runs, human prompts) after `t` (up to `now`), ascending. */
  inputStartsAfter: (t: number, now: number) => number[];
  /** The owner's activity runs [a, b] (closed; an instant is [t, t]) intersecting [from, to), sorted by start. */
  activity: (from: number, to: number) => Interval[];
  /** Locked ∪ asleep inside [from, to). */
  away: (from: number, to: number) => Interval[];
  /** End of Lua's latest sample span (sensor coverage), or null. Stale ⇒ Hammerspoon is down/ejected: no evidence. */
  coverageEnd: () => number | null;
  /** End of the continuous sensor coverage that contains `t` (Lua sampling without a hole), or null. */
  coveredUntil: (t: number) => number | null;
  /** The dialog may run now: live gate open, the day's `inactivityDialog`, not blocked (R-UI-INACT, D-35). */
  allowed: (now: number) => boolean;
}

export interface Inactivity {
  effect: Effect;
  workSource: WorkSource;
  load(records: readonly AnyRecord[]): void;
  tick(now: number): void;
  /** Unresolved gaps (diagnostics / tests). */
  open(): { gapId: string; from: number }[];
}

export function createInactivity(deps: InactivityDeps): Inactivity {
  const detected = new Map<string, number>(); // gapId → lastInputAt
  const resolved = new Map<string, Resolution>(); // last wins
  let credits: Interval[] = [];
  let version = 0;
  let prewarn: { lastInputAt: number; at: number } | null = null;
  /** Resolutions applied in memory whose record could not be written yet (fail open — review M9#2); retried. */
  let unsaved: Resolution[] = [];
  /** Last tick at which the dialog was not allowed (gate, day, block, panic); a restart counts (unknown before). */
  let lastDisallowedAt = deps.now();
  const sensorsFresh = (now: number): boolean => {
    const end = deps.coverageEnd();
    return end !== null && now - end <= SENSORS_FRESH_MS;
  };

  function apply(r: AnyRecord): void {
    if (r.type === 'inactivity.detected' && typeof r.gapId === 'string' && typeof r.lastInputAt === 'number') {
      detected.set(r.gapId, r.lastInputAt);
    } else if (
      r.type === 'inactivity.resolved' && typeof r.gapId === 'string' && typeof r.from === 'number' && typeof r.to === 'number'
      && CHOICES.includes(r.choice as Choice) && typeof r.creditedMinutes === 'number'
    ) {
      resolved.set(r.gapId, { gapId: r.gapId, from: r.from, to: r.to, choice: r.choice as Choice, creditedMinutes: r.creditedMinutes });
      credits = normalize([...resolved.values()].map(creditOf).filter((x): x is Interval => x !== null));
      version++;
    }
  }

  const unresolved = (): { gapId: string; from: number }[] =>
    [...detected].filter(([id]) => !resolved.has(id)).map(([gapId, from]) => ({ gapId, from })).sort((a, b) => a.from - b.from);

  /** While the dialog is (was) on screen, input does not end the gap: [first report − one heartbeat, close) from the
   * `effect.shown` / `effect.closed` audit of the `inactivity` window (a reload re-shows it: not an end). */
  function dialogIntervals(from: number, now: number): Interval[] {
    const out: Interval[] = [];
    let start: number | null = null;
    for (const r of deps.store.readDays(dayKey(from), dayKey(now))) {
      if (r.windowId !== 'inactivity' || r.ts < from) continue;
      if (r.type === 'effect.shown' && start === null) start = Math.max(from, r.ts - HEARTBEAT_SLACK_MS);
      else if (r.type === 'effect.closed' && start !== null) {
        // Any close ends it — a reload too: the re-shown window starts a new period (back-dated by the slack).
        out.push([start, r.ts]);
        start = null;
      }
    }
    if (start !== null) {
      // Still on screen — unless Lua went silent since (ejected / crashed / relaunched): then it ended where the
      // sensors stopped (a re-shown dialog starts a new period with its own `effect.shown`).
      const until = deps.coveredUntil(start + HEARTBEAT_SLACK_MS);
      out.push([start, until !== null && now - until > SENSORS_FRESH_MS ? Math.max(start, until) : Infinity]);
    }
    return out;
  }

  /** The first input that ends the gap (not while the dialog is up), or null. */
  function returnedAt(from: number, now: number): number | null {
    const ignore = dialogIntervals(from, now);
    return deps.inputStartsAfter(from, now).find((a) => !ignore.some(([x, y]) => a >= x && a < y)) ?? null;
  }

  /** The gap's end: the owner's return, clipped to its day (R-UI-INACT); `now` if he has not returned (or is
   * answering the dialog right now). */
  function gapEnd(from: number, now: number): number {
    return Math.min(returnedAt(from, now) ?? now, dayEnd(dayKey(from)));
  }

  /** Never fails from the owner's point of view: a record that cannot be written is applied in memory and retried
   * (an un-escapable dialog must never outlive a broken disk — principle 5, review M9#2). */
  function resolve(gapId: string, from: number, choice: Choice, minutes?: unknown): void {
    const now = deps.now();
    let to: number;
    try {
      to = Math.max(from, gapEnd(from, now));
    } catch (e) {
      deps.log.error('inactivity: gap end unknown — closing at now', { error: e as Error });
      to = Math.max(from, Math.min(now, dayEnd(dayKey(from))));
    }
    const creditedMinutes = creditedMinutesFor(choice, from, to, minutes);
    const res: Resolution = { gapId, from, to, choice, creditedMinutes };
    const r = deps.store.append({ type: 'inactivity.resolved', ...res });
    if (r) apply(r);
    else {
      apply({ v: 1, ts: now, type: 'inactivity.resolved', ...res });
      unsaved.push(res);
      deps.log.warn('inactivity resolution kept in memory (write failed) — will retry', { gapId });
    }
    deps.log.info('inactivity resolved', { gapId, choice, creditedMinutes: Math.round(creditedMinutes) });
  }

  /** An absence that ended before any tick could see it idle (sleep with the lid closed, then a key press that
   * arrived in the wake heartbeat): the last activity before a recent return, if the hole is long enough and Lua's
   * coverage was continuous across it (a Hammerspoon outage is no evidence). */
  function detectMissed(today: string, now: number): boolean {
    const acts = deps.activity(dayStart(today), now + 1);
    const grace = deps.graceMs();
    let prevEnd = -Infinity;
    for (const [a, b] of acts) {
      if (a >= now - RETRO_RECENT_MS && prevEnd > -Infinity && a - prevEnd >= grace + PREWARN_WINDOW_MS) {
        const covered = deps.coveredUntil(prevEnd);
        const id = gapIdFor(prevEnd);
        const knownGap = [...detected].some(([gid, from]) => {
          const end = resolved.get(gid)?.to ?? now;
          return from < a && end > prevEnd;
        });
        // Only an absence nobody could see: the Mac asleep/locked, Lua sampling throughout (not an outage), and the
        // dialog allowed for the whole time (never dig up a break from behind the live gate, a block or a panic).
        if (covered !== null && covered >= a && !knownGap && lastDisallowedAt < prevEnd && deps.away(prevEnd, a).length > 0) {
          const r = deps.store.append({ type: 'inactivity.detected', gapId: id, lastInputAt: prevEnd });
          if (r) {
            apply(r);
            deps.log.info('inactivity detected (after the return)', { gapId: id });
          }
          return true;
        }
      }
      prevEnd = Math.max(prevEnd, b);
    }
    return false;
  }

  function tick(now: number): void {
    const today = dayKey(now);
    if (unsaved.length) unsaved = unsaved.filter((res) => deps.store.append({ type: 'inactivity.resolved', ...res }) === null);
    // 04:00: yesterday's unanswered gaps take the default rule.
    for (const g of unresolved()) if (dayKey(g.from) < today) resolve(g.gapId, g.from, 'expired');
    if (!deps.allowed(now)) {
      lastDisallowedAt = now;
      prewarn = null;
      return;
    }
    if (!sensorsFresh(now)) {
      prewarn = null;
      return;
    }
    // One gap at a time: while one is unanswered, nothing new is detected (its dialog is up, or it was suppressed).
    if (unresolved().some((g) => dayKey(g.from) === today)) {
      prewarn = null;
      return;
    }
    if (detectMissed(today, now)) return;
    const last = deps.lastInputAt(dayStart(today), now);
    if (last === null) return; // nothing today yet: nobody is asked about the night
    const id = gapIdFor(last);
    if (detected.has(id)) return;
    const idle = now - last;
    const grace = deps.graceMs();
    if (idle < grace) {
      prewarn = null;
      return;
    }
    if (prewarn?.lastInputAt === last) {
      if (now - prewarn.at < PREWARN_WAIT_MS) return;
    } else if (idle < grace + PREWARN_WINDOW_MS) {
      prewarn = { lastInputAt: last, at: now };
      return;
    }
    prewarn = null;
    const r = deps.store.append({ type: 'inactivity.detected', gapId: id, lastInputAt: last });
    if (r) {
      apply(r);
      deps.log.info('inactivity detected', { gapId: id });
    }
  }

  const effect: Effect = {
    name: 'inactivity',
    audit: true,
    desired(now) {
      const dims: DimSpec[] = prewarn && now - prewarn.at < PREWARN_WAIT_MS ? [{ pulseId: `inact-${prewarn.lastInputAt}`, ...PREWARN_DIM }] : [];
      const today = dayKey(now);
      const gaps = unresolved().filter((g) => dayKey(g.from) === today);
      // Fail open: no un-escapable dialog while the data cannot be written (its answer could not be kept).
      if (!gaps.length || !deps.allowed(now) || deps.store.health().writeError) return { windows: [], dims: deps.store.health().writeError ? [] : dims };
      const w: WindowInput = {
        id: 'inactivity', path: '/ui/inactivity.html', title: 'work-balancer — welcome back', mode: 'overlay', placement: 'full',
        perScreen: true, focus: true, closable: false, intrusive: true,
      };
      return { windows: [w], dims };
    },
    model(_id, now) {
      const today = dayKey(now);
      return {
        now,
        gaps: unresolved().filter((g) => dayKey(g.from) === today).slice(0, 1).map((g) => {
          const back = returnedAt(g.from, now);
          const to = gapEnd(g.from, now);
          return { gapId: g.gapId, from: g.from, to: back === null ? null : to, maxMinutes: Math.floor(Math.max(0, to - g.from) / 60_000) };
        }),
      };
    },
    action(_id, action, payload) {
      const p = (payload && typeof payload === 'object' ? payload : {}) as { gapId?: unknown; choice?: unknown; minutes?: unknown };
      const open = unresolved();
      if (action === 'resolve') {
        const g = open.find((x) => x.gapId === p.gapId);
        if (!g) return { ok: false, error: 'unknown' };
        if (p.choice !== 'back' && p.choice !== 'whole' && p.choice !== 'some') return { ok: false, error: 'invalid' };
        resolve(g.gapId, g.from, p.choice, p.minutes);
      } else {
        // No `close`: the dialog ends only by answering (D-56).
        return { ok: false, error: `unknown action ${action}` };
      }
      const left = unresolved().filter((g) => dayKey(g.from) === dayKey(deps.now())).length;
      return { ok: true, close: left === 0, left };
    },
  };

  /** Inside a gap only the credited part counts (R-INFO-3): [from + grace, end) cuts busy time; credits are added back. */
  function overridden(from: number, to: number): Interval[] {
    const grace = deps.graceMs();
    const now = deps.now();
    const spans: Interval[] = [...resolved.values()].map((r) => [r.from + grace, r.to] as const);
    for (const g of unresolved()) spans.push([g.from + grace, gapEnd(g.from, now)]);
    return normalize(spans.filter(([a, b]) => b > a && b > from && a < to));
  }

  return {
    effect,
    workSource: {
      name: 'inactivity',
      credited: (from, to) => credits.filter(([a, b]) => b > from && a < to),
      blocked: overridden,
      // Open gaps grow with time: a fresh key each minute keeps cached day totals honest.
      version: () => version * 1e6 + (unresolved().length ? Math.floor(deps.now() / 60_000) % 1e6 : 0),
    },
    load(records) {
      for (const r of records) apply(r);
    },
    tick,
    open: unresolved,
  };
}

/** Credits + gap overrides from raw records (history of older days; their gaps are all resolved). */
export function creditsFromRecords(records: readonly AnyRecord[], graceMs: () => number): WorkSource {
  const inst = createInactivity({
    store: { readDays: () => [] } as unknown as Store, log: null as unknown as Logger, now: () => 0, graceMs,
    lastInputAt: () => null, inputStartsAfter: () => [], activity: () => [], away: () => [], coverageEnd: () => null, coveredUntil: () => null, allowed: () => false,
  });
  inst.load(records);
  return inst.workSource;
}

