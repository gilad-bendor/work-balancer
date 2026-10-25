// Policy evaluator (ledger R-POL-2/3/3a/4, M6). PURE: config + now + worked time + today's grant records → PolicyState.
// Recomputed on every tick and on startup from data, so restarts/reloads can neither escape nor lose a block
// (instructions §4.2). Nothing here touches I/O, the clock or the UI.
import type { StatusColour } from '../core/effects.ts';
import { clip, normalize, total, type Interval } from '../core/intervals.ts';
import { dayEnd, dayKey, dayStart, weekday as weekdayOf, type DayKey, type Weekday } from '../core/time.ts';
import type { DayPolicy, PolicyConfig } from './config.ts';
import { effectiveLimit, statusColour } from './observe.ts';

export const LEVELS = ['ok', 'orange', 'warn', 'countdown', 'blocked'] as const;
export type Level = (typeof LEVELS)[number];

/** A `token.used` / `bypass.used` record (only the fields the evaluator needs). */
export interface GrantRecord {
  type: 'token.used' | 'bypass.used';
  ts: number;
  minutes: number;
  /** Informational since D-86 (the end if he worked non-stop); the evaluator uses `minutes`. */
  until?: number;
}

export interface PolicyInput {
  /** null = no valid policy: tracking only, never enforcing. */
  config: PolicyConfig | null;
  now: number;
  day: DayKey;
  workedTodaySeconds: number;
  workedEarlierThisWeekSeconds: number;
  /** Today's grant records, any order. */
  grants: readonly GrantRecord[];
  /** Timestamps of today's `grant.ended` records (the owner ended the borrowed time himself), any order. */
  grantEnds?: readonly number[];
  /** Today's worked intervals up to `now` (`work.busy`): grants are minutes of work (D-86). Absent = none. */
  busy?: readonly Interval[];
  /** A real input/prompt happened today (not only a grace window carried over from before 04:00). No level above `ok`
   * before that: nobody is warned or blocked at 04:00 while asleep (Q-3). */
  activeToday: boolean;
  /** Hash of the config under which today was already blocked (from today's `policy.transition` records), or null.
   * The block lasts until 04:00 even if worked time later shrinks — unless the config changed (an explicit act). */
  blockedTodayUnderConfig: string | null;
  /** Hash of the current config. */
  configHash: string | null;
  /** The owner ended the day himself (countdown "Save" — a `budget.forfeited` record today): blocked until 04:00. */
  forfeited?: boolean;
}

export interface PolicyState {
  day: DayKey;
  weekday: Weekday;
  /** The day's switches (D-35); all false without a config. */
  dayPolicy: DayPolicy | null;
  enforcing: boolean;
  workedSeconds: number;
  /** Effective limit (enforcing days), else null. */
  limitSeconds: number | null;
  referenceSeconds: number | null;
  remainingSeconds: number | null;
  /** Ladder level by worked time (enforcing days); 'ok' otherwise. */
  level: Level;
  /** Worked seconds at which the next level starts (null at the top or when not enforcing). */
  nextLevelAtSeconds: number | null;
  /** A token/bypass currently lifting the block, with the worked seconds it has left (D-86), or null. */
  grant: { leftSeconds: number } | null;
  /** Blocked and no active grant: the overlay must be up (subject to the Lua-side panic/quit latches). */
  blockActive: boolean;
  /** Effective limit is 0 (weekly budget used up): the block is preceded by a kind explanation (Q-3). */
  zeroLimit: boolean;
  tokensLeft: number[];
  tokensUsed: number;
  bypassesUsed: number;
  colour: StatusColour;
}

/** Ladder thresholds in worked seconds, clamped to [0, limit] (normative, R-POL-2). */
export function thresholds(config: PolicyConfig, limitSeconds: number): Record<Exclude<Level, 'ok'>, number> {
  const clamp = (x: number): number => Math.min(limitSeconds, Math.max(0, x));
  return {
    orange: clamp(config.ladder.orangeAtFraction * limitSeconds),
    warn: clamp(limitSeconds - config.ladder.warnBeforeMin * 60),
    countdown: clamp(limitSeconds - config.ladder.countdownBeforeMin * 60),
    blocked: limitSeconds,
  };
}

