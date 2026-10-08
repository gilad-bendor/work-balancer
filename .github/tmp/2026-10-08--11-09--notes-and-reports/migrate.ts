// One-time migration of data/ to the notes/reports split (session 2026-10-08--11-09--notes-and-reports).
// Old: note.created {noteId "n-<ms>-<hex>", kind context|feedback|note, text, choices?, energy?, source},
//      note.edited/dismissed/undismissed, report.submitted {day, energy, choices, text}, report.skipped {day}.
// New: notes {noteId <ms>, text, source}; reports {reportId <ms>, timestamp "YYYY-MM-DD HH:MM", stage?, feedback,
//      status, energy, source} + report.edited/dismissed/undismissed. Feedback notes become reports; their dismissals
//      (a morning-review "seen") are dropped — dismissing a report means "does not count". Records pointing at unknown
//      ids are dropped. Every other line stays byte-identical, in place.
// Usage: scripts/run-node <this file> [--data <dir>] [--apply]   (default: dry run on data/, prints no text)
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey } from '../../../src/core/time.ts';
import { catchUpTimestamp, foldReports, formatTimestamp, stageAt, timestampDay } from '../../../src/reports/reports.ts';
import { foldNotes } from '../../../src/notes/notes.ts';
import owner from '../../../config/policy.ts';

process.env.TZ ||= 'Asia/Jerusalem';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dataDir = args.includes('--data') ? args[args.indexOf('--data') + 1]! : join(import.meta.dirname, '../../../data');
const { stages, statuses } = owner.reports;
const allowed = new Set(statuses);

type Rec = Record<string, unknown> & { v: number; ts: number; type: string };
interface Line { raw: string; rec: Rec | null; out: string | null | undefined } // out: undefined = unchanged, null = dropped

const files = readdirSync(dataDir).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort()
  .flatMap((m) => readdirSync(join(dataDir, m)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => join(dataDir, m, f)));
const content = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const sizes = new Map(files.map((f) => [f, statSync(f).size]));
const lines = new Map(files.map((f) => [f, content.get(f)!.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').map((raw): Line => {
  try { return { raw, rec: JSON.parse(raw) as Rec, out: undefined }; } catch { return { raw, rec: null, out: undefined }; }
})]));
const all = files.flatMap((f) => lines.get(f)!);

const sourceOf = (s: unknown): string => (s === 'countdown' || s === 'block' || s === 'review' || s === 'manager' ? s : 'manager');
const idOf = (old: unknown, ts: number): number => {
  const m = typeof old === 'string' ? /^n-(\d+)-/.exec(old) : null;
  return m ? Number(m[1]) : ts;
};
const takenNotes = new Set<number>();
const takenReports = new Set<number>();
const unique = (id: number, taken: Set<number>): number => { while (taken.has(id)) id++; taken.add(id); return id; };
const write = (r: Rec): string => JSON.stringify(r);

const notes = new Map<string, number>(); // old id → new note id
const reports = new Map<string, { id: number; feedback: string; status: string[]; energy: number | null }>(); // old note id → report
const daily = new Map<string, { id: number; ts: number; fromFeedback: boolean; feedback: string; status: string[]; energy: number | null }>(); // day → last migrated end-of-workday report
const stats: Record<string, number> = {};
const count = (k: string): void => { stats[k] = (stats[k] ?? 0) + 1; };
const blockedBefore = (day: string, ts: number): boolean =>
  all.some((l) => l.rec?.type === 'policy.transition' && l.rec.to === 'blocked' && l.rec.ts <= ts && dayKey(l.rec.ts) === day);

