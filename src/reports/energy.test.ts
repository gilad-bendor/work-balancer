process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { energyDays, ENERGY_DAYS_CAP } from './energy.ts';
import { addDays } from '../core/time.ts';
import type { Report } from './reports.ts';

let nextId = 1;
const rep = (timestamp: string, day: string, energy: number | null, extra: Partial<Report> = {}): Report => ({
  id: nextId++, timestamp, day, stage: null, feedback: energy === null ? 'x' : '', status: [], energy, source: 'manager',
  createdAt: 0, editedAt: null, dismissedAt: null, ...extra,
});

test('energy days: from the first report to today, min/max per day, reports oldest first', () => {
  const days = energyDays([
    rep('2026-10-20 18:00', '2026-10-20', 2),
    rep('2026-10-20 09:00', '2026-10-20', 4.5),
    rep('2026-10-21 01:30', '2026-10-20', 3), // after midnight: still the 20th's day
    rep('2026-10-18 12:00', '2026-10-18', null),
  ], '2026-10-22');
  assert.deepEqual(days.map((d) => [d.day, d.weekday, d.min, d.max]), [
    ['2026-10-18', 'sun', null, null], ['2026-10-19', 'mon', null, null], ['2026-10-20', 'tue', 2, 4.5],
    ['2026-10-21', 'wed', null, null], ['2026-10-22', 'thu', null, null],
  ]);
  assert.deepEqual(days[2]!.reports.map((r) => r.timestamp), ['2026-10-20 09:00', '2026-10-20 18:00', '2026-10-21 01:30']);
  assert.equal(days[0]!.reports.length, 1, 'a report without energy is still listed');
  assert.equal(days[0]!.reports[0]!.skip, false);
});

test('energy days: none without reports; future and too-ancient reports are left out', () => {
  assert.deepEqual(energyDays([], '2026-10-22'), []);
  assert.deepEqual(energyDays([rep('2026-10-25 10:00', '2026-10-25', 3)], '2026-10-22'), []);
  const days = energyDays([rep('1990-01-01 10:00', '1990-01-01', 3), rep('2026-10-21 10:00', '2026-10-21', 1)], '2026-10-22');
  assert.deepEqual(days.map((d) => d.day), ['2026-10-21', '2026-10-22']);
  assert.ok(ENERGY_DAYS_CAP >= 3650);
});

test('energy days: half energies; a day without reports between two others; the cap boundary', () => {
  const days = energyDays([rep('2026-10-20 09:00', '2026-10-20', 2.5), rep('2026-10-20 18:00', '2026-10-20', 3.5), rep('2026-10-22 09:00', '2026-10-22', 4)], '2026-10-22');
  assert.deepEqual(days.map((d) => [d.day, d.min, d.max, d.reports.length]), [['2026-10-20', 2.5, 3.5, 2], ['2026-10-21', null, null, 0], ['2026-10-22', 4, 4, 1]]);
  const edge = addDays('2026-10-22', -(ENERGY_DAYS_CAP - 1));
  assert.equal(energyDays([rep(`${edge} 10:00`, edge, 3)], '2026-10-22').length, ENERGY_DAYS_CAP);
  const beyond = addDays(edge, -1);
  assert.deepEqual(energyDays([rep(`${beyond} 10:00`, beyond, 3)], '2026-10-22'), []);
});
