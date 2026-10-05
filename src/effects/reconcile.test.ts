import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, DEFAULT_QUIET, type ReconcileInput } from './reconcile.ts';
import type { WindowSpec } from '../core/effects.ts';

const win = (id: string, extra: Partial<WindowSpec> = {}): WindowSpec => ({
  id, rev: 'r1', path: '/ui/fixture.html', mode: 'floating', placement: 'center', title: id, intrusive: true, ...extra,
});
const T = 1_000_000;
const base = (o: Partial<ReconcileInput> = {}): ReconcileInput => ({
  now: T, desired: { windows: [], dims: [] }, actual: {}, pulsesDone: new Set(), lastInputAt: null, quiet: DEFAULT_QUIET, dueSince: new Map(), panic: false, ...o,
});

test('opens missing, updates changed revs, closes unwanted — idempotent ids', () => {
  const r = reconcile(base({ desired: { windows: [win('a'), win('b', { rev: 'r2' }), win('c')], dims: [] }, actual: { b: 'r1', c: 'r1', z: 'x' } }));
  assert.deepEqual(r.commands.map((c) => c.id), ['close:z', 'open:a:r1', 'open:b:r2']);
  const again = reconcile(base({ desired: { windows: [win('a')], dims: [] }, actual: { a: 'r1' } }));
  assert.deepEqual(again.commands, []);
});

test('R-UI-QUIET: a new intrusive window waits 10 s after input; updates/closes never wait; bounded by maxDefer', () => {
  const desired = { windows: [win('a'), win('b', { rev: 'r2' })], dims: [{ pulseId: 'p', level: 0.6, seconds: 3 }] };
  const r1 = reconcile(base({ desired, actual: { b: 'r1', z: 'x' }, lastInputAt: T - 9_999 }));
  assert.deepEqual(r1.commands.map((c) => c.id), ['close:z', 'open:b:r2']);
  assert.deepEqual(r1.deferred, ['win:a', 'dim:p']);
  // 10 s of quiet → starts.
  const r2 = reconcile(base({ desired, actual: { b: 'r2' }, lastInputAt: T - 10_000, dueSince: r1.dueSince }));
  assert.deepEqual(r2.commands.map((c) => c.id), ['open:a:r1', 'dim:p']);
  // Continuous typing: deferred until it has been due for maxDefer, then starts anyway.
  let due = r1.dueSince;
  const r3 = reconcile(base({ now: T + 119_999, desired, actual: { b: 'r2' }, lastInputAt: T + 119_000, dueSince: due }));
  assert.deepEqual(r3.commands, []);
  due = r3.dueSince;
  const r4 = reconcile(base({ now: T + 120_000, desired, actual: { b: 'r2' }, lastInputAt: T + 119_500, dueSince: due }));
  assert.deepEqual(r4.commands.map((c) => c.id), ['open:a:r1', 'dim:p']);
});

test('user-initiated windows are never deferred; panic drops intrusive windows and dims only', () => {
  const desired = { windows: [win('menu', { intrusive: false }), win('block')], dims: [{ pulseId: 'p', level: 0.6, seconds: 3 }] };
  const quiet = reconcile(base({ desired, lastInputAt: T - 1 }));
  assert.deepEqual(quiet.commands.map((c) => c.id), ['open:menu:r1']);
  const panic = reconcile(base({ desired, actual: { block: 'r1' }, panic: true }));
  assert.deepEqual(panic.commands.map((c) => c.id), ['close:block', 'open:menu:r1']);
});

test('a pulse runs once (acked pulses are never re-sent)', () => {
  const desired = { windows: [], dims: [{ pulseId: 'p', level: 0.6, seconds: 3 }] };
  assert.equal(reconcile(base({ desired })).commands.length, 1);
  assert.equal(reconcile(base({ desired, pulsesDone: new Set(['p']) })).commands.length, 0);
});

test('review M7#5: a window already shown today re-appears at once, even while typing', () => {
  const desired = { windows: [win('block')], dims: [] };
  const typing = base({ desired, lastInputAt: T - 1 });
  assert.deepEqual(reconcile(typing).commands, []);
  assert.deepEqual(reconcile({ ...typing, shownToday: new Set(['block']) }).commands.map((c) => c.id), ['open:block:r1']);
});