for (const l of all) {
  const r = l.rec;
  if (!r || typeof r.type !== 'string') continue;
  const base = { v: r.v, ts: r.ts };
  if (r.type === 'note.created') {
    if (typeof r.noteId === 'number') continue; // already migrated
    const kind = r.kind;
    if (kind === 'feedback') {
      const id = unique(idOf(r.noteId, r.ts), takenReports);
      const timestamp = formatTimestamp(r.ts);
      const source = sourceOf(r.source);
      const choices = Array.isArray(r.choices) ? r.choices.filter((c): c is string => typeof c === 'string') : [];
      const fields = {
        feedback: typeof r.text === 'string' ? r.text : '',
        status: choices.filter((c) => allowed.has(c)),
        energy: typeof r.energy === 'number' && Number.isInteger(r.energy) && r.energy >= 1 && r.energy <= 5 ? r.energy : null,
      };
      // "Other" is gone: a note that said only that keeps it as its feedback (never an accidental skip report).
      if (!fields.feedback && !fields.status.length && fields.energy === null) fields.feedback = choices.join(', ') || '(empty feedback note)';
      const stage = source === 'countdown' || source === 'block' ? 'end-of-workday' : stageAt(timestamp, stages);
      l.out = write({ ...base, type: 'report.created', reportId: id, timestamp, stage, ...fields, source });
      reports.set(String(r.noteId), { id, ...fields });
      if (stage === 'end-of-workday') daily.set(dayKey(r.ts), { id, ts: r.ts, fromFeedback: true, ...fields });
      count('feedback note → report.created');
    } else {
      const id = unique(idOf(r.noteId, r.ts), takenNotes);
      notes.set(String(r.noteId), id);
      l.out = write({ ...base, type: 'note.created', noteId: id, text: r.text, source: sourceOf(r.source) });
      count('note.created (kind dropped)');
    }
  } else if (r.type === 'note.edited' || r.type === 'note.dismissed' || r.type === 'note.undismissed') {
    if (typeof r.noteId === 'number') continue;
    const n = notes.get(String(r.noteId));
    const rep = reports.get(String(r.noteId));
    if (n !== undefined) {
      l.out = write({ ...base, type: r.type, noteId: n, ...(r.type === 'note.edited' ? { text: r.text } : {}) });
      count(`${r.type} (numeric id)`);
    } else if (rep && r.type === 'note.edited') {
      rep.feedback = typeof r.text === 'string' ? r.text : '';
      l.out = write({ ...base, type: 'report.edited', reportId: rep.id, feedback: rep.feedback, status: rep.status, energy: rep.energy });
      count('feedback note.edited → report.edited');
    } else {
      l.out = null;
      count(rep ? `feedback ${r.type} dropped (a report is not dismissed for being seen)` : `${r.type} of an unknown note dropped`);
    }
  } else if (r.type === 'report.submitted' || r.type === 'report.skipped') {
    const day = String(r.day);
    const skip = r.type === 'report.skipped';
    const fields = skip ? { feedback: '', status: [] as string[], energy: null as number | null } : {
      feedback: typeof r.text === 'string' ? r.text : '',
      status: Array.isArray(r.choices) ? r.choices.filter((c): c is string => typeof c === 'string' && allowed.has(c)) : [],
      energy: typeof r.energy === 'number' && Number.isInteger(r.energy) && r.energy >= 1 && r.energy <= 5 ? r.energy : null,
    };
    const prev = daily.get(day);
    const same = prev && prev.feedback === fields.feedback && prev.energy === fields.energy && JSON.stringify(prev.status) === JSON.stringify(fields.status);
    if (prev?.fromFeedback && same && r.ts - prev.ts <= 10 * 60_000) {
      l.out = null; // the same answer typed twice (countdown feedback + daily report): one report
      prev.fromFeedback = false;
      count('daily report merged into the identical end-of-workday report');
      continue;
    }
    if (prev && !prev.fromFeedback) {
      // A daily report resubmitted (last one won): an edit of the first.
      Object.assign(prev, fields);
      l.out = write({ ...base, type: 'report.edited', reportId: prev.id, ...fields });
      count(`${r.type} for a reported day → report.edited`);
      continue;
    }
    const id = unique(r.ts, takenReports);
    const sameDay = dayKey(r.ts) === day;
    const timestamp = sameDay && !skip ? formatTimestamp(r.ts) : catchUpTimestamp(day, 'end-of-workday', stages);
    const source = skip || !sameDay ? 'review' : blockedBefore(day, r.ts) ? 'block' : 'manager';
    l.out = write({ ...base, type: 'report.created', reportId: id, timestamp, ...(skip ? {} : { stage: 'end-of-workday' }), ...fields, source });
    daily.set(day, { id, ts: r.ts, fromFeedback: false, ...fields });
    count(`${r.type} → report.created`);
  }
}

const redact = (s: string): string => s.replace(/"(text|feedback)":"((?:[^"\\]|\\.)*)"/g, (_m, k: string, v: string) => `"${k}":<${v.length} chars>`);
let changedFiles = 0;
for (const f of files) {
  const ls = lines.get(f)!;
  if (!ls.some((l) => l.out !== undefined)) continue;
  changedFiles++;
  console.log(`\n${f.slice(dataDir.length + 1)}`);
  for (const l of ls) {
    if (l.out === undefined) continue;
    console.log(`  - ${redact(l.raw)}`);
    if (l.out !== null) console.log(`  + ${redact(l.out)}`);
  }
}
console.log('\n', stats);

// What the new code will fold out of it (no text).
const after = files.flatMap((f) => lines.get(f)!.map((l) => (l.out === undefined ? l.rec : l.out === null ? null : JSON.parse(l.out) as Rec))).filter((r): r is Rec => !!r);
const n = foldNotes(after as never);
const rp = foldReports(after as never);
console.log('notes:', [...n.values()].map((x) => ({ id: x.id, day: x.day, source: x.source, dismissed: x.dismissedAt !== null })));
console.log('reports:', [...rp.values()].map((x) => ({ id: x.id, timestamp: x.timestamp, day: timestampDay(x.timestamp), stage: x.stage, status: x.status, energy: x.energy, source: x.source })));

if (!apply) {
  console.log(`\nDry run: ${changedFiles} file(s) would change. Re-run with --apply (the live daemon must be stopped).`);
} else {
  // The live daemon is the only writer: it must be stopped (WorkBalancer.quit()), or an append could be lost.
  try {
    const info = JSON.parse(readFileSync(join(dataDir, '../var/live/daemon.json'), 'utf8')) as { pid?: number };
    if (info.pid) { process.kill(info.pid, 0); throw new Error(`the live daemon (pid ${info.pid}) is running — stop it first`); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH' && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const changed = files.filter((f) => lines.get(f)!.some((l) => l.out !== undefined));
  for (const f of changed) if (statSync(f).size !== sizes.get(f)) throw new Error(`${f} changed since it was read — nothing written`);
  for (const f of changed) {
    const text = lines.get(f)!.filter((l) => l.out !== null).map((l) => l.out ?? l.raw).join('\n') + '\n';
    writeFileSync(`${f}.migrating`, text, { mode: statSync(f).mode });
  }
  for (const f of changed) renameSync(`${f}.migrating`, f);
  console.log(`\nApplied: ${changed.length} file(s) rewritten.`);
}
