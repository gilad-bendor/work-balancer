process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createReports, validReportDay } from './reports.ts';
import { createStore } from '../store/store.ts';
import { fixedClock } from '../core/clock.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';
import owner from '../../config/policy.ts';

test('calendar obligations include absent days, today/yesterday, Friday/Saturday; DST-safe age; activation boundary', (t) => {
  const tmp = makeTmpDir('reports');
  t.after(tmp.cleanup);
  const clock = fixedClock(local(2026, 10, 11, 9, 0));
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  const reports = createReports({ store, config: () => ({ ...owner, dailyReportsStartDay: '2026-10-08' }) });
  assert.deepEqual(reports.list(clock.now()).map((r) => [r.day, r.weekday, r.daysAgo, r.status]), [
    ['2026-10-08', 'thu', 3, 'pending'], ['2026-10-09', 'fri', 2, 'pending'],
    ['2026-10-10', 'sat', 1, 'pending'], ['2026-10-11', 'sun', 0, 'pending'],
  ]);
  assert.equal(reports.freshDue(clock.now()), true);
  assert.equal(reports.get('2026-10-07', clock.now()), null);
  assert.equal(reports.get('2026-10-12', clock.now()), null);
  assert.equal(validReportDay('2026-02-30'), false);
  assert.equal(validReportDay('2026-00-01'), false);
  const dst = createReports({ store, config: () => ({ ...owner, dailyReportsStartDay: '2026-10-24' }) });
  assert.equal(dst.get('2026-10-24', local(2026, 10, 25, 9, 0))?.daysAgo, 1);
  assert.equal(dst.get('2026-10-24', local(2026, 10, 25, 3, 59))?.daysAgo, 0);
});

test('answer requires energy, preserves target date, is idempotent and restart-proof; skips require confirmation', (t) => {
  const tmp = makeTmpDir('reports-actions');
  t.after(tmp.cleanup);
  const clock = fixedClock(local(2026, 10, 11, 9, 0));
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  const config = () => ({ ...owner, dailyReportsStartDay: '2026-10-08' });
  const reports = createReports({ store, config });
  assert.equal(reports.action('report-submit', { day: '2026-10-08', text: 'synthetic' }, clock.now()).error, 'energy');
  for (const energy of [0, 6, 2.5, '3']) assert.equal(reports.action('report-submit', { day: '2026-10-08', energy }, clock.now()).ok, false);
  const input = { day: '2026-10-08', energy: 2, choices: ['Feeling tired', 'invalid'], text: ' synthetic comment ' };
  assert.equal(reports.action('report-submit', input, clock.now()).ok, true);
  assert.equal(reports.action('report-submit', input, clock.now()).ok, true);
  assert.equal(store.readDay('2026-10-08').length, 0);
  const events = store.readDay('2026-10-11');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.day, '2026-10-08');
  assert.equal(events[0]!.ts, clock.now());
  assert.deepEqual(reports.get('2026-10-08', clock.now())?.choices, ['Feeling tired']);
  const day = '2026-10-10';
  assert.equal(reports.action('report-skip', { day, nonce: 'made-up' }, clock.now()).error, 'confirmation');
  const armed = reports.action('report-arm-skip', { day }, clock.now());
  assert.equal(armed.delayMs, 800);
  assert.equal(reports.action('report-skip', { day, nonce: armed.nonce }, clock.now()).ok, false);
  clock.advance(800);
  assert.equal(reports.action('report-skip', { day, nonce: armed.nonce }, clock.now()).ok, true);
  assert.equal(reports.freshDue(clock.now()), false);
  assert.equal(createReports({ store, config }).get(day, clock.now())?.status, 'skipped');
  assert.equal(createReports({ store, config }).get('2026-10-08', clock.now())?.energy, 2);
  assert.equal(reports.action('report-submit', { day, energy: 4 }, clock.now()).ok, true, 'a skipped date can be filled later');
  assert.equal(reports.get(day, clock.now())?.status, 'answered');
  const old = reports.action('report-arm-skip', { day: '2026-10-09' }, clock.now());
  assert.equal(old.delayMs, 0);
  assert.equal(createReports({ store, config }).action('report-skip', { day: '2026-10-09', nonce: old.nonce }, clock.now()).ok, false, 'restart cancels confirmation');
  clock.advance(60_001);
  assert.equal(reports.action('report-skip', { day: '2026-10-09', nonce: old.nonce }, clock.now()).ok, false, 'confirmation expires');
});

test('failed writes do not resolve a day', (t) => {
  const tmp = makeTmpDir('reports-write');
  t.after(tmp.cleanup);
  const clock = fixedClock(local(2026, 10, 6, 18, 0));
  const real = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  const reports = createReports({ store: { ...real, append: () => null }, config: () => owner });
  assert.equal(reports.action('report-submit', { day: '2026-10-06', energy: 3 }, clock.now()).error, 'write');
  assert.equal(reports.get('2026-10-06', clock.now())?.status, 'pending');
  const arm = reports.action('report-arm-skip', { day: '2026-10-06' }, clock.now());
  assert.equal(reports.action('report-skip', { day: '2026-10-06', nonce: arm.nonce }, clock.now() + 800).error, 'write');
  assert.equal(reports.get('2026-10-06', clock.now())?.status, 'pending');
});
