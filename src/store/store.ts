// Append-only JSONL store, one file per 04:00-bounded day: <dataDir>/YYYY-MM/YYYY-MM-DD.jsonl (instructions §6).
// Single writer (the daemon; the port bind is the mutex). Appends are synchronous, so they serialise by construction.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';
import { dayKey, dayKeysBetween, type DayKey } from '../core/time.ts';
import { aboutTime, SCHEMA_VERSION, type AnyRecord, type NewRecord } from './records.ts';

export interface StoreHealth {
  /** Last write error (cleared by the next successful write). Shown as a menubar warning. */
  writeError: string | null;
}

export interface Store {
  readonly dataDir: string;
  /** Never throws. Returns null when the line could not be written (logged, surfaced via `health()`); callers that
   * must not lose the record keep it and retry. */
  append(record: NewRecord): AnyRecord | null;
  readDay(day: DayKey): AnyRecord[];
  /** Both inclusive, in day order. */
  readDays(from: DayKey, to: DayKey): AnyRecord[];
  /** Day keys that have a file, ascending. */
  listDays(): DayKey[];
  /** Reads a day without caching it (whole-history folds, old days). `lineFilter` skips lines before parsing. */
  scanDay(day: DayKey, lineFilter?: (line: string) => boolean): AnyRecord[];
  filePath(day: DayKey): string;
  health(): StoreHealth;
}

interface CacheEntry {
  /** Identity of the file the cache was built from: a replaced/rewritten file (git checkout …) resets the cache. */
  ino: number;
  head: Buffer;
  size: number;
  records: AnyRecord[];
  /** Bytes after the last '\n' — an unterminated (possibly torn, possibly still being written) line. */
  tail: Buffer;
}

export function createStore(opts: { dataDir: string; clock: Clock; log: Logger }): Store {
  const { dataDir, clock, log } = opts;
  const cache = new Map<string, CacheEntry>();
  /** Files this process has seen end with '\n' — single writer, so they stay that way until a write fails. */
  const terminated = new Set<string>();
  let writeError: string | null = null;
  let writeErrorAt = 0;
  let errorLoggedAt = -Infinity;

  const filePath = (day: DayKey): string => join(dataDir, day.slice(0, 7), `${day}.jsonl`);

  function append(input: NewRecord): AnyRecord | null {
    // `ts` is taken out of the input: an explicit `ts: undefined` must not erase the timestamp (readers drop such lines).
    const { ts, ...rest } = input;
    const record: AnyRecord = { v: SCHEMA_VERSION, ts: ts ?? clock.now(), ...rest } as AnyRecord;
    const about = aboutTime(record);
    const path = filePath(dayKey(about ?? clock.now()));
    try {
      mkdirSync(dirname(path), { recursive: true });
      const line = JSON.stringify(record) + '\n';
      const repair = !terminated.has(path) && endsWithoutNewline(path);
      appendFileSync(path, repair ? '\n' + line : line);
      terminated.add(path);
    } catch (e) {
      terminated.delete(path);
      writeError = `cannot write ${path}: ${(e as Error).message}`;
      // At most one log line per minute while failing, not one per attempt.
      if (clock.now() - errorLoggedAt >= 60_000) {
        log.error('store append failed', { path, error: e as Error });
        errorLoggedAt = clock.now();
      }
      writeErrorAt = clock.now();
      return null;
    }
    return record;
  }

  function readDay(day: DayKey): AnyRecord[] {
    const path = filePath(day);
    if (!existsSync(path)) {
      cache.delete(path);
      return [];
    }
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (e) {
      log.warn('store read failed', { path, error: e as Error });
      return cache.get(path)?.records ?? [];
    }
    try {
      const st = fstatSync(fd);
      const size = st.size;
      const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
      readSync(fd, head, 0, head.length, 0);
      let entry = cache.get(path);
      const sameFile = entry && entry.ino === st.ino && size >= entry.size && head.subarray(0, entry.head.length).equals(entry.head);
      if (!entry || !sameFile) entry = { ino: st.ino, head, size: 0, records: [], tail: Buffer.alloc(0) };
      if (size > entry.size) {
        const fresh = Buffer.alloc(size - entry.size);
        readSync(fd, fresh, 0, fresh.length, entry.size);
        const buf = Buffer.concat([entry.tail, fresh]);
        const lastNl = buf.lastIndexOf(0x0a);
        const complete = lastNl >= 0 ? buf.subarray(0, lastNl) : Buffer.alloc(0);
        const records = entry.records.slice();
        if (lastNl >= 0) parseLines(complete.toString('utf8'), records, path, log);
        entry = { ino: st.ino, head, size, records, tail: Buffer.from(lastNl >= 0 ? buf.subarray(lastNl + 1) : buf) };
      }
      cache.set(path, entry);
      return entry.records;
    } finally {
      closeSync(fd);
    }
  }

  return {
    dataDir,
    append,
    readDay,
    readDays: (from, to) => dayKeysBetween(from, to).flatMap(readDay),
    listDays() {
      const out: DayKey[] = [];
      let months: string[];
      try {
        months = readdirSync(dataDir).filter((m) => MONTH_DIR.test(m));
      } catch {
        return out; // no data yet
      }
      for (const m of months) {
        let files: string[] = [];
        try {
          files = readdirSync(join(dataDir, m));
        } catch (e) {
          log.warn('store list failed', { dir: m, error: e as Error });
        }
        for (const f of files) {
          const k = DAY_FILE.exec(f)?.[1];
          if (k && k.startsWith(m)) out.push(k);
        }
      }
      return out.sort();
    },
    scanDay(day, lineFilter) {
      const path = filePath(day);
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        return [];
      }
      const lastNl = text.lastIndexOf('\n');
      // An unterminated last line may still be being written (or torn): skip it, like readDay.
      const complete = lastNl >= 0 ? text.slice(0, lastNl) : '';
      const out: AnyRecord[] = [];
      parseLines(lineFilter ? complete.split('\n').filter(lineFilter).join('\n') : complete, out, path, log);
      return out;
    },
    filePath,
    // The warning stays visible for a while after the last failure, so a brief problem is not missed.
    health: () => ({ writeError: writeError && clock.now() - writeErrorAt < WRITE_ERROR_VISIBLE_MS ? writeError : null }),
  };
}

const HEAD_BYTES = 256;
const MONTH_DIR = /^\d{4}-\d{2}$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const WRITE_ERROR_VISIBLE_MS = 10 * 60_000;

function endsWithoutNewline(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false; // new file
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string, out: AnyRecord[], path: string, log: Logger): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      log.warn('skipping unparsable line', { path, line: line.slice(0, 120) });
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as AnyRecord).type === 'string' && typeof (v as AnyRecord).ts === 'number') {
      out.push(v as AnyRecord);
    } else {
      log.warn('skipping malformed record', { path, line: line.slice(0, 120) });
    }
  }
}
