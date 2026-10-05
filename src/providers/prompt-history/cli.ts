// S-CLI: ~/.copilot/session-state/<id>/events.jsonl (append-only, F-COP-7). Emits prompt/answer candidates with the
// facts the classifier needs. Text is only looked at in memory (runner markers, retry hashes) — never kept as text.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readNewLines, startsWith, type Cursor } from './files.ts';
import { hasRunnerMarker } from './markers.ts';

export interface CliPrompt {
  kind: 'prompt';
  id: string;
  sessionId: string;
  at: number;
  clientName: string | null;
  subagent: boolean;
  system: boolean;
  runnerMarker: boolean;
  /** Same text as the previous main prompt of the session, < 15 min earlier (C5). */
  retryOfPrev: boolean;
  /** The session's first main-agent prompt (decides "runner-launched", C3/C4). */
  firstMain: boolean;
  duplicate: boolean;
}

export interface CliAnswer {
  kind: 'answer';
  id: string;
  sessionId: string;
  at: number;
  answered: boolean;
  duplicate: boolean;
}

export type CliCandidate = CliPrompt | CliAnswer;

const RETRY_WINDOW_MS = 15 * 60_000;
const MSG = Buffer.from('{"type":"user.message"');
const START = Buffer.from('{"type":"tool.execution_start"');
const COMPLETE = Buffer.from('{"type":"tool.execution_complete"');
const ASK_USER = Buffer.from('"toolName":"ask_user"');

interface SessionState {
  cursor: Cursor | null;
  mtime: number;
  size: number;
  clientName: string | null;
  /** From workspace.yaml: the scan goes oldest session first, so the original of a copied session wins C0. */
  createdAt: number;
  mainCount: number;
  prevMain: { hash: string; at: number } | null;
  pendingAsks: Set<string>;
}

export interface CliReader {
  /** Reads new lines of session files modified at/after `since`. `seen` = global event ids (C0, copied sessions). */
  poll(since: number, seen: Set<string>, onError?: (sessionId: string, e: unknown) => void): CliCandidate[];
  clientName(sessionId: string): string | null;
}

export function createCliReader(opts: { dir: string }): CliReader {
  const sessions = new Map<string, SessionState>();

  function readWorkspace(sessionId: string): { clientName: string | null; createdAt: number } {
    try {
      const yaml = readFileSync(join(opts.dir, sessionId, 'workspace.yaml'), 'utf8');
      const client = /^client_name:\s*(.+?)\s*$/m.exec(yaml);
      const created = /^created_at:\s*(\S+)\s*$/m.exec(yaml);
      return { clientName: client ? client[1]! : null, createdAt: created ? Date.parse(created[1]!) || Infinity : Infinity };
    } catch {
      return { clientName: null, createdAt: Infinity };
    }
  }

  /** Processes one file. Mutates only the given working copies; the caller commits them on success. */
  function processLine(sessionId: string, s: SessionState, buf: Buffer, isSeen: (id: string) => boolean, markSeen: (id: string) => void, out: CliCandidate[]): void {
    const isMsg = startsWith(buf, MSG);
    const isStart = !isMsg && startsWith(buf, START) && buf.includes(ASK_USER);
    const isComplete = !isMsg && !isStart && s.pendingAsks.size > 0 && startsWith(buf, COMPLETE) &&
      [...s.pendingAsks].some((id) => buf.includes(`"toolCallId":"${id}"`));
    if (!isMsg && !isStart && !isComplete) return;
    let e: { type?: unknown; data?: Record<string, unknown>; id?: unknown; timestamp?: unknown; agentId?: unknown };
    try {
      e = JSON.parse(buf.toString('utf8'));
    } catch {
      return; // format drift: skip, never crash (and never log the line: it may hold text)
    }
    const data = e.data ?? {};
    const id = typeof e.id === 'string' ? e.id : null;
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!id || !Number.isFinite(at)) return;
    const duplicate = isSeen(id);
    markSeen(id);
    if (isMsg) {
      const source = typeof data.source === 'string' ? data.source : null;
      const subagent = typeof e.agentId === 'string' || (source?.startsWith('agent-') ?? false);
      const content = typeof data.content === 'string' ? data.content : '';
      const system = !subagent && (source !== null || content.trim() === '');
      let retryOfPrev = false;
      let firstMain = false;
      if (!subagent && !system) {
        const hash = createHash('sha1').update(content).digest('hex'); // in memory only
        retryOfPrev = s.prevMain !== null && s.prevMain.hash === hash && at - s.prevMain.at < RETRY_WINDOW_MS && at >= s.prevMain.at;
        firstMain = s.mainCount === 0;
        s.mainCount++;
        s.prevMain = { hash, at };
      }
      out.push({ kind: 'prompt', id, sessionId, at, clientName: s.clientName, subagent, system, runnerMarker: hasRunnerMarker(content), retryOfPrev, firstMain, duplicate });
    } else if (isStart) {
      if (typeof data.toolCallId === 'string') s.pendingAsks.add(data.toolCallId);
    } else {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : null;
      if (!callId || !s.pendingAsks.has(callId)) return;
      s.pendingAsks.delete(callId);
      const props = ((data.toolTelemetry as Record<string, unknown> | undefined)?.properties ?? {}) as Record<string, unknown>;
      const answered = props.outcome === 'answered' || props.elicitation_action === 'accept';
      out.push({ kind: 'answer', id, sessionId, at, answered, duplicate });
    }
  }

  return {
    poll(since, seen, onError) {
      const out: CliCandidate[] = [];
      if (!existsSync(opts.dir)) return out;
      const changed: { sessionId: string; path: string; mtime: number; size: number; s: SessionState }[] = [];
      for (const sessionId of readdirSync(opts.dir)) {
        const path = join(opts.dir, sessionId, 'events.jsonl');
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        if (st.mtimeMs < since) continue;
        let s = sessions.get(sessionId);
        if (s && s.mtime === st.mtimeMs && s.size === st.size) continue;
        if (!s) {
          s = { cursor: null, mtime: 0, size: 0, ...readWorkspace(sessionId), mainCount: 0, prevMain: null, pendingAsks: new Set() };
          sessions.set(sessionId, s);
        }
        changed.push({ sessionId, path, mtime: st.mtimeMs, size: st.size, s });
      }
      changed.sort((a, b) => a.s.createdAt - b.s.createdAt || a.sessionId.localeCompare(b.sessionId));
      for (const { sessionId, path, mtime, size, s } of changed) {
        // Per-file isolation: work on copies; commit state, seen ids and candidates only if the whole file succeeded.
        const work: SessionState = { ...s, pendingAsks: new Set(s.pendingAsks) };
        const fileSeen = new Set<string>();
        const fileOut: CliCandidate[] = [];
        try {
          const r = readNewLines(
            path, s.cursor,
            (line) => processLine(sessionId, work, line, (id) => seen.has(id) || fileSeen.has(id), (id) => fileSeen.add(id), fileOut),
            () => Object.assign(work, { mainCount: 0, prevMain: null, pendingAsks: new Set<string>() }), // ids dedupe the replay
          );
          if (!r) continue;
          Object.assign(s, work, { cursor: r.cursor, mtime, size });
          for (const id of fileSeen) seen.add(id);
          out.push(...fileOut);
        } catch (e) {
          onError?.(sessionId, e);
        }
      }
      return out;
    },
    clientName: (sessionId) => sessions.get(sessionId)?.clientName ?? null,
  };
}
