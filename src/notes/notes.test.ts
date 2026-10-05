process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { createStore } from '../store/store.ts';
import { fixedClock } from '../core/clock.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';
import { createNotes, foldNotes, MAX_TEXT, orderNotes } from './notes.ts';
import type { AnyRecord } from '../store/records.ts';

const CHOICES = ['Feeling tired', 'Productive', 'Other'];

function setup(now: number) {
  const tmp = makeTmpDir('notes');
  const clock = fixedClock(now);
  const store = createStore({ dataDir: tmp.dir, clock, log: silentLogger });
  const make = () => createNotes({ store, log: silentLogger, now: () => clock.now(), feedbackChoices: () => CHOICES });
  return { ...tmp, clock, store, make };
}

const rec = (ts: number, type: string, f: Record<string, unknown>): AnyRecord => ({ v: 1, ts, type, ...f });

test('fold: created / edited / dismissed / undismissed; unknown ids, duplicates and malformed records ignored', () => {
  const m = foldNotes([
    rec(1, 'note.edited', { noteId: 'ghost', text: 'x' }),
    rec(2, 'note.created', { noteId: 'a', kind: 'context', text: 'next: tests', source: 'quick' }),
    rec(3, 'note.created', { noteId: 'a', kind: 'note', text: 'duplicate' }),
    rec(4, 'note.created', { noteId: 'b', kind: 'feedback', text: '', choices: ['Productive', 7], energy: 4, source: 'quick' }),
    rec(5, 'note.created', { noteId: 'c', kind: 'weird', text: 'bad kind' }),
    rec(6, 'note.created', { noteId: 'd', kind: 'note' }),
    rec(7, 'note.edited', { noteId: 'a', text: 'next: more tests' }),
    rec(8, 'note.dismissed', { noteId: 'a' }),
    rec(9, 'note.dismissed', { noteId: 'a' }),
    rec(10, 'note.undismissed', { noteId: 'a' }),
    rec(11, 'note.dismissed', { noteId: 'b' }),
    rec(12, 'note.deleted', { noteId: 'b' }), // dropped from the model (D-36): ignored
  ]);
  assert.deepEqual([...m.keys()], ['a', 'b']);
  assert.equal(m.get('a')!.text, 'next: more tests');
  assert.equal(m.get('a')!.editedAt, 7);
  assert.equal(m.get('a')!.dismissedAt, null);
  assert.deepEqual(m.get('b')!.choices, ['Productive']);
  assert.equal(m.get('b')!.energy, 4);
  assert.equal(m.get('b')!.dismissedAt, 11);
});

test('order: waiting notes oldest first, then dismissed (most recently dismissed first)', () => {
  const m = foldNotes([
    rec(1, 'note.created', { noteId: 'old', kind: 'note', text: '1' }),
    rec(2, 'note.created', { noteId: 'mid', kind: 'note', text: '2' }),
    rec(3, 'note.created', { noteId: 'new', kind: 'note', text: '3' }),
    rec(4, 'note.created', { noteId: 'x', kind: 'note', text: '4' }),
    rec(5, 'note.dismissed', { noteId: 'old' }),
    rec(6, 'note.dismissed', { noteId: 'x' }),
  ]);
  assert.deepEqual(orderNotes(m.values()).map((n) => n.id), ['mid', 'new', 'x', 'old']);
});

