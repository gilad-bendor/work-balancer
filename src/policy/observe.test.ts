import { test } from 'node:test';
import assert from 'node:assert/strict';
import ownersPolicy from '../../config/policy.ts';
import { effectiveLimit, statusColour } from './observe.ts';

const H = 3600;

test('enforcing day: limit = min(daily, weekly − earlier); a heavy week shortens Thursday', () => {
  assert.equal(effectiveLimit(ownersPolicy, 'sun', 0).limitSeconds, 9 * H);
  assert.equal(effectiveLimit(ownersPolicy, 'thu', 38 * H).limitSeconds, 6 * H);
  assert.equal(effectiveLimit(ownersPolicy, 'thu', 50 * H).limitSeconds, 0);
  assert.equal(effectiveLimit(ownersPolicy, 'mon', 10 * H).limitSeconds, null);
  assert.equal(effectiveLimit(ownersPolicy, 'mon', 10 * H).referenceSeconds, 9 * H);
});

test('colours: green < 75 % ≤ orange < limit ≤ red; Monday by reference; Friday none; Saturday grey', () => {
  const sun = effectiveLimit(ownersPolicy, 'sun', 0);
  assert.equal(statusColour(ownersPolicy, sun, 6 * H), 'green');
  assert.equal(statusColour(ownersPolicy, sun, 6.75 * H), 'orange');
  assert.equal(statusColour(ownersPolicy, sun, 9 * H), 'red');
  assert.equal(statusColour(ownersPolicy, effectiveLimit(ownersPolicy, 'mon', 0), 7 * H), 'orange');
  assert.equal(statusColour(ownersPolicy, effectiveLimit(ownersPolicy, 'fri', 0), 7 * H), 'none');
  assert.equal(statusColour(ownersPolicy, effectiveLimit(ownersPolicy, 'sat', 0), 1 * H), 'grey');
  const thuExhausted = effectiveLimit(ownersPolicy, 'thu', 44 * H);
  assert.equal(statusColour(ownersPolicy, thuExhausted, 0), 'orange');
  assert.equal(statusColour(ownersPolicy, thuExhausted, 1), 'red');
});
