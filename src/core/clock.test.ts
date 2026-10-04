import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockFromEnv, parseFakeNow, systemClock } from './clock.ts';

test('no WB_FAKE_NOW → system clock', () => {
  assert.equal(clockFromEnv({}), systemClock);
});

test('WB_FAKE_NOW starts at the fake instant and then runs in real time', () => {
  let real = 1_000_000;
  const c = clockFromEnv({ WB_FAKE_NOW: '5000000' }, () => real);
  assert.equal(c.now(), 5_000_000);
  assert.equal(c.offsetMs, 4_000_000);
  real += 1500;
  assert.equal(c.now(), 5_001_500);
});

test('WB_FAKE_NOW accepts ISO strings and rejects garbage', () => {
  assert.equal(parseFakeNow('2026-10-04T10:00:00Z'), Date.UTC(2026, 9, 4, 10));
  assert.throws(() => parseFakeNow('soon'));
});