/** The highest level whose threshold is reached; `next` = worked seconds where the next HIGHER level starts.
 * A limit of 0 blocks after the first worked second (Q-3): `next` is then 0 ("any worked time"). */
export function ladderLevel(config: PolicyConfig, limitSeconds: number, worked: number): { level: Level; next: number | null } {
  if (limitSeconds === 0) return worked > 0 ? { level: 'blocked', next: null } : { level: 'ok', next: 0 };
  const t = thresholds(config, limitSeconds);
  const order = ['orange', 'warn', 'countdown', 'blocked'] as const;
  let level: Level = 'ok';
  for (const l of order) if (worked >= t[l]) level = l;
  const higher = order.slice(order.indexOf(level as (typeof order)[number]) + 1).map((l) => t[l]);
  return { level, next: higher.length ? Math.min(...higher) : null };
}

/** The end of the borrowed time if he works non-stop from `at` (informational `until` of grant records), clipped to the
 * end of `at`'s day (next 04:00). */
export function grantUntil(leftSeconds: number | null, at: number, minutes: number): number {
  return Math.min(dayEnd(dayKey(at)), at + (leftSeconds ?? 0) * 1000 + minutes * 60_000);
}

/** Minutes of a grant: `null` (the bypass with `minutes: null`) = the rest of `at`'s day, until 04:00. */
export const grantMinutes = (minutes: number | null, at: number): number =>
  minutes ?? Math.ceil((dayEnd(dayKey(at)) - at) / 60_000);

/** The running grant lasts until 04:00 whatever he does (worked time can never outrun the wall clock). */
export const grantToDayEnd = (st: Pick<PolicyState, 'grant' | 'day'>, now: number): boolean =>
  st.grant !== null && st.grant.leftSeconds * 1000 >= dayEnd(st.day) - now;

/** Earliest t ≥ `from` with `ms` of `busy` inside [from, t), or Infinity. */
function reach(busy: readonly Interval[], from: number, ms: number): number {
  let need = ms;
  if (need <= 0) return from;
  for (const [a, b] of busy) {
    if (b <= from) continue;
    const s = Math.max(a, from);
    if (b - s >= need) return s + need;
    need -= b - s;
  }
  return Infinity;
}

/** R-POL-3a as amended by D-86: a grant lifts the block for `minutes` of WORK — time away, locked or asleep does not use
 * it up. A grant taken while another runs adds its minutes to what is left; a `grant.ended` ends what runs (a grant
 * taken at that very moment is not affected); nothing outlives its day (04:00). `busy` = worked intervals (normalized),
 * known up to `to`. Returns the wall-clock spans that lifted the block and the worked seconds left at `to` (null =
 * nothing running then). */
export function grantSpans(
  grants: readonly { ts: number; minutes: number }[], ends: readonly number[], busy: readonly Interval[], to: number,
): { spans: Interval[]; leftSeconds: number | null } {
  busy = normalize(busy);
  const events = [...ends.map((t) => ({ t, minutes: null as number | null })), ...grants.map((g) => ({ t: g.ts, minutes: g.minutes }))]
    .filter((e) => e.t <= to)
    .sort((x, y) => x.t - y.t || (x.minutes === null ? 0 : 1) - (y.minutes === null ? 0 : 1));
  const spans: Interval[] = [];
  let run: { start: number; at: number; leftMs: number; dayEnd: number } | null = null;
  const expiry = (r: NonNullable<typeof run>): number => Math.min(r.dayEnd, reach(busy, r.at, r.leftMs));
  const close = (t: number): void => {
    if (run) spans.push([run.start, Math.max(run.start, t)]);
    run = null;
  };
  for (const e of events) {
    if (run && expiry(run) <= e.t) close(expiry(run));
    if (e.minutes === null) close(e.t);
    else if (run) {
      run.leftMs += e.minutes * 60_000 - total(clip(busy, run.at, e.t));
      run.at = e.t;
    } else run = { start: e.t, at: e.t, leftMs: e.minutes * 60_000, dayEnd: dayEnd(dayKey(e.t)) };
  }
  if (!run) return { spans, leftSeconds: null };
  const r: NonNullable<typeof run> = run;
  const end = expiry(r);
  spans.push([r.start, Math.min(end, to)]);
  return { spans, leftSeconds: end > to ? (r.leftMs - total(clip(busy, r.at, to))) / 1000 : null };
}

