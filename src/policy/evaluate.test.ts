process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ownersPolicy from '../../config/policy.ts';
import { canBypass, canUseToken, evaluate, grantUntil, ladderLevel, LEVELS, thresholds, type GrantRecord, type Level, type PolicyInput } from './evaluate.ts';
import type { PolicyConfig } from './config.ts';
import { dayEnd, dayStart, WEEKDAYS } from '../core/time.ts';
import { local } from '../testing/tmp.ts';

const H = 3600;
const M = 60;
const SUN = '2026-10-04';
const THU = '2026-10-08';
const at = (day: string, h: number, m = 0) => dayStart(day) + ((h - 4) * 60 + m) * 60_000;

function input(o: Partial<PolicyInput> = {}): PolicyInput {
  return {
    config: ownersPolicy, now: at(SUN, 18), day: SUN, workedTodaySeconds: 0, workedEarlierThisWeekSeconds: 0, grants: [],
    activeToday: true, blockedTodayUnderConfig: null, configHash: 'h1', ...o,
  };
}

test('every weekday: office/home budgets enforce; both personal days stay neutral (R-POL-2)', () => {
  const days = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'];
  const got = days.map((d, i) => {
    const s = evaluate(input({ day: d, now: at(d, 18), workedTodaySeconds: 7 * H }));
    return [WEEKDAYS[i], s.enforcing, s.colour, s.limitSeconds];
  });
  assert.deepEqual(got, [
    ['sun', true, 'orange', 8.5 * H], ['mon', true, 'orange', 8 * H], ['tue', true, 'orange', 8.5 * H], ['wed', true, 'orange', 8 * H],
    ['thu', true, 'orange', 8.5 * H], ['fri', false, 'grey', null], ['sat', false, 'grey', null],
  ]);
  // Non-enforcing days never leave 'ok', whatever the worked time.
  for (const day of days.slice(5)) assert.equal(evaluate(input({ day, workedTodaySeconds: 15 * H })).level, 'ok');
});

test('office and home ladders: every transition exactly at its threshold', () => {
  for (const [day, budget] of [[SUN, 8.5 * H], ['2026-10-05', 8 * H]] as const) {
    const rows: [number, Level][] = [
      [0, 'ok'], [budget * 0.75 - 1, 'ok'], [budget * 0.75, 'orange'], [budget - 30 * M - 1, 'orange'], [budget - 30 * M, 'warn'],
      [budget - 10 * M - 1, 'warn'], [budget - 10 * M, 'countdown'], [budget - 1, 'countdown'], [budget, 'blocked'], [12 * H, 'blocked'],
    ];
    for (const [worked, level] of rows) assert.equal(evaluate(input({ day, now: at(day, 18), workedTodaySeconds: worked })).level, level, `${day}: worked ${worked}`);
    // Every level appears, in order.
    assert.deepEqual([...new Set(rows.map(([, l]) => l))], [...LEVELS]);
    assert.equal(evaluate(input({ day, now: at(day, 18), workedTodaySeconds: 7 * H })).nextLevelAtSeconds, budget - 30 * M);
    assert.equal(evaluate(input({ day, now: at(day, 18), workedTodaySeconds: budget })).nextLevelAtSeconds, null);
  }
});

test('thresholds are clamped to [0, limit]; the highest qualifying level wins (short effective limit)', () => {
  assert.deepEqual(thresholds(ownersPolicy, 20 * M), { orange: 15 * M, warn: 0, countdown: 10 * M, blocked: 20 * M });
  assert.equal(ladderLevel(ownersPolicy, 20 * M, 0).level, 'warn', 'warn beats orange at 0 worked');
  assert.equal(ladderLevel(ownersPolicy, 20 * M, 10 * M).level, 'countdown');
  assert.equal(ladderLevel(ownersPolicy, 20 * M, 20 * M).level, 'blocked');
});

test('week overrun shortens Thursday; a limit of 0 blocks only after the first worked second (Q-3)', () => {
  const s = evaluate(input({ day: THU, now: at(THU, 9), workedEarlierThisWeekSeconds: 40 * H, workedTodaySeconds: 3 * H }));
  assert.equal(s.limitSeconds, 4 * H);
  assert.equal(s.level, 'orange'); // 3 h = 75 % of 4 h; warn would start at 3:30
  const zero = evaluate(input({ day: THU, now: at(THU, 9), workedEarlierThisWeekSeconds: 44 * H, workedTodaySeconds: 0 }));
  assert.deepEqual([zero.limitSeconds, zero.level, zero.zeroLimit, zero.blockActive], [0, 'ok', true, false]);
  const one = evaluate(input({ day: THU, now: at(THU, 9), workedEarlierThisWeekSeconds: 50 * H, workedTodaySeconds: 1 }));
  assert.deepEqual([one.level, one.blockActive], ['blocked', true]);
});

