process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { local } from '../testing/tmp.ts';
import { dayEnd, dayKey } from '../core/time.ts';
import type { AnyRecord } from '../store/records.ts';
import { blockedIntervals, buildSegments, categoryLayers, workTimeline } from './timeline.ts';

const MIN = 60_000;
const rec = (type: string, ts: number, extra: Record<string, unknown> = {}): AnyRecord => ({ v: 1, ts, type, ...extra });
const endOf = (ts: number): number => dayEnd(dayKey(ts));

test('buildSegments: precedence, base fill, merging, clipping', () => {
  const segs = buildSegments(0, 100, [
    { state: 'A', intervals: [[10, 20], [20, 30], [90, 150]] },
    { state: 'B', intervals: [[-50, 15], [25, 40], [60, 70]] },
  ], 'X');
  assert.deepEqual(segs, [
    { from: 0, to: 10, state: 'B' },
    { from: 10, to: 30, state: 'A' },
    { from: 30, to: 40, state: 'B' },
    { from: 40, to: 60, state: 'X' },
    { from: 60, to: 70, state: 'B' },
    { from: 70, to: 90, state: 'X' },
    { from: 90, to: 100, state: 'A' },
  ]);
  assert.deepEqual(buildSegments(0, 10, [], 'X'), [{ from: 0, to: 10, state: 'X' }]);
  assert.deepEqual(buildSegments(10, 10, [], 'X'), []);
});

test('blockedIntervals: until the next transition out, at most until 04:00, minus grants (minutes of work, D-86)', () => {
  const t = local(2026, 10, 18, 15, 0);
  const busy = [[t, t + 6 * 60 * MIN]] as const; // working non-stop
  const records = [
    rec('policy.transition', t, { from: 'countdown', to: 'blocked' }),
    rec('token.used', t + 30 * MIN, { minutes: 10, until: t + 40 * MIN }),
    rec('policy.transition', t + 60 * MIN, { from: 'blocked', to: 'blocked' }),
    // A config edit released the block, then it came back.
    rec('policy.transition', t + 120 * MIN, { from: 'blocked', to: 'ok' }),
    rec('policy.transition', t + 180 * MIN, { from: 'ok', to: 'blocked' }),
  ];
  assert.deepEqual(blockedIntervals(records, endOf, busy), [
    [t, t + 30 * MIN], [t + 40 * MIN, t + 120 * MIN], [t + 180 * MIN, local(2026, 10, 19, 4, 0)],
  ]);
  // Away for 20 min after 2 min of the token: it lasts until 8 more minutes of work are done.
  const away = [[t, t + 32 * MIN], [t + 52 * MIN, t + 6 * 60 * MIN]] as const;
  assert.deepEqual(blockedIntervals(records.slice(0, 2), endOf, away), [[t, t + 30 * MIN], [t + 60 * MIN, local(2026, 10, 19, 4, 0)]]);
  // A block without a later record ends at its day's 04:00, not at the next day's records.
  const next = local(2026, 10, 19, 10, 0);
  assert.deepEqual(blockedIntervals([rec('policy.transition', t, { to: 'blocked' }), rec('policy.transition', next, { from: 'ok', to: 'orange' })], endOf, busy),
    [[t, local(2026, 10, 19, 4, 0)]]);
  assert.deepEqual(blockedIntervals([], endOf, busy), []);
  // Borrowed time ended early (D-85): blocked again from that moment.
  assert.deepEqual(blockedIntervals([
    rec('policy.transition', t, { to: 'blocked' }),
    rec('bypass.used', t + 10 * MIN, { minutes: 30, until: t + 40 * MIN }),
    rec('grant.ended', t + 15 * MIN, { until: t + 40 * MIN }),
  ], endOf, busy), [[t, t + 10 * MIN], [t + 15 * MIN, local(2026, 10, 19, 4, 0)]]);
});

