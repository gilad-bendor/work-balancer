import { test } from 'node:test';
import assert from 'node:assert/strict';
import ownersPolicy from '../../config/policy.ts';
import { effectiveLimit, statusColour } from './observe.ts';
import type { PolicyConfig } from './config.ts';

const H = 3600;

test('optional colour-only references still work on non-enforcing days', () => {
  const config: PolicyConfig = {
    ...ownersPolicy,
    days: {
      ...ownersPolicy.days,
      fri: { ...ownersPolicy.days.fri, colours: true, referenceMin: 9 * 60 },
    },
  };
  const fri = effectiveLimit(config, 'fri', 0);
  assert.deepEqual([fri.enforcing, fri.limitSeconds, fri.referenceSeconds], [false, null, 9 * H]);
  assert.equal(statusColour(config, fri, 7 * H), 'orange');
  assert.equal(statusColour(config, { ...fri, referenceSeconds: null }, 7 * H), 'none');
});

test('enforcing day: limit = min(daily, weekly − earlier); a heavy week shortens Thursday', () => {
  assert.equal(effectiveLimit(ownersPolicy, 'sun', 0).limitSeconds, 8.5 * H);
  assert.equal(effectiveLimit(ownersPolicy, 'thu', 38 * H).limitSeconds, 6 * H);
  assert.equal(effectiveLimit(ownersPolicy, 'thu', 50 * H).limitSeconds, 0);
  assert.equal(effectiveLimit(ownersPolicy, 'mon', 10 * H).limitSeconds, 8 * H);
  assert.equal(effectiveLimit(ownersPolicy, 'mon', 10 * H).referenceSeconds, null);
});

test('colours: green < 75 % ≤ orange < limit ≤ red; home days enforce; personal days grey', () => {
  const sun = effectiveLimit(ownersPolicy, 'sun', 0);
  assert.equal(statusColour(ownersPolicy, sun, 6 * H), 'green');
  assert.equal(statusColour(ownersPolicy, sun, 6.375 * H), 'orange');
  assert.equal(statusColour(ownersPolicy, sun, 8.5 * H), 'red');
  assert.equal(statusColour(ownersPolicy, effectiveLimit(ownersPolicy, 'mon', 0), 7 * H), 'orange');
  assert.equal(statusColour(ownersPolicy, effectiveLimit(ownersPolicy, 'fri', 0), 7 * H), 'grey');
  assert.equal(statusColour(ownersPolicy, effectiveLimit(ownersPolicy, 'sat', 0), 1 * H), 'grey');
  const thuExhausted = effectiveLimit(ownersPolicy, 'thu', 44 * H);
  assert.equal(statusColour(ownersPolicy, thuExhausted, 0), 'orange');
  assert.equal(statusColour(ownersPolicy, thuExhausted, 1), 'red');
});
