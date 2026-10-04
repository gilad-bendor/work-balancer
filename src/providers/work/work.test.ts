process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkProvider, type WorkSource } from './index.ts';
import type { Interval } from '../../core/intervals.ts';
import { dayStart } from '../../core/time.ts';
import { local } from '../../testing/tmp.ts';

const S = 1000;
const MIN = 60 * S;
const G = 5 * MIN;

function provider(o: { runs?: Interval[]; blocked?: Interval[]; credited?: Interval[]; now: number }) {
  let now = o.now;
  const source: WorkSource = {
    name: 'test',
    activity: (from, to) => (o.runs ?? []).filter(([a, b]) => b >= from && a < to),
    blocked: () => o.blocked ?? [],
    credited: () => o.credited ?? [],
    version: () => 1,
  };
  const p = createWorkProvider({ sources: () => [source], graceMs: () => G, now: () => now });
  return { p, setNow: (t: number) => { now = t; } };
}

const T = local(2026, 10, 4, 10, 0); // Sunday 10:00

test('one input instant = 5 minutes of work; overlapping grace windows do not double count', () => {
  const { p } = provider({ runs: [[T, T], [T + 2 * MIN, T + 2 * MIN]], now: T + 60 * MIN });
  assert.deepEqual(p.busy(T - MIN, T + 60 * MIN), [[T, T + 7 * MIN]]);
  assert.equal(p.getRangeInfo(T, T + 60 * MIN)!.workedSeconds, 7 * 60);
});

test('a continuous run [a, b] is busy until b + grace; separate windows give breaks and a longest stretch', () => {
  const { p } = provider({ runs: [[T, T + 20 * MIN], [T + 40 * MIN, T + 41 * MIN]], now: T + 2 * 60 * MIN });
  const r = p.getRangeInfo(T, T + 2 * 60 * MIN)!;
  assert.equal(r.workedSeconds, (25 + 6) * 60);
  assert.equal(r.longestStretchSeconds, 25 * 60);
  assert.equal(r.breaks, 1);
  assert.equal(r.firstActivityAt, T);
  assert.equal(r.lastActivityAt, T + 41 * MIN);
});

test('screen lock cuts the grace window short; unlock does not resume it without new input', () => {
  const { p } = provider({ runs: [[T, T]], blocked: [[T + 2 * MIN, T + 3 * MIN]], now: T + 60 * MIN });
  assert.deepEqual(p.busy(T, T + 60 * MIN), [[T, T + 2 * MIN], [T + 3 * MIN, T + 5 * MIN]]);
});

test('credited intervals count even while locked (inactivity "whole" resolution, R-UI-INACT)', () => {
  const { p } = provider({ runs: [[T, T]], blocked: [[T + 2 * MIN, T + 30 * MIN]], credited: [[T, T + 30 * MIN]], now: T + 60 * MIN });
  assert.equal(p.getRangeInfo(T, T + 60 * MIN)!.workedSeconds, 30 * 60);
});

test('minute projection: workSeconds per minute at second precision', () => {
  const { p } = provider({ runs: [[T + 30 * S, T + 30 * S]], now: T + 60 * MIN });
  assert.equal(p.getMinuteInfo(T)!.workSeconds, 30);
  assert.equal(p.getMinuteInfo(T + MIN)!.workSeconds, 60);
  assert.equal(p.getMinuteInfo(T + 5 * MIN)!.workSeconds, 30);
  assert.equal(p.getMinuteInfo(T + 6 * MIN)!.workSeconds, 0);
});

test('sleep across a minute boundary is subtracted at second precision', () => {
  const { p } = provider({ runs: [[T, T]], blocked: [[T + MIN + 40 * S, T + 3 * MIN + 10 * S]], now: T + 60 * MIN });
  assert.equal(p.getMinuteInfo(T + MIN)!.workSeconds, 40);
  assert.equal(p.getMinuteInfo(T + 2 * MIN)!.workSeconds, 0);
  assert.equal(p.getMinuteInfo(T + 3 * MIN)!.workSeconds, 50);
});

test('a grace window crossing 04:00 is split between the two days', () => {
  const t = local(2026, 10, 5, 3, 58); // Monday 03:58 → Sunday's day
  const { p } = provider({ runs: [[t, t]], now: local(2026, 10, 5, 12, 0) });
  assert.equal(p.daySeconds('2026-10-04'), 2 * 60);
  assert.equal(p.daySeconds('2026-10-05'), 3 * 60);
  assert.equal(dayStart('2026-10-05'), local(2026, 10, 5, 4, 0));
});

test('busy never counts the future: clipped to now; current stretch', () => {
  const { p, setNow } = provider({ runs: [[T, T + 10 * MIN]], now: T + 12 * MIN });
  assert.equal(p.daySeconds('2026-10-04'), 12 * 60);
  assert.deepEqual(p.currentStretch(), { from: T, seconds: 12 * 60 });
  setNow(T + 20 * MIN);
  assert.equal(p.daySeconds('2026-10-04'), 15 * 60);
  assert.equal(p.currentStretch(), null);
});