test('workTimeline: Future > Active > Blocked > Inactive; styles in order; optional mark', () => {
  const from = local(2026, 10, 18, 4, 0);
  const to = local(2026, 10, 19, 4, 0);
  const now = local(2026, 10, 18, 20, 0);
  const style = (s: string) => ({ color: '#000', thickness: 3, label: s });
  const v = workTimeline({
    from, to, now,
    active: [[local(2026, 10, 18, 9, 0), local(2026, 10, 18, 17, 30)]],
    blocked: [[local(2026, 10, 18, 17, 0), to]],
    style, markMs: 8.5 * 60 * MIN,
  });
  assert.deepEqual(v.segments.map((s) => s.state), ['Inactive', 'Active', 'Blocked', 'Future']);
  assert.equal(v.segments[2]!.from, local(2026, 10, 18, 17, 30));
  assert.equal(v.segments[3]!.from, now);
  assert.equal(v.segments.at(-1)!.to, to);
  assert.deepEqual(v.order, ['Active', 'Inactive', 'Blocked', 'Future']);
  assert.equal(v.styles.Blocked!.label, 'Blocked');
  assert.equal(v.markMs, 8.5 * 60 * MIN);
  assert.equal('markMs' in workTimeline({ from, to, now, active: [], blocked: [], style, markMs: null }), false);
});

test('categoryLayers: each minute shares its worked part by foreground seconds; Work and unknown minutes stay Active', () => {
  const m0 = local(2026, 10, 18, 10, 0);
  const cats: Record<number, Record<string, number>> = {
    [m0]: { WhatsApp: 60 },
    [m0 + MIN]: { Work: 45, WhatsApp: 15 },
    [m0 + 2 * MIN]: { Work: 20, Zoom: 20, WhatsApp: 20, Blocked: 99, Bad: -3 },
    // m0 + 3 min: no record
  };
  // Worked: the first 2 minutes, the 3rd only [0, 30 s), the 4th (no categories) whole.
  const active = [[m0, m0 + 2 * MIN + 30_000], [m0 + 3 * MIN, m0 + 4 * MIN]] as const;
  const layers = categoryLayers(active, (m) => cats[m], 'Work');
  assert.deepEqual(layers.map((l) => l.state), ['WhatsApp', 'Zoom']);
  assert.deepEqual(layers[0]!.intervals, [[m0, m0 + MIN + 15_000], [m0 + 2 * MIN, m0 + 2 * MIN + 10_000]]);
  assert.deepEqual(layers[1]!.intervals, [[m0 + 2 * MIN + 10_000, m0 + 2 * MIN + 20_000]]);
  // A share spills over a gap inside the minute.
  const split = categoryLayers([[m0, m0 + 10_000], [m0 + 50_000, m0 + 60_000]], () => ({ WhatsApp: 45, Work: 15 }), 'Work');
  assert.deepEqual(split[0]!.intervals, [[m0, m0 + 10_000], [m0 + 50_000, m0 + 55_000]]);
  assert.deepEqual(categoryLayers([], () => ({ WhatsApp: 60 }), 'Work'), []);
});

test('workTimeline: categories sit inside Active, are merged by state and ordered after Active', () => {
  const from = local(2026, 10, 18, 4, 0);
  const to = local(2026, 10, 19, 4, 0);
  const a = local(2026, 10, 18, 10, 0);
  const v = workTimeline({
    from, to, now: to, active: [[a, a + 60 * MIN]], blocked: [],
    categories: [{ state: 'Zoom', intervals: [[a + 30 * MIN, a + 40 * MIN]] }, { state: 'WhatsApp', intervals: [[a, a + 5 * MIN]] }, { state: 'WhatsApp', intervals: [[a + 50 * MIN, a + 55 * MIN]] }],
    style: (s) => ({ color: '#000', thickness: 7, label: s }),
  });
  assert.deepEqual(v.order, ['Active', 'WhatsApp', 'Zoom', 'Inactive', 'Blocked', 'Future']);
  assert.deepEqual(v.segments.map((g) => [g.state, (g.to - g.from) / MIN]), [
    ['Inactive', 6 * 60], ['WhatsApp', 5], ['Active', 25], ['Zoom', 10], ['Active', 10], ['WhatsApp', 5], ['Active', 5], ['Inactive', 17 * 60],
  ]);
});
