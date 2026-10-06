import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportPeriods, reportWorkSource, withoutReportWork } from './work.ts';
import type { AnyRecord } from '../store/records.ts';
import type { WorkSource } from '../providers/work/index.ts';

const audit = (type: string, ts: number, windowId = 'review:fresh'): AnyRecord => ({ v: 1, type, ts, windowId });

test('mandatory-report periods include involuntary closes, ignore ordinary reviews and duplicate reports', () => {
  const records = [
    audit('effect.shown', 5, 'review'),
    audit('effect.closed', 8, 'review'),
    audit('effect.closed', 9),
    audit('effect.shown', 10), audit('effect.shown', 12),
    audit('effect.closed', 20), audit('effect.closed', 21),
    audit('effect.shown', 30),
  ];
  assert.deepEqual(reportPeriods(records, 40), [[10, 20], [30, 40]]);
  assert.deepEqual(reportWorkSource(() => reportPeriods(records, 40), () => 3).blocked!(15, 35), [[15, 20], [30, 35]]);
});

test('mandatory-report input subtraction preserves closed runs and boundary instants', () => {
  const source: WorkSource = {
    name: 'synthetic', version: () => 2,
    activity: () => [[5, 25], [30, 30], [40, 40]],
    blocked: () => [[0, 1]],
    credited: () => [[0, 50]],
  };
  const filtered = withoutReportWork(source, () => [[10, 20], [30, 40]], () => 3);
  assert.deepEqual(filtered.activity!(0, 50), [[5, 9], [20, 25], [40, 40]]);
  assert.equal(filtered.version(), 5);
  assert.deepEqual(filtered.blocked!(0, 50), [[0, 1]]);
  assert.deepEqual(filtered.credited!(0, 50), [[0, 10], [20, 30], [40, 50]]);
  assert.equal(withoutReportWork({ name: 'credits', version: () => 0 }, () => [], () => 0).activity, undefined);
});

test('lifecycle timestamps preserve rapid completion and continuous coverage bounds delayed closes', () => {
  const quick = [
    { ...audit('effect.shown', 5000), at: 0 },
    { ...audit('effect.closed', 5000), at: 3500 },
  ];
  assert.deepEqual(reportPeriods(quick, 6000, () => 6000), [[0, 3500]]);
  const delayed = [audit('effect.shown', 0), audit('effect.closed', 12_000)];
  assert.deepEqual(reportPeriods(delayed, 12_000, () => 4000), [[0, 4000]], 'returning coverage must not erase work done during an outage');
  assert.deepEqual(reportPeriods([
    ...delayed, { v: 1, ts: 12_000, type: 'monitor.gap', from: 3500, to: 11_000 },
  ], 12_000, () => 4000), [[0, 3500]], 'exact gap evidence also clips rounded historical minute coverage');
});