test('postpone tokens: 1×10 + 2×5 per day; each slot once; unknown sizes consume nothing (R-POL-3)', () => {
  const g = (minutes: number, ts: number): GrantRecord => ({ type: 'token.used', ts, minutes, until: ts + minutes * 60_000 });
  const t0 = at(SUN, 18);
  const states = [[], [g(10, t0)], [g(10, t0), g(5, t0 + 1)], [g(10, t0), g(5, t0 + 1), g(5, t0 + 2)], [g(7, t0)]].map((grants) =>
    evaluate(input({ workedTodaySeconds: 10 * H, grants, now: t0 + 60 * 60_000 })).tokensLeft);
  assert.deepEqual(states, [[10, 5, 5], [5, 5], [5], [], [10, 5, 5]]);
});

test('grants compose (max(until, now) + minutes), lift the block while active, and the block returns at expiry (R-POL-3a)', () => {
  const t0 = at(SUN, 18);
  const u1 = grantUntil(null, t0, 10);
  const u2 = grantUntil(u1, t0 + 5 * 60_000, 30); // bypass during a token
  assert.equal(u1, t0 + 10 * 60_000);
  assert.equal(u2, t0 + 40 * 60_000);
  const grants: GrantRecord[] = [
    { type: 'token.used', ts: t0, minutes: 10, until: u1 },
    { type: 'bypass.used', ts: t0 + 5 * 60_000, minutes: 30, until: u2 },
  ];
  const during = evaluate(input({ workedTodaySeconds: 9.5 * H, grants, now: t0 + 39 * 60_000 }));
  assert.deepEqual([during.level, during.blockActive, during.grant?.until, during.bypassesUsed, during.tokensUsed], ['blocked', false, u2, 1, 1]);
  const after = evaluate(input({ workedTodaySeconds: 9.6 * H, grants, now: u2 }));
  assert.deepEqual([after.blockActive, after.grant], [true, null]);
});

test('grants are clipped to the next 04:00 — also on the 25 h fall-back day', () => {
  const sat = '2026-10-24'; // 25 h day (DST ends Sun 02:00)
  const lateNight = dayEnd(sat) - 10 * 60_000;
  assert.equal(grantUntil(null, lateNight, 30), dayEnd(sat));
  assert.equal(dayEnd(sat), local(2026, 10, 25, 4, 0));
  assert.equal(dayEnd(sat) - dayStart(sat), 25 * H * 1000);
});

test('an inactivity credit that pushes worked time over the limit blocks (worked time is the only input)', () => {
  const before = evaluate(input({ workedTodaySeconds: 8.4 * H }));
  const credited = evaluate(input({ workedTodaySeconds: 8.4 * H + 30 * M }));
  assert.deepEqual([before.level, credited.level, credited.blockActive], ['countdown', 'blocked', true]);
});

test('the evaluator is pure: the same data gives the same state (what a restart relies on)', () => {
  const t0 = at(SUN, 20);
  const grants: GrantRecord[] = [{ type: 'token.used', ts: t0, minutes: 5, until: t0 + 5 * 60_000 }];
  const a = evaluate(input({ workedTodaySeconds: 9.2 * H, grants, now: t0 + 60_000 }));
  const b = evaluate(input({ workedTodaySeconds: 9.2 * H, grants: [...grants], now: t0 + 60_000 }));
  assert.deepEqual(a, b);
  assert.equal(a.blockActive, false);
});

test('a config change mid-day takes effect immediately (e.g. daily budget 8.5 h → 10 h unblocks)', () => {
  const tenHours: PolicyConfig = { ...ownersPolicy, days: { ...ownersPolicy.days, sun: { ...ownersPolicy.days.sun, dailyBudgetMin: 600 } } };
  assert.equal(evaluate(input({ workedTodaySeconds: 9.2 * H })).level, 'blocked');
  assert.equal(evaluate(input({ workedTodaySeconds: 9.2 * H, config: tenHours })).level, 'orange'); // warn would start at 9:30
});

