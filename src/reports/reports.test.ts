process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { catchUpTimestamp, createReports, formatTimestamp, isSkipReport, stageAt, timestampDay, validReportDay } from './reports.ts';
import { createStore } from '../store/store.ts';
import { fixedClock } from '../core/clock.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';
import owner from '../../config/policy.ts';
import type { PolicyConfig } from '../policy/config.ts';

const STAGES = { afternoonFrom: '11:00', eveningFrom: '14:00', endOfWorkdayAt: '23:59' };
const STATUSES = ['Too much work', 'Feeling tired', 'Productive'];
const policy = (startDay: string | null = '2026-10-04', stubDays = 10): PolicyConfig =>
  ({ ...owner, reports: { startDay, statuses: STATUSES, stages: STAGES, listMax: 1000, stubDays } });

function setup(now: number, config: () => PolicyConfig | null = () => policy()) {
  const tmp = makeTmpDir('reports');
  const clock = fixedClock(now);
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  const make = () => createReports({ store, config });
  return { ...tmp, clock, store, make, config };
}

test('timestamps: local "YYYY-MM-DD HH:MM"; the 04:00 boundary decides the day', () => {
  assert.equal(formatTimestamp(local(2026, 10, 7, 17, 22, 59)), '2026-10-07 17:22');
  assert.equal(formatTimestamp(local(2026, 10, 8, 1, 5)), '2026-10-08 01:05');
  assert.equal(timestampDay('2026-10-08 01:30'), '2026-10-07');
  assert.equal(timestampDay('2026-10-08 04:00'), '2026-10-08');
  assert.equal(timestampDay('2026-11-01 03:59'), '2026-10-31');
  for (const bad of ['2026-10-08', '2026-02-30 10:00', '2026-10-08 24:00', '2026-10-08T10:00', 7]) assert.equal(timestampDay(bad), null, String(bad));
  assert.equal(validReportDay('2026-02-30'), false);
});

