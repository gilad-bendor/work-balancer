// Notes (ledger R-UI-CTX, R-UI-FB, R-UI-MENU-3, R-UI-REVIEW): context-memory, feedback and free notes, event-sourced.
// State = a fold of `note.*` records over ALL day files (instructions §6). No delete (D-36): "removing" a note is
// dismissing it. The daemon is the single writer, so after the startup fold the state follows its own appends.
import { randomBytes } from 'node:crypto';
import type { Logger } from '../core/log.ts';
import { dayKey, type DayKey } from '../core/time.ts';
import type { AnyRecord } from '../store/records.ts';
import type { Store } from '../store/store.ts';

export const NOTE_KINDS = ['context', 'feedback', 'note'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_SOURCES = ['quick', 'countdown', 'block', 'review', 'manager'] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

export const MAX_TEXT = 4000;
export const MAX_CHOICES = 20;

export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  choices: string[];
  energy: number | null;
  source: NoteSource;
  createdAt: number;
  /** Day key of creation (the "date" the owner sees). */
  day: DayKey;
  editedAt: number | null;
  dismissedAt: number | null;
}

export interface NewNote {
  kind: NoteKind;
  text?: unknown;
  choices?: unknown;
  energy?: unknown;
  source: NoteSource;
}

/** `empty`: nothing to save; `unknown`: no such note; `write`: the data file could not be written (the page keeps
 * the text); `invalid`: a bad kind/source. */
export type NoteError = 'empty' | 'unknown' | 'write' | 'invalid';
export type NoteResult = { ok: true; note: Note } | { ok: false; error: NoteError };

const isKind = (x: unknown): x is NoteKind => NOTE_KINDS.includes(x as NoteKind);
const isSource = (x: unknown): x is NoteSource => NOTE_SOURCES.includes(x as NoteSource);

export function newNoteId(now: number): string {
  return `n-${now}-${randomBytes(3).toString('hex')}`;
}

/** Pure fold of `note.*` records (file order). Unknown ids, duplicates and malformed records are ignored. */
export function foldNotes(records: Iterable<AnyRecord>, into: Map<string, Note> = new Map()): Map<string, Note> {
  for (const r of records) applyRecord(into, r);
  return into;
}

function applyRecord(notes: Map<string, Note>, r: AnyRecord): void {
  if (typeof r.noteId !== 'string') return;
  const n = notes.get(r.noteId);
  switch (r.type) {
    case 'note.created':
      if (n || !isKind(r.kind) || typeof r.text !== 'string') return;
      notes.set(r.noteId, {
        id: r.noteId, kind: r.kind, text: r.text,
        choices: Array.isArray(r.choices) ? r.choices.filter((c): c is string => typeof c === 'string') : [],
        energy: typeof r.energy === 'number' ? r.energy : null,
        source: isSource(r.source) ? r.source : 'manager',
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
  get(id: string): Note | null;
  /** Feedback notes, newest first. */
  recentFeedback(limit: number): Note[];
  create(input: NewNote): NoteResult;
  edit(id: unknown, text: unknown): NoteResult;
  dismiss(id: unknown): NoteResult;
  undismiss(id: unknown): NoteResult;
}

export function createNotes(deps: { store: Store; log: Logger; now: () => number; feedbackChoices: () => readonly string[] }): Notes {
  const { store, log } = deps;
  const notes = new Map<string, Note>();
  const t0 = performance.now();
  let records = 0;
  for (const day of store.listDays()) {
    const rs = store.scanDay(day, (line) => line.includes('"type":"note.'));
    records += rs.length;
    foldNotes(rs, notes);
  }
  log.info('notes loaded', { notes: notes.size, records, ms: Math.round(performance.now() - t0) });

  function write(record: { type: string; noteId: string; [k: string]: unknown }): boolean {
    const r = store.append(record);
    if (r) applyRecord(notes, r);
    return r !== null;
  }

  const found = (id: unknown): Note | null => (typeof id === 'string' ? (notes.get(id) ?? null) : null);
  const result = (id: string): NoteResult => {
    const n = notes.get(id);
    return n ? { ok: true, note: n } : { ok: false, error: 'unknown' };
  };

  return {
    list: () => orderNotes(notes.values()),
    active: () => orderNotes([...notes.values()].filter((n) => n.dismissedAt === null)),
    get: (id) => notes.get(id) ?? null,
    recentFeedback: (limit) => [...notes.values()].filter((n) => n.kind === 'feedback').sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),

    create(input) {
      if (!isKind(input.kind) || !isSource(input.source)) return { ok: false, error: 'invalid' };
      const text = cleanText(input.text);
      const allowed = new Set(deps.feedbackChoices());
      const rawChoices = Array.isArray(input.choices) ? input.choices : [];
      const choices = input.kind === 'feedback' ? [...new Set(rawChoices.filter((c): c is string => typeof c === 'string' && allowed.has(c)))].slice(0, MAX_CHOICES) : [];
      const energy = input.kind === 'feedback' && typeof input.energy === 'number' && Number.isInteger(input.energy) && input.energy >= 1 && input.energy <= 5 ? input.energy : null;
      if (!text && !choices.length && energy === null) return { ok: false, error: 'empty' };
      const id = newNoteId(deps.now());
      const ok = write({
        type: 'note.created', noteId: id, kind: input.kind, text,
        ...(choices.length ? { choices } : {}), ...(energy !== null ? { energy } : {}), source: input.source,
      });
      return ok ? result(id) : { ok: false, error: 'write' };
    },

    edit(id, rawText) {
      const n = found(id);
      if (!n) return { ok: false, error: 'unknown' };
      const text = cleanText(rawText);
      // A note without choices/energy needs its text; a feedback note may keep only its choices.
      if (!text && !n.choices.length && n.energy === null) return { ok: false, error: 'empty' };
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
