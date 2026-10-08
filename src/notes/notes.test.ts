process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { createStore } from '../store/store.ts';
import { fixedClock } from '../core/clock.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';
import { createNotes, foldNotes, MAX_TEXT, newId, orderNotes } from './notes.ts';
import type { AnyRecord } from '../store/records.ts';

function setup(now: number) {
  const tmp = makeTmpDir('notes');
  const clock = fixedClock(now);
  const store = createStore({ dataDir: tmp.dir, clock, log: silentLogger });
  const make = () => createNotes({ store, log: silentLogger, now: () => clock.now() });
  return { ...tmp, clock, store, make };
}

const rec = (ts: number, type: string, f: Record<string, unknown>): AnyRecord => ({ v: 1, ts, type, ...f });

test('fold: created / edited / dismissed / undismissed; unknown ids, duplicates and malformed records ignored', () => {
  const m = foldNotes([
    rec(1, 'note.edited', { noteId: 99, text: 'x' }),
    rec(2, 'note.created', { noteId: 2, text: 'next: tests', source: 'block' }),
    rec(3, 'note.created', { noteId: 2, text: 'duplicate' }),
    rec(4, 'note.created', { noteId: 'n-4-abcdef', text: 'string id (pre-migration)' }),
    rec(5, 'note.created', { noteId: 5 }),
    rec(6, 'note.created', { noteId: 6, text: 'unknown source', source: 'quick' }),
    rec(7, 'note.edited', { noteId: 2, text: 'next: more tests' }),
    rec(8, 'note.dismissed', { noteId: 2 }),
    rec(9, 'note.dismissed', { noteId: 2 }),
    rec(10, 'note.undismissed', { noteId: 2 }),
    rec(11, 'note.dismissed', { noteId: 6 }),
    rec(12, 'note.deleted', { noteId: 6 }), // not in the model (D-36): ignored
  ]);
  assert.deepEqual([...m.keys()], [2, 6]);
  assert.equal(m.get(2)!.text, 'next: more tests');
  assert.equal(m.get(2)!.editedAt, 7);
  assert.equal(m.get(2)!.dismissedAt, null);
  assert.equal(m.get(6)!.source, 'manager');
  assert.equal(m.get(6)!.dismissedAt, 11);
});

test('order: waiting notes oldest first, then dismissed (most recently dismissed first)', () => {
  const m = foldNotes([
    rec(1, 'note.created', { noteId: 1, text: '1' }),
    rec(2, 'note.created', { noteId: 2, text: '2' }),
    rec(3, 'note.created', { noteId: 3, text: '3' }),
    rec(4, 'note.created', { noteId: 4, text: '4' }),
    rec(5, 'note.dismissed', { noteId: 1 }),
    rec(6, 'note.dismissed', { noteId: 4 }),
  ]);
  assert.deepEqual(orderNotes(m.values()).map((n) => n.id), [2, 3, 4, 1]);
});

test('ids: the creation time, stepped past a taken one', () => {
  assert.equal(newId(1000, () => false), 1000);
  assert.equal(newId(1000, (x) => x < 1003), 1003);
});

test('create: validation, trimming, id = creation time (unique), current day file, no kind', (t) => {
  const T = local(2026, 10, 8, 18, 0); // Thursday
  const s = setup(T);
  t.after(s.cleanup);
  const notes = s.make();
  assert.deepEqual(notes.create({ text: '   ', source: 'manager' }), { ok: false, error: 'empty' });
  assert.deepEqual(notes.create({ text: 'x', source: 'quick' as never }), { ok: false, error: 'invalid' });
  const c = notes.create({ text: '  finish the uploader\r\n', source: 'block' });
  const d = notes.create({ text: 'same millisecond', source: 'manager' });
  assert.ok(c.ok && d.ok);
  assert.equal(c.note.id, T);
  assert.equal(d.note.id, T + 1, 'a collision steps to the next free millisecond');
  assert.equal(c.note.text, 'finish the uploader');
  const long = notes.create({ text: 'x'.repeat(MAX_TEXT + 50), source: 'manager' });
  assert.ok(long.ok);
  assert.equal(long.note.text.length, MAX_TEXT);
  const lines = readFileSync(s.store.filePath('2026-10-08'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ['note.created', 'note.created', 'note.created']);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['noteId', 'source', 'text', 'ts', 'type', 'v']);
  assert.equal(lines[0].noteId, T);
});

test('edit / dismiss / undismiss: idempotent, logged once; fold over all days after a restart gives the same state', (t) => {
  const s = setup(local(2026, 10, 8, 18, 0));
  t.after(s.cleanup);
  const notes = s.make();
  const a = notes.create({ text: 'A', source: 'block' });
  const b = notes.create({ text: 'B', source: 'manager' });
  assert.ok(a.ok && b.ok);
  s.clock.set(local(2026, 10, 11, 9, 0)); // Sunday: corrections reference Thursday's ids
  assert.ok(notes.edit(a.note.id, 'A, then B').ok);
  assert.ok(notes.edit(a.note.id, 'A, then B').ok, 'same text: no record');
  assert.deepEqual(notes.edit(a.note.id, ''), { ok: false, error: 'empty' });
  assert.deepEqual(notes.edit(12345, 'x'), { ok: false, error: 'unknown' });
  assert.deepEqual(notes.dismiss(String(a.note.id)), { ok: false, error: 'unknown' });
  assert.ok(notes.dismiss(a.note.id).ok);
  assert.ok(notes.dismiss(a.note.id).ok);
  assert.ok(notes.undismiss(b.note.id).ok, 'not dismissed: no record');
  assert.deepEqual(notes.active().map((n) => n.id), [b.note.id]);
  assert.deepEqual(s.store.readDay('2026-10-11').map((r) => r.type), ['note.edited', 'note.dismissed']);
  const again = s.make();
  assert.deepEqual(again.list(), notes.list());
  assert.equal(again.get(a.note.id)!.text, 'A, then B');
  assert.equal(again.get(a.note.id)!.day, '2026-10-08');
});

test('a write error leaves the state unchanged and says so (the page keeps the text)', (t) => {
  const s = setup(local(2026, 10, 8, 18, 0));
  t.after(s.cleanup);
  const notes = s.make();
  const a = notes.create({ text: 'kept', source: 'manager' });
  assert.ok(a.ok);
  chmodSync(s.store.filePath('2026-10-08'), 0o444);
  assert.deepEqual(notes.create({ text: 'lost?', source: 'manager' }), { ok: false, error: 'write' });
  assert.deepEqual(notes.dismiss(a.note.id), { ok: false, error: 'write' });
  assert.equal(notes.list().length, 1);
  assert.equal(notes.get(a.note.id)!.dismissedAt, null);
  chmodSync(s.store.filePath('2026-10-08'), 0o644);
});
