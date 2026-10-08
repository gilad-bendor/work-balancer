// Notes (ledger R-UI-NOTE, R-UI-MENU-3, R-UI-REVIEW): reminders the owner leaves for himself — "park the thought".
// Event-sourced: state = a fold of `note.*` records over ALL day files (instructions §6). Never deleted (D-36):
// "removing" a note is dismissing it. The daemon is the single writer, so after the startup fold the state follows
// its own appends. How the owner is doing is a report (src/reports/), never a note.
import type { Logger } from '../core/log.ts';
import { dayKey, type DayKey } from '../core/time.ts';
import type { AnyRecord } from '../store/records.ts';
import type { Store } from '../store/store.ts';

export const NOTE_SOURCES = ['countdown', 'block', 'review', 'manager'] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

export const MAX_TEXT = 4000;

export interface Note {
  /** The creation time (epoch ms), bumped by 1 ms on a collision. */
  id: number;
  text: string;
  source: NoteSource;
  createdAt: number;
  /** Day key of creation (the "date" the owner sees). */
  day: DayKey;
  editedAt: number | null;
  dismissedAt: number | null;
}

/** `empty`: nothing to save; `unknown`: no such note; `write`: the data file could not be written (the page keeps
 * the text); `invalid`: a bad source. */
export type NoteError = 'empty' | 'unknown' | 'write' | 'invalid';
export type NoteResult = { ok: true; note: Note } | { ok: false; error: NoteError };

const isSource = (x: unknown): x is NoteSource => NOTE_SOURCES.includes(x as NoteSource);
export const isId = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;

/** An id = the creation time; ids are practically unique, and made unique by stepping past a taken one. */
export function newId(now: number, taken: (id: number) => boolean): number {
  let id = Math.floor(now);
  while (taken(id)) id++;
  return id;
}

/** Pure fold of `note.*` records (file order). Unknown ids, duplicates and malformed records are ignored. */
export function foldNotes(records: Iterable<AnyRecord>, into: Map<number, Note> = new Map()): Map<number, Note> {
  for (const r of records) applyRecord(into, r);
  return into;
}

function applyRecord(notes: Map<number, Note>, r: AnyRecord): void {
  if (!isId(r.noteId)) return;
  const n = notes.get(r.noteId);
  switch (r.type) {
    case 'note.created':
      if (n || typeof r.text !== 'string') return;
      notes.set(r.noteId, {
        id: r.noteId, text: r.text, source: isSource(r.source) ? r.source : 'manager',
        createdAt: r.ts, day: dayKey(r.ts), editedAt: null, dismissedAt: null,
      });
      return;
    case 'note.edited':
      if (n && typeof r.text === 'string') notes.set(n.id, { ...n, text: r.text, editedAt: r.ts });
      return;
    case 'note.dismissed':
      if (n && n.dismissedAt === null) notes.set(n.id, { ...n, dismissedAt: r.ts });
      return;
    case 'note.undismissed':
      if (n && n.dismissedAt !== null) notes.set(n.id, { ...n, dismissedAt: null });
      return;
  }
}

/** Not dismissed first (oldest first — they read like a story), then dismissed (most recently dismissed first). */
export function orderNotes(notes: Iterable<Note>): Note[] {
  const all = [...notes];
  const active = all.filter((n) => n.dismissedAt === null).sort((a, b) => a.createdAt - b.createdAt);
  const dismissed = all.filter((n) => n.dismissedAt !== null).sort((a, b) => b.dismissedAt! - a.dismissedAt!);
  return [...active, ...dismissed];
}

export const cleanText = (t: unknown): string => (typeof t === 'string' ? t.replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT) : '');

export interface Notes {
  list(): Note[];
  active(): Note[];
  get(id: number): Note | null;
  create(input: { text: unknown; source: NoteSource }): NoteResult;
  edit(id: unknown, text: unknown): NoteResult;
  dismiss(id: unknown): NoteResult;
  undismiss(id: unknown): NoteResult;
}

export function createNotes(deps: { store: Store; log: Logger; now: () => number }): Notes {
  const { store, log } = deps;
  const notes = new Map<number, Note>();
  const t0 = performance.now();
  let records = 0;
  for (const day of store.listDays()) {
    const rs = store.scanDay(day, (line) => line.includes('"type":"note.'));
    records += rs.length;
    foldNotes(rs, notes);
  }
  log.info('notes loaded', { notes: notes.size, records, ms: Math.round(performance.now() - t0) });

  function write(record: { type: string; noteId: number; [k: string]: unknown }): boolean {
    const r = store.append(record);
    if (r) applyRecord(notes, r);
    return r !== null;
  }

  const found = (id: unknown): Note | null => (isId(id) ? (notes.get(id) ?? null) : null);
  const result = (id: number): NoteResult => {
    const n = notes.get(id);
    return n ? { ok: true, note: n } : { ok: false, error: 'unknown' };
  };

  return {
    list: () => orderNotes(notes.values()),
    active: () => orderNotes([...notes.values()].filter((n) => n.dismissedAt === null)),
    get: (id) => notes.get(id) ?? null,

    create(input) {
      if (!isSource(input.source)) return { ok: false, error: 'invalid' };
      const text = cleanText(input.text);
      if (!text) return { ok: false, error: 'empty' };
      const id = newId(deps.now(), (x) => notes.has(x));
      return write({ type: 'note.created', noteId: id, text, source: input.source }) ? result(id) : { ok: false, error: 'write' };
    },

    edit(id, rawText) {
      const n = found(id);
      if (!n) return { ok: false, error: 'unknown' };
      const text = cleanText(rawText);
      if (!text) return { ok: false, error: 'empty' };
      if (text === n.text) return result(n.id);
      return write({ type: 'note.edited', noteId: n.id, text }) ? result(n.id) : { ok: false, error: 'write' };
    },

    dismiss(id) {
      const n = found(id);
      if (!n) return { ok: false, error: 'unknown' };
      if (n.dismissedAt !== null) return result(n.id);
      return write({ type: 'note.dismissed', noteId: n.id }) ? result(n.id) : { ok: false, error: 'write' };
    },

    undismiss(id) {
      const n = found(id);
      if (!n) return { ok: false, error: 'unknown' };
      if (n.dismissedAt === null) return result(n.id);
      return write({ type: 'note.undismissed', noteId: n.id }) ? result(n.id) : { ok: false, error: 'write' };
    },
  };
}