test('stage by time of day: morning from 04:00, afternoon from 11:00, evening from 14:00 to the next 04:00', () => {
  const at = (hhmm: string) => stageAt(`2026-10-07 ${hhmm}`, STAGES);
  assert.deepEqual(['04:00', '10:59', '11:00', '13:59', '14:00', '23:59', '00:00', '03:59'].map(at),
    ['morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'evening', 'evening']);
});

test('catch-up timestamp: the middle of the stage, end of workday at its configured time (maybe past midnight)', () => {
  const day = '2026-10-07';
  assert.equal(catchUpTimestamp(day, 'morning', STAGES), '2026-10-07 07:30');
  assert.equal(catchUpTimestamp(day, 'afternoon', STAGES), '2026-10-07 12:30');
  assert.equal(catchUpTimestamp(day, 'evening', STAGES), '2026-10-07 21:00');
  assert.equal(catchUpTimestamp(day, 'end-of-workday', STAGES), '2026-10-07 23:59');
  assert.equal(catchUpTimestamp(day, 'end-of-workday', { ...STAGES, endOfWorkdayAt: '01:00' }), '2026-10-08 01:00');
  assert.equal(catchUpTimestamp('2026-10-31', 'evening', { ...STAGES, eveningFrom: '20:00' }), '2026-11-01 00:00');
  for (const stage of ['morning', 'afternoon', 'evening', 'end-of-workday'] as const) {
    assert.equal(timestampDay(catchUpTimestamp(day, stage, { ...STAGES, endOfWorkdayAt: '02:00' })), day, stage);
  }
});

test('missing days: the last stubDays days from startDay; a skip covers a day, a dismissed report does not; DST-safe age', (t) => {
  const s = setup(local(2026, 10, 11, 9, 0), () => policy('2026-10-08', 10));
  t.after(s.cleanup);
  const r = s.make();
  assert.deepEqual(r.missing(s.clock.now()).map((x) => [x.day, x.weekday, x.daysAgo]), [
    ['2026-10-11', 'sun', 0], ['2026-10-10', 'sat', 1], ['2026-10-09', 'fri', 2], ['2026-10-08', 'thu', 3],
  ]);
  assert.equal(r.freshDue(s.clock.now()), true);
  const short = setup(local(2026, 10, 11, 9, 0), () => policy('2026-10-01', 2));
  t.after(short.cleanup);
  assert.deepEqual(short.make().missing(short.clock.now()).map((x) => x.day), ['2026-10-11', '2026-10-10']);
  const off = setup(local(2026, 10, 11, 9, 0), () => policy(null));
  t.after(off.cleanup);
  assert.deepEqual(off.make().missing(off.clock.now()), []);
  const dst = setup(local(2026, 10, 25, 9, 0), () => policy('2026-10-23'));
  t.after(dst.cleanup);
  assert.deepEqual(dst.make().missing(dst.clock.now()).map((x) => [x.day, x.daysAgo]), [['2026-10-25', 0], ['2026-10-24', 1], ['2026-10-23', 2]]);

  const added = r.action('report-add', { day: '2026-10-10', stage: 'evening', energy: 3 }, s.clock.now(), { source: 'manager' });
  assert.equal(added.ok, true);
  assert.equal(r.freshDue(s.clock.now()), false);
  assert.equal(r.action('report-dismiss', { id: added.id }, s.clock.now(), { source: 'manager' }).ok, true);
  assert.equal(r.freshDue(s.clock.now()), true, 'a dismissed report does not count');
  assert.deepEqual(r.list(), []);
  assert.equal(r.action('report-undismiss', { id: added.id }, s.clock.now(), { source: 'manager' }).ok, true);
  assert.equal(r.freshDue(s.clock.now()), false);
});

test('new / add: at least one field; statuses only from the config; stage by time or picked; ids = creation time', (t) => {
  const T = local(2026, 10, 8, 1, 30); // Thursday 01:30 → Wednesday's day, evening
  const s = setup(T);
  t.after(s.cleanup);
  const r = s.make();
  const src = { source: 'manager' as const };
  assert.equal(r.action('report-new', { status: ['Other'], feedback: '  ' }, T, src).error, 'empty');
  assert.equal(r.action('report-new', { energy: 6 }, T, src).error, 'empty');
  const n = r.action('report-new', { status: ['Productive', 'Productive', 'Other', 7], energy: 4, feedback: ' fine \r\n' }, T, src);
  assert.equal(n.ok, true);
  assert.equal(n.id, T);
  const created = r.get(T)!;
  assert.deepEqual([created.timestamp, created.day, created.stage, created.status, created.energy, created.feedback],
    ['2026-10-08 01:30', '2026-10-07', 'evening', ['Productive'], 4, 'fine']);
  assert.equal(r.action('report-add', { day: '2026-10-06', energy: 2 }, T, src).error, 'stage');
  assert.equal(r.action('report-add', { day: '2026-10-07', stage: 'morning', energy: 2 }, T, src).error, 'day', 'not a missing day');
  assert.equal(r.action('report-add', { day: '2026-10-03', stage: 'morning', energy: 2 }, T, src).error, 'day', 'before startDay');
  assert.equal(r.action('report-add', { day: '2026-10-06', stage: 'morning' }, T, src).error, 'empty');
  assert.equal(r.action('report-add', { day: '2026-10-07', stage: 'evening', energy: 1 }, local(2026, 10, 7, 9, 0), src).error, 'day', 'today: report-new, not a stage still ahead');
  const a = r.action('report-add', { day: '2026-10-06', stage: 'morning', feedback: 'slow start' }, T, src);
  assert.equal(a.id, T + 1, 'same millisecond: the next free id');
  assert.deepEqual([r.get(T + 1)!.timestamp, r.get(T + 1)!.stage], ['2026-10-06 07:30', 'morning']);
  // Both go to the current day's file (actions about an entity), whatever day they describe.
  const lines = s.store.readDay('2026-10-07');
  assert.deepEqual(lines.map((x) => [x.type, x.reportId, x.timestamp]), [['report.created', T, '2026-10-08 01:30'], ['report.created', T + 1, '2026-10-06 07:30']]);
  assert.deepEqual(Object.keys(lines[0]!).sort(), ['energy', 'feedback', 'reportId', 'source', 'stage', 'status', 'timestamp', 'ts', 'type', 'v']);
  assert.deepEqual(r.list().map((x) => x.id), [T, T + 1], 'newest first by the time described');
});

test('skip = a report with all fields empty, after a two-step confirmation; it can be edited into a real report', (t) => {
  const s = setup(local(2026, 10, 11, 9, 0), () => policy('2026-10-08'));
  t.after(s.cleanup);
  const r = s.make();
  const src = { source: 'review' as const };
  const day = '2026-10-10';
  assert.equal(r.action('report-skip', { day, nonce: 'made-up' }, s.clock.now(), src).error, 'confirmation');
  const armed = r.action('report-arm-skip', { day }, s.clock.now(), src);
  assert.equal(armed.delayMs, 800);
  assert.equal(r.action('report-skip', { day, nonce: armed.nonce }, s.clock.now(), src).ok, false, 'too fast');
  s.clock.advance(800);
  const skipped = r.action('report-skip', { day, nonce: armed.nonce }, s.clock.now(), src);
  assert.equal(skipped.ok, true);
  const x = r.get(skipped.id as number)!;
  assert.equal(isSkipReport(x), true);
  assert.deepEqual([x.timestamp, x.stage, x.day], ['2026-10-10 23:59', null, day]);
  assert.equal(r.freshDue(s.clock.now()), false);
  assert.equal(r.action('report-arm-skip', { day }, s.clock.now(), src).error, 'day', 'no longer missing');
  assert.equal(r.action('report-edit', { id: x.id }, s.clock.now(), src).error, 'empty');
  assert.equal(r.action('report-edit', { id: x.id, energy: 3 }, s.clock.now(), src).ok, true);
  assert.equal(isSkipReport(r.get(x.id)!), false);
  // Older days: no delay; a restart cancels a confirmation; it expires after 60 s; `days` limits the target.
  const old = r.action('report-arm-skip', { day: '2026-10-09' }, s.clock.now(), src);
  assert.equal(old.delayMs, 0);
  assert.equal(s.make().action('report-skip', { day: '2026-10-09', nonce: old.nonce }, s.clock.now(), src).ok, false);
  s.clock.advance(60_001);
  assert.equal(r.action('report-skip', { day: '2026-10-09', nonce: old.nonce }, s.clock.now(), src).error, 'confirmation');
  assert.equal(r.action('report-arm-skip', { day: '2026-10-09' }, s.clock.now(), { ...src, days: (d) => d === day }).error, 'day');
  // A restart folds the same state.
  assert.deepEqual(s.make().list(), r.list());
});

test('edit / dismiss: idempotent, logged once; dismissed reports cannot be edited; end-of-workday from countdown/block', (t) => {
  const T = local(2026, 10, 8, 18, 0);
  const s = setup(T);
  t.after(s.cleanup);
  const r = s.make();
  const src = { source: 'manager' as const };
  const e = r.createEndOfWorkday({ status: ['Feeling tired'], energy: 2 }, 'countdown', T);
  assert.ok(e.ok);
  assert.deepEqual([e.report.stage, e.report.timestamp, e.report.source], ['end-of-workday', '2026-10-08 18:00', 'countdown']);
  assert.deepEqual(r.createEndOfWorkday({}, 'block', T), { ok: false, error: 'empty' });
  const id = e.report.id;
  assert.equal(r.action('report-edit', { id, status: ['Feeling tired'], energy: 2 }, T, src).ok, true, 'unchanged: no record');
  assert.equal(r.action('report-edit', { id, status: ['Too much work'], energy: 2, feedback: 'long' }, T, src).ok, true);
  assert.equal(r.action('report-edit', { id: 1, energy: 2 }, T, src).error, 'unknown');
  assert.equal(r.action('report-dismiss', { id }, T, src).ok, true);
  assert.equal(r.action('report-dismiss', { id }, T, src).ok, true);
  assert.equal(r.action('report-edit', { id, energy: 5 }, T, src).error, 'unknown');
  assert.deepEqual(s.store.readDay('2026-10-08').map((x) => x.type), ['report.created', 'report.edited', 'report.dismissed']);
  assert.deepEqual(s.store.readDay('2026-10-08')[1]!.status, ['Too much work']);
  assert.equal(r.action('nope', {}, T, src).ok, false);
});

test('failed writes leave the state unchanged', (t) => {
  const s = setup(local(2026, 10, 6, 18, 0));
  t.after(s.cleanup);
  const reports = createReports({ store: { ...s.store, append: () => null }, config: s.config });
  const src = { source: 'manager' as const };
  assert.equal(reports.action('report-new', { energy: 3 }, s.clock.now(), src).error, 'write');
  const arm = reports.action('report-arm-skip', { day: '2026-10-06' }, s.clock.now(), src);
  assert.equal(reports.action('report-skip', { day: '2026-10-06', nonce: arm.nonce }, s.clock.now() + 800, src).error, 'write');
  assert.deepEqual(reports.list(), []);
  assert.equal(reports.missing(s.clock.now())[0]!.day, '2026-10-06');
});
