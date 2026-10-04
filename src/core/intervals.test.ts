import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, normalize, overlap, subtract, total, union } from './intervals.ts';

test('normalize merges overlapping and touching intervals, drops empty ones', () => {
  assert.deepEqual(normalize([[5, 7], [1, 3], [3, 4], [6, 10], [20, 20]]), [[1, 4], [5, 10]]);
});

test('union, subtract, clip, total, overlap', () => {
  assert.deepEqual(union([[0, 10]], [[5, 15], [20, 30]]), [[0, 15], [20, 30]]);
  assert.deepEqual(subtract([[0, 100]], [[10, 20], [15, 30], [90, 200]]), [[0, 10], [30, 90]]);
  assert.deepEqual(subtract([[0, 10], [20, 30]], [[5, 25]]), [[0, 5], [25, 30]]);
  assert.deepEqual(subtract([[0, 10]], [[0, 10]]), []);
  assert.deepEqual(clip([[0, 10], [20, 30]], 5, 25), [[5, 10], [20, 25]]);
  assert.equal(total([[0, 10], [20, 25]]), 15);
  assert.equal(overlap([[0, 10], [20, 30]], 5, 25), 10);
});