test('create: validation, trimming, unknown choices dropped, energy 1–5 only, ids n-<ms>-<rand>, current day file', (t) => {
  const s = setup(local(2026, 10, 8, 18, 0)); // Thursday
  t.after(s.cleanup);
  const notes = s.make();
  assert.deepEqual(notes.create({ kind: 'context', text: '   ', source: 'quick' }), { ok: false, error: 'empty' });
  assert.deepEqual(notes.create({ kind: 'feedback', choices: ['Nope'], energy: 9, source: 'quick' }), { ok: false, error: 'empty' });
  assert.deepEqual(notes.create({ kind: 'nope' as never, text: 'x', source: 'quick' }), { ok: false, error: 'invalid' });
  const c = notes.create({ kind: 'context', text: '  finish the uploader\r\n', source: 'quick', choices: ['Productive'], energy: 3 });
  assert.ok(c.ok);
  assert.match(c.note.id, /^n-\d+-[0-9a-f]{6}$/);
  assert.equal(c.note.text, 'finish the uploader');
  assert.deepEqual(c.note.choices, [], 'choices only on feedback notes');
  assert.equal(c.note.energy, null);
  const f = notes.create({ kind: 'feedback', text: '', choices: ['Productive', 'Productive', 'Nope', 3], energy: 2.5, source: 'quick' });
  assert.ok(f.ok);
  assert.deepEqual(f.note.choices, ['Productive']);
  assert.equal(f.note.energy, null);
  const long = notes.create({ kind: 'note', text: 'x'.repeat(MAX_TEXT + 50), source: 'manager' });
  assert.ok(long.ok);
  assert.equal(long.note.text.length, MAX_TEXT);
  const lines = readFileSync(s.store.filePath('2026-10-08'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ['note.created', 'note.created', 'note.created']);
  assert.equal(lines[1].choices[0], 'Productive');
  assert.equal('energy' in lines[1], false);
  assert.equal(lines[0].source, 'quick');
});

test('edit / dismiss / undismiss: idempotent, logged once; fold over all days after a restart gives the same state', (t) => {
  const s = setup(local(2026, 10, 8, 18, 0));
  t.after(s.cleanup);
  const notes = s.make();
  const a = notes.create({ kind: 'context', text: 'A', source: 'quick' });
  const b = notes.create({ kind: 'feedback', choices: ['Feeling tired'], source: 'quick' });
  assert.ok(a.ok && b.ok);
  s.clock.set(local(2026, 10, 11, 9, 0)); // Sunday: corrections reference Thursday's ids
  assert.ok(notes.edit(a.note.id, 'A, then B').ok);
  assert.ok(notes.edit(a.note.id, 'A, then B').ok, 'same text: no record');
  assert.deepEqual(notes.edit(a.note.id, ''), { ok: false, error: 'empty' });
  assert.ok(notes.edit(b.note.id, '').ok, 'a feedback note may keep only its choices');
  assert.deepEqual(notes.edit('n-nope', 'x'), { ok: false, error: 'unknown' });
  assert.deepEqual(notes.dismiss(42), { ok: false, error: 'unknown' });
  assert.ok(notes.dismiss(a.note.id).ok);
  assert.ok(notes.dismiss(a.note.id).ok);
  assert.ok(notes.undismiss(b.note.id).ok, 'not dismissed: no record');
  assert.deepEqual(notes.active().map((n) => n.id), [b.note.id]);
  const sunday = s.store.readDay('2026-10-11').map((r) => r.type);
  assert.deepEqual(sunday, ['note.edited', 'note.dismissed']);
  const again = s.make();
  assert.deepEqual(again.list(), notes.list());
  assert.equal(again.get(a.note.id)!.text, 'A, then B');
  assert.equal(again.get(a.note.id)!.day, '2026-10-08');
  assert.deepEqual(again.recentFeedback(5).map((n) => n.id), [b.note.id]);
});

test('a write error leaves the state unchanged and says so (the page keeps the text)', (t) => {
  const s = setup(local(2026, 10, 8, 18, 0));
  t.after(s.cleanup);
  const notes = s.make();
  const a = notes.create({ kind: 'note', text: 'kept', source: 'manager' });
  assert.ok(a.ok);
  chmodSync(s.store.filePath('2026-10-08'), 0o444);
  assert.deepEqual(notes.create({ kind: 'note', text: 'lost?', source: 'manager' }), { ok: false, error: 'write' });
  assert.deepEqual(notes.dismiss(a.note.id), { ok: false, error: 'write' });
  assert.equal(notes.list().length, 1);
  assert.equal(notes.get(a.note.id)!.dismissedAt, null);
  chmodSync(s.store.filePath('2026-10-08'), 0o644);
});
