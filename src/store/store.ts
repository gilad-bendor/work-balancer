// Append-only JSONL store, one file per 04:00-bounded day: <dataDir>/YYYY-MM/YYYY-MM-DD.jsonl (instructions §6).
// Single writer (the daemon; the port bind is the mutex). Appends are synchronous, so they serialise by construction.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
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
  /** Never throws: a write error is logged and surfaced through `health()` (fail open). */
  append(record: NewRecord): AnyRecord;
  readDay(day: DayKey): AnyRecord[];
  /** Both inclusive, in day order. */
  readDays(from: DayKey, to: DayKey): AnyRecord[];
  filePath(day: DayKey): string;
  health(): StoreHealth;
}

interface CacheEntry {
  size: number;
  records: AnyRecord[];
  /** Bytes after the last '\n' — an unterminated (possibly torn, possibly still being written) line. */
  tail: Buffer;
}

export function createStore(opts: { dataDir: string; clock: Clock; log: Logger }): Store {
  const { dataDir, clock, log } = opts;
  const cache = new Map<string, CacheEntry>();
  let writeError: string | null = null;

  const filePath = (day: DayKey): string => join(dataDir, day.slice(0, 7), `${day}.jsonl`);

  function append(input: NewRecord): AnyRecord {
    const record: AnyRecord = { v: SCHEMA_VERSION, ts: input.ts ?? clock.now(), ...input } as AnyRecord;
    const about = aboutTime(record);
    const path = filePath(dayKey(about ?? clock.now()));
    try {
      mkdirSync(dirname(path), { recursive: true });
      const line = JSON.stringify(record) + '\n';
      appendFileSync(path, endsWithoutNewline(path) ? '\n' + line : line);
      writeError = null;
    } catch (e) {
      writeError = `cannot write ${path}: ${(e as Error).message}`;
      log.error('store append failed', { path, error: e as Error });
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
      const size = fstatSync(fd).size;
      let entry = cache.get(path);
      if (!entry || size < entry.size) entry = { size: 0, records: [], tail: Buffer.alloc(0) };
      if (size > entry.size) {
        const fresh = Buffer.alloc(size - entry.size);
        readSync(fd, fresh, 0, fresh.length, entry.size);
        const buf = Buffer.concat([entry.tail, fresh]);
        const lastNl = buf.lastIndexOf(0x0a);
        const complete = lastNl >= 0 ? buf.subarray(0, lastNl) : Buffer.alloc(0);
        const records = entry.records.slice();
        if (lastNl >= 0) parseLines(complete.toString('utf8'), records, path, log);
        entry = { size, records, tail: Buffer.from(lastNl >= 0 ? buf.subarray(lastNl + 1) : buf) };
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
    filePath,
    health: () => ({ writeError }),
  };
}

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