export function evaluate(input: PolicyInput): PolicyState {
  const { config, now, day } = input;
  const wd = weekdayOf(day);
  const worked = input.workedTodaySeconds;
  const from = dayStart(day);
  const to = dayEnd(day);
  // Only today's grants — none can lift a block beyond the day. One stamped after `now` (the clock stepped back) counts
  // from now.
  const sorted = input.grants.filter((g) => g.ts >= from && g.ts < to).map((g) => ({ ...g, ts: Math.min(g.ts, now) })).sort((a, b) => a.ts - b.ts);
  const { leftSeconds } = grantSpans(sorted, input.grantEnds ?? [], input.busy ?? [], now);
  const grant = leftSeconds !== null ? { leftSeconds } : null;
  const tokensUsed = sorted.filter((g) => g.type === 'token.used');
  const bypassesUsed = sorted.filter((g) => g.type === 'bypass.used').length;
  const base: PolicyState = {
    day, weekday: wd, dayPolicy: null, enforcing: false, workedSeconds: worked, limitSeconds: null, referenceSeconds: null,
    remainingSeconds: null, level: 'ok', nextLevelAtSeconds: null, grant, blockActive: false, zeroLimit: false,
    tokensLeft: [], tokensUsed: tokensUsed.length, bypassesUsed, colour: 'none',
  };
  if (!config) return base;

  // Principle 6 is non-negotiable: nothing intrusive on Shabbat, whatever the config says.
  const dayPolicy: DayPolicy = wd === 'sat'
    ? { ...config.days.sat, enforce: false, inactivityDialog: false, breakNudge: false, morningReview: false }
    : config.days[wd];
  const raw = effectiveLimit(config, wd, input.workedEarlierThisWeekSeconds);
  // Whole seconds: float leftovers of the weekly arithmetic must not turn a 0 limit into "3e-9".
  const limit = { ...raw, limitSeconds: raw.limitSeconds === null ? null : Math.floor(raw.limitSeconds) };
  const colour = statusColour(config, limit, worked);
  if (!dayPolicy.enforce || limit.limitSeconds === null) {
    // A non-enforcing day keeps its budget as a colour reference (title and colour use the same base).
    return { ...base, dayPolicy, referenceSeconds: limit.referenceSeconds ?? limit.limitSeconds, colour };
  }
  const left = [...config.tokensMin];
  for (const t of tokensUsed) {
    const i = left.indexOf(t.minutes);
    if (i >= 0) left.splice(i, 1);
  }
  const ladder = input.activeToday ? ladderLevel(config, limit.limitSeconds, worked) : { level: 'ok' as Level, next: 0 };
  // Blocked until 04:00: worked time may shrink later (late lock events, a re-resolved inactivity credit) — the block
  // holds unless the config changed since it started.
  const latched = input.blockedTodayUnderConfig !== null && input.blockedTodayUnderConfig === input.configHash;
  const level: Level = latched || input.forfeited === true ? 'blocked' : ladder.level;
  const next = level === 'blocked' ? null : ladder.next;
  return {
    ...base,
    dayPolicy,
    enforcing: true,
    limitSeconds: limit.limitSeconds,
    referenceSeconds: limit.referenceSeconds,
    remainingSeconds: Math.max(0, limit.limitSeconds - worked),
    level,
    nextLevelAtSeconds: next,
    blockActive: level === 'blocked' && grant === null,
    zeroLimit: limit.limitSeconds === 0,
    tokensLeft: left,
    colour,
  };
}

/** Validation of a token use (UI and API must call this): only while the block is up, only an unused token. */
export function canUseToken(state: PolicyState, minutes: number): boolean {
  return state.enforcing && state.level === 'blocked' && state.tokensLeft.includes(minutes);
}

/** Emergency bypass (R-POL-4): only while blocked; repeatable. */
export function canBypass(state: PolicyState): boolean {
  return state.enforcing && state.level === 'blocked';
}
