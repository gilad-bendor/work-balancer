process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createStore } from './store.ts';
import { lastWinsByMinute } from './records.ts';
import { fixedClock } from '../core/clock.ts';
import { silentLogger, type Logger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';

function setup(now: number) {
  const tmp = makeTmpDir('store');
  const clock = fixedClock(now);
  const warnings: string[] = [];
  const log: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
  const store = createStore({ dataDir: tmp.dir, clock, log });
  return { ...tmp, clock, store, warnings };
}

test('routes time records to the day they describe and actions to the current day', (t) => {
  const s = setup(local(2026, 10, 5, 4, 0, 30)); // just after Monday's 04:00
  t.after(s.cleanup);
  const lateMinute = local(2026, 10, 5, 3, 59);
  s.store.append({ type: 'minute', provider: 'interactive', minute: lateMinute, data: { x: 1 } });
  s.store.append({ type: 'note.created', noteId: 'n-1', kind: 'note', text: 'hello' });
  s.store.append({ type: 'monitor.gap', from: local(2026, 10, 5, 3, 0), to: local(2026, 10, 5, 3, 50), cause: 'daemon-down' });
  assert.equal(s.store.filePath('2026-10-04'), `${s.dir}/2026-10/2026-10-04.jsonl`);
  assert.deepEqual(s.store.readDay('2026-10-04').map((r) => r.type), ['minute', 'monitor.gap']);
  assert.deepEqual(s.store.readDay('2026-10-05').map((r) => r.type), ['note.created']);
  const r = s.store.readDay('2026-10-05')[0]!;
  assert.equal(r.v, 1);
  assert.equal(r.ts, local(2026, 10, 5, 4, 0, 30));
});

test('torn last line: repaired on the next append, skipped with a warning when read', (t) => {
  const s = setup(local(2026, 10, 4, 12, 0));
  t.after(s.cleanup);
  const path = s.store.filePath('2026-10-04');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"v":1,"ts":1,"type":"a"}\n{"v":1,"ts":2,"ty');
  // An unterminated tail is not reported yet (it may still be being written).
  assert.deepEqual(s.store.readDay('2026-10-04').map((r) => r.type), ['a']);
  s.store.append({ type: 'b' });
  assert.equal(readFileSync(path, 'utf8').split('\n').at(-2), JSON.stringify({ v: 1, ts: s.clock.now(), type: 'b' }));
  assert.deepEqual(s.store.readDay('2026-10-04').map((r) => r.type), ['a', 'b']);
  assert.equal(s.warnings.length, 1);
});

test('tolerant reader: garbage, non-objects, unknown types and fields; incremental reads pick up appends', (t) => {
  const s = setup(local(2026, 10, 4, 12, 0));
  t.after(s.cleanup);
  const path = s.store.filePath('2026-10-04');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ['not json', '[1,2]', '{"no":"type"}', '{"v":9,"ts":5,"type":"from.the.future","extra":{"a":1}}', ''].join('\n'));
  assert.deepEqual(s.store.readDay('2026-10-04').map((r) => r.type), ['from.the.future']);
  assert.equal(s.warnings.length, 3);
  appendFileSync(path, '{"v":1,"ts":6,"type":"later"}\n');
  assert.deepEqual(s.store.readDay('2026-10-04').map((r) => r.type), ['from.the.future', 'later']);
  assert.deepEqual(s.store.readDay('2026-10-05'), []);
});

test('out-of-order and repeated minute records: last one per (provider, minute) wins', (t) => {
  const s = setup(local(2026, 10, 4, 12, 0));
  t.after(s.cleanup);
  const m1 = local(2026, 10, 4, 11, 0);
  const m2 = local(2026, 10, 4, 11, 1);
  s.store.append({ type: 'minute', provider: 'interactive', minute: m2, data: { n: 1 } });
  s.store.append({ type: 'minute', provider: 'interactive', minute: m1, data: { n: 2 } });
  s.store.append({ type: 'minute', provider: 'prompt-history', minute: m1, data: { n: 99 } });
  s.store.append({ type: 'minute', provider: 'interactive', minute: m2, data: { n: 3 } });
  const idx = lastWinsByMinute<{ n: number }>(s.store.readDay('2026-10-04'), 'interactive');
  assert.deepEqual([...idx.keys()].sort(), [m1, m2]);
  assert.equal(idx.get(m1)!.data.n, 2);
  assert.equal(idx.get(m2)!.data.n, 3);
});

test('write errors never throw; they surface through health() and clear after a good write', (t) => {
  const s = setup(local(2026, 10, 4, 12, 0));
  t.after(() => { chmodSync(s.dir, 0o755); s.cleanup(); });
  chmodSync(s.dir, 0o500);
  s.store.append({ type: 'x' });
  assert.match(s.store.health().writeError ?? '', /cannot write/);
  chmodSync(s.dir, 0o755);
  s.store.append({ type: 'x' });
  assert.equal(s.store.health().writeError, null);
});

test('readDays spans day files in order', (t) => {
  const s = setup(local(2026, 10, 4, 12, 0));
  t.after(s.cleanup);
  s.store.append({ type: 'minute', provider: 'p', minute: local(2026, 10, 3, 12, 0), data: null });
  s.store.append({ type: 'minute', provider: 'p', minute: local(2026, 10, 1, 12, 0), data: null });
  s.store.append({ type: 'minute', provider: 'p', minute: local(2026, 10, 4, 12, 0), data: null });
  assert.deepEqual(s.store.readDays('2026-09-30', '2026-10-04').map((r) => r.minute), [local(2026, 10, 1, 12, 0), local(2026, 10, 3, 12, 0), local(2026, 10, 4, 12, 0)]);
});
