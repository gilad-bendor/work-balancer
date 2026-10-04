process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayEnd, dayKey, dayKeysBetween, dayStart, formatHM, minuteKey, weekday, weekStartKey } from './time.ts';
import { local } from '../testing/tmp.ts';

const H = 3_600_000;

test('the 2026 Israel DST transitions are where the tests assume (Fri 27 Mar, Sun 25 Oct)', () => {
  assert.equal(new Date(local(2026, 3, 27, 1, 0)).getTimezoneOffset(), -120);
  assert.equal(new Date(local(2026, 3, 27, 4, 0)).getTimezoneOffset(), -180);
  assert.equal(new Date(local(2026, 10, 25, 0, 30)).getTimezoneOffset(), -180);
  assert.equal(new Date(local(2026, 10, 25, 4, 0)).getTimezoneOffset(), -120);
});

test('day boundary at 04:00 local', () => {
  assert.equal(dayKey(local(2026, 10, 4, 3, 59, 59)), '2026-10-03');
  assert.equal(dayKey(local(2026, 10, 4, 4, 0, 0)), '2026-10-04');
  assert.equal(dayKey(local(2026, 10, 4, 23, 59)), '2026-10-04');
  assert.equal(dayKey(local(2026, 10, 5, 0, 0)), '2026-10-04');
  assert.equal(dayStart('2026-10-04'), local(2026, 10, 4, 4, 0));
  assert.equal(dayEnd('2026-10-04') - dayStart('2026-10-04'), 24 * H);
});

test('month and year edges', () => {
  assert.equal(dayKey(local(2026, 11, 1, 2, 0)), '2026-10-31');
  assert.equal(dayKey(local(2027, 1, 1, 3, 0)), '2026-12-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(dayKeysBetween('2026-09-29', '2026-10-02'), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
});

test('spring-forward day (Thu 2026-03-26 04:00 → Fri 04:00) is 23 h', () => {
  assert.equal(dayEnd('2026-03-26') - dayStart('2026-03-26'), 23 * H);
  // 03:30 on the transition night still belongs to Thursday; `t − 4 h` would get this right by luck only.
  assert.equal(dayKey(local(2026, 3, 27, 3, 30)), '2026-03-26');
  assert.equal(dayKey(local(2026, 3, 27, 4, 0)), '2026-03-27');
  assert.equal(dayKey(dayStart('2026-03-27') - 1), '2026-03-26');
});

test('fall-back day (Sat 2026-10-24 04:00 → Sun 04:00) is 25 h', () => {
  assert.equal(dayEnd('2026-10-24') - dayStart('2026-10-24'), 25 * H);
  // Both 01:30s of the repeated hour belong to Saturday's day.
  const first = local(2026, 10, 25, 1, 30);
  assert.equal(dayKey(first), '2026-10-24');
  assert.equal(dayKey(first + H), '2026-10-24');
  // 04:00 Sunday is 25 real hours after Saturday 04:00 — `localDate(t − 4 h)` would put 03:00–04:00 Sunday on Sunday.
  assert.equal(dayKey(local(2026, 10, 25, 3, 30)), '2026-10-24');
  assert.equal(dayKey(dayStart('2026-10-25')), '2026-10-25');
});

test('weekdays and week start (Sun 04:00)', () => {
  assert.equal(weekday('2026-10-04'), 'sun');
  assert.equal(weekday('2026-10-09'), 'fri');
  assert.equal(weekday('2026-10-10'), 'sat');
  assert.equal(weekStartKey('2026-10-10'), '2026-10-04');
  assert.equal(weekStartKey('2026-10-04'), '2026-10-04');
  assert.equal(weekStartKey('2026-10-08'), '2026-10-04');
  // Saturday night after Shabbat (Sun 02:00) still belongs to Saturday's day → the ending week (Q-7).
  assert.equal(weekStartKey(dayKey(local(2026, 10, 11, 2, 0))), '2026-10-04');
  assert.equal(weekStartKey(dayKey(local(2026, 10, 11, 4, 0))), '2026-10-11');
  // A week containing the fall-back day is 7 × 24 h + 1 h.
  assert.equal(dayStart('2026-10-25') - dayStart('2026-10-18'), 7 * 24 * H + H);
});

test('minute keys and h:mm', () => {
  assert.equal(minuteKey(local(2026, 10, 4, 10, 5, 59)), local(2026, 10, 4, 10, 5));
  assert.equal(formatHM(0), '0:00');
  assert.equal(formatHM(59), '0:00');
  assert.equal(formatHM(9 * 3600 - 1), '8:59');
  assert.equal(formatHM(5 * 3600 + 12 * 60 + 30), '5:12');
});
