// Incremental line reading for append-mostly files: a byte cursor, only complete ('\n'-terminated) lines, and a guard
// on the bytes before the cursor so a rewritten/shrunk file is detected and re-read from 0. Reads in chunks and hands
// out raw line Buffers, so callers can reject lines by prefix without decoding them (history files reach tens of MB).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const GUARD_BYTES = 64;
const CHUNK = 4 << 20;

export interface Cursor {
  offset: number;
  guard: Buffer;
}

export interface ReadResult {
  /** The file was rewritten/truncated since the last read: lines were delivered from offset 0. */
  restarted: boolean;
  cursor: Cursor;
}

/** Calls `onLine` for each new complete line (without '\n'). Returns null if the file cannot be opened. Throws on
 * read errors (callers isolate per file and keep their previous cursor). */
export function readNewLines(path: string, prev: Cursor | null, onLine: (line: Buffer) => void, onRestart?: () => void): ReadResult | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    let start = prev?.offset ?? 0;
    let restarted = false;
    if (prev && (size < prev.offset || !guardMatches(fd, prev))) {
      start = 0;
      restarted = true;
      onRestart?.(); // before any line: the caller resets per-file state for the replay
    }
    let pos = start;
    let consumed = start;
    // Pieces of a line that spans chunks; concatenated once at its newline (no quadratic re-copying of huge lines).
    let carry: Buffer[] = [];
    while (pos < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
      const got = readSync(fd, chunk, 0, chunk.length, pos);
      if (got <= 0) break;
      pos += got;
      const buf = chunk.subarray(0, got);
      let s = 0;
      for (let nl = buf.indexOf(0x0a, s); nl !== -1; nl = buf.indexOf(0x0a, s)) {
        const line = carry.length ? Buffer.concat([...carry, buf.subarray(s, nl)]) : buf.subarray(s, nl);
        carry = [];
        if (line.length) onLine(line);
        s = nl + 1;
        consumed = pos - got + s;
      }
      if (s < got) carry.push(Buffer.from(buf.subarray(s))); // copy: let the chunk go
    }
    if (consumed === (restarted ? 0 : prev?.offset ?? 0) && !restarted && prev) return { restarted, cursor: prev };
    const guardLen = Math.min(GUARD_BYTES, consumed);
    const guard = Buffer.alloc(guardLen);
    if (guardLen) readSync(fd, guard, 0, guardLen, consumed - guardLen);
    return { restarted, cursor: { offset: consumed, guard } };
  } finally {
    closeSync(fd);
  }
}

function guardMatches(fd: number, prev: Cursor): boolean {
  if (!prev.guard.length) return true;
  const b = Buffer.alloc(prev.guard.length);
  readSync(fd, b, 0, b.length, prev.offset - prev.guard.length);
  return b.equals(prev.guard);
}

export function startsWith(line: Buffer, prefix: Buffer): boolean {
  return line.length >= prefix.length && line.compare(prefix, 0, prefix.length, 0, prefix.length) === 0;
}
