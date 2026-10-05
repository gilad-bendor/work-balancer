// S-VSC: VS Code native chat op-logs (F-COP-8). NOT append-only: VS Code compacts by rewriting the file as one kind:0
// line, so per-file request ids / answered resolve ids are kept across re-reads (never count twice).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readNewLines, startsWith, type Cursor } from './files.ts';
import { hasRunnerMarker } from './markers.ts';

export interface VsPrompt {
  kind: 'prompt';
  id: string;
  at: number;
  system: boolean;
  blank: boolean;
  runnerMarker: boolean;
  /** Pushed by a splice with the same text as a request that splice removed (V3). */
  retry: boolean;
}

export interface VsAnswer {
  kind: 'answer';
  id: string;
  /** The file has no answer time: the containing request's time (a lower bound), the same on every (re-)read. */
  at: number;
}

export type VsCandidate = VsPrompt | VsAnswer;

interface FileState {
  cursor: Cursor | null;
  mtime: number;
  size: number;
  requests: { id: string; hash: string; at: number }[];
  known: Set<string>;
  resolved: Set<string>;
}

const SNAPSHOT = Buffer.from('{"kind":0');
const PUSH_REQUESTS = Buffer.from('{"kind":2,"k":["requests"]');
const CAROUSEL = Buffer.from('"questionCarousel"');

export interface VsReader {
  poll(since: number, onError?: (path: string, e: unknown) => void): VsCandidate[];
}

/** `appSupport` = ~/Library/Application Support; both Code and Code - Insiders are scanned. */
export function createVsReader(opts: { appSupport: string }): VsReader {
  const files = new Map<string, FileState>();

  function listFiles(): string[] {
    const out: string[] = [];
    for (const edition of ['Code', 'Code - Insiders']) {
      const user = join(opts.appSupport, edition, 'User');
      const ws = join(user, 'workspaceStorage');
      if (existsSync(ws)) {
        for (const h of readdirSync(ws)) {
          const dir = join(ws, h, 'chatSessions');
          if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(join(dir, f));
        }
      }
      const empty = join(user, 'globalStorage', 'emptyWindowChatSessions');
      if (existsSync(empty)) for (const f of readdirSync(empty)) if (f.endsWith('.jsonl')) out.push(join(empty, f));
    }
    return out;
  }

  function processFile(path: string, f: FileState, out: VsCandidate[]): Cursor | null {
    const request = (req: unknown, removed: FileState['requests']): void => {
      if (!req || typeof req !== 'object') return;
      const q = req as { requestId?: unknown; timestamp?: unknown; message?: { text?: unknown }; isSystemInitiated?: unknown };
      if (typeof q.requestId !== 'string' || typeof q.timestamp !== 'number') return;
      const text = typeof q.message?.text === 'string' ? q.message.text : '';
      const hash = createHash('sha1').update(text).digest('hex'); // in memory only
      f.requests.push({ id: q.requestId, hash, at: q.timestamp });
      if (f.known.has(q.requestId)) return;
      f.known.add(q.requestId);
      out.push({
        kind: 'prompt', id: q.requestId, at: q.timestamp, system: q.isSystemInitiated === true, blank: text.trim() === '',
        runnerMarker: hasRunnerMarker(text), retry: removed.some((x) => x.hash === hash),
      });
    };
    const answers = (parts: unknown, requestAt: number | undefined): void => {
      if (requestAt === undefined) return;
      for (const p of Array.isArray(parts) ? parts : [parts]) {
        if (!p || typeof p !== 'object') continue;
        const c = p as { kind?: unknown; resolveId?: unknown; isUsed?: unknown; data?: unknown };
        if (c.kind !== 'questionCarousel' || typeof c.resolveId !== 'string' || c.isUsed !== true) continue;
        if (!c.data || typeof c.data !== 'object' || !Object.keys(c.data).length || f.resolved.has(c.resolveId)) continue;
        f.resolved.add(c.resolveId);
        out.push({ kind: 'answer', id: c.resolveId, at: requestAt });
      }
    };
    const r = readNewLines(path, f.cursor, (buf) => {
      const snapshot = startsWith(buf, SNAPSHOT);
      const push = !snapshot && startsWith(buf, PUSH_REQUESTS);
      if (!snapshot && !push && !buf.includes(CAROUSEL)) return;
      let e: { kind?: unknown; k?: unknown; v?: unknown; i?: unknown };
      try {
        e = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (snapshot) {
        const reqs = (e.v as { requests?: unknown } | undefined)?.requests;
        f.requests = [];
        if (Array.isArray(reqs)) {
          for (const q of reqs) {
            request(q, []);
            answers((q as { response?: unknown }).response, f.requests.at(-1)?.at);
          }
        }
      } else if (push) {
        const removed = typeof e.i === 'number' ? f.requests.splice(e.i) : [];
        if (Array.isArray(e.v)) for (const q of e.v) request(q, removed);
      } else if (Array.isArray(e.k) && e.k[0] === 'requests' && typeof e.k[1] === 'number') {
        answers(e.v, f.requests[e.k[1]]?.at);
      }
    }, () => {
      f.requests = [];
    });
    return r ? r.cursor : null;
  }

  return {
    poll(since, onError) {
      const out: VsCandidate[] = [];
      for (const path of listFiles()) {
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        if (st.mtimeMs < since) continue;
        const f = files.get(path);
        if (f && f.mtime === st.mtimeMs && f.size === st.size) continue;
        // Per-file isolation: work on a copy, commit only if the whole file was processed.
        const work: FileState = f
          ? { ...f, requests: [...f.requests], known: new Set(f.known), resolved: new Set(f.resolved) }
          : { cursor: null, mtime: 0, size: 0, requests: [], known: new Set(), resolved: new Set() };
        const fileOut: VsCandidate[] = [];
        try {
          const cursor = processFile(path, work, fileOut);
          if (!cursor) continue;
          files.set(path, { ...work, cursor, mtime: st.mtimeMs, size: st.size });
          out.push(...fileOut);
        } catch (e) {
          onError?.(path, e);
        }
      }
      return out;
    },
  };
}