test('tokens and bypass are usable only while blocked; not on non-enforcing days; not without a config', () => {
  const blocked = evaluate(input({ workedTodaySeconds: 9 * H }));
  const countdown = evaluate(input({ workedTodaySeconds: 8.4 * H }));
  assert.deepEqual([canUseToken(blocked, 10), canUseToken(blocked, 7), canBypass(blocked)], [true, false, true]);
  assert.deepEqual([canUseToken(countdown, 10), canBypass(countdown)], [false, false]);
  const friday = evaluate(input({ day: '2026-10-09', workedTodaySeconds: 20 * H }));
  assert.deepEqual([friday.enforcing, canBypass(friday)], [false, false]);
  const none = evaluate(input({ config: null, workedTodaySeconds: 20 * H }));
  assert.deepEqual([none.enforcing, none.level, none.blockActive, none.dayPolicy], [false, 'ok', false, null]);
});

test('review M6#1/#7: no level above ok before the first real activity of the day (nobody is blocked at 04:00 asleep)', () => {
  const carried = { day: THU, now: at(THU, 4, 1), workedEarlierThisWeekSeconds: 44 * H, workedTodaySeconds: 30 };
  assert.equal(evaluate(input({ ...carried, activeToday: false })).level, 'ok');
  assert.equal(evaluate(input({ ...carried, activeToday: true })).level, 'blocked');
  const small = { day: THU, now: at(THU, 4, 1), workedEarlierThisWeekSeconds: 44 * H - 5 * M, workedTodaySeconds: 0 };
  assert.equal(evaluate(input({ ...small, activeToday: false })).level, 'ok');
  assert.equal(evaluate(input({ ...small, activeToday: true })).level, 'countdown');
  // Float leftovers are floored: a "3e-9" limit is a 0 limit.
  const z = evaluate(input({ day: THU, workedEarlierThisWeekSeconds: 44 * H - 3e-9, workedTodaySeconds: 0 }));
  assert.deepEqual([z.limitSeconds, z.zeroLimit], [0, true]);
});

test('review M6#2: nextLevelAtSeconds is always the next HIGHER level', () => {
  assert.equal(ladderLevel(ownersPolicy, 20 * M, 12 * M).next, 20 * M); // countdown → blocked (not orange at 15 min)
  assert.equal(ladderLevel(ownersPolicy, 90 * M, 62 * M).next, 80 * M); // warn → countdown
  assert.equal(ladderLevel(ownersPolicy, 9 * H, 0).next, 6.75 * H);
});

test('review M6#3: a block lasts until 04:00 even if worked time shrinks — unless the config changed', () => {
  assert.equal(evaluate(input({ workedTodaySeconds: 8 * H, blockedTodayUnderConfig: 'h1', configHash: 'h1' })).level, 'blocked');
  assert.equal(evaluate(input({ workedTodaySeconds: 8 * H, blockedTodayUnderConfig: 'h1', configHash: 'h2' })).level, 'warn');
});

test('review M6#5/#6/#8: budget as reference on a non-enforcing day; corrupt or foreign grants are clipped/ignored; Saturday never enforces', () => {
  const sunOff: PolicyConfig = { ...ownersPolicy, days: { ...ownersPolicy.days, sun: { ...ownersPolicy.days.sun, enforce: false } } };
  const off = evaluate(input({ config: sunOff, workedTodaySeconds: 9.5 * H }));
  assert.deepEqual([off.enforcing, off.referenceSeconds, off.colour], [false, 8.5 * H, 'red']);
  const t0 = at(SUN, 18);
  const corrupt = evaluate(input({ workedTodaySeconds: 10 * H, now: t0 + 60_000, grants: [{ type: 'token.used', ts: t0, minutes: 10, until: 9e15 }] }));
  assert.equal(corrupt.grant?.until, dayEnd(SUN));
  const yesterday = evaluate(input({ workedTodaySeconds: 10 * H, now: t0, grants: [{ type: 'bypass.used', ts: t0 - 24 * 3600_000, minutes: 30, until: t0 + 3600_000 }] }));
  assert.deepEqual([yesterday.grant, yesterday.blockActive, yesterday.bypassesUsed], [null, true, 0]);
  const satOn = { ...ownersPolicy, days: { ...ownersPolicy.days, sat: { ...ownersPolicy.days.sun } } } as PolicyConfig;
  const sat = evaluate(input({ config: satOn, day: '2026-10-10', now: at('2026-10-10', 18), workedTodaySeconds: 12 * H }));
  assert.deepEqual([sat.enforcing, sat.blockActive, sat.dayPolicy?.inactivityDialog], [false, false, false]);
  // A grant used just after 04:00 belongs to the new day (its own day end), never to the previous one.
  assert.equal(grantUntil(null, dayEnd(SUN) + 1000, 10), dayEnd(SUN) + 1000 + 600_000);
});
