// S-AH: the VS Code agent-host turn index (F-COP-6). Per CLI session id: event id → turn id. `request_*` turns come from
// the VS Code chat UI (the owner); bare UUIDs from execute-copilot-session or other AHP clients.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../../core/log.ts';

export interface TurnIndex {
  /** Re-reads dbs whose db/-wal changed since the last refresh (only dbs touched at/after `since`). */
  refresh(since: number): void;
  /** undefined = no turn index at all for this session; null = indexed session, but no row for this event (yet). */
  turnFor(sessionId: string, eventId: string): string | null | undefined;
}

interface DbState {
  mtime: number;
  sdkSessionId: string | null;
  turns: Map<string, string>;
}

// The dbs use a rollback journal (not WAL). A normal read-only connection holds a SHARED lock that can make VS Code's
// commit fail with SQLITE_BUSY, so they are opened with `mode=ro&nolock=1` (no locks; only the needed pages are read,
// nothing is copied). Without locks a read can race a commit: it is discarded (retried next poll) when a hot
// `-journal` exists or the file changed between open and close.
export function createTurnIndex(opts: { dir: string; log: Logger }): TurnIndex {
  const dbs = new Map<string, DbState>();
  let bySession = new Map<string, Map<string, string>>();

  const stat = (p: string): { mtime: number; size: number } | null => {
    try {
      const st = statSync(p);
      return { mtime: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  };

  function readDb(path: string): Omit<DbState, 'mtime'> | null {
    let db: DatabaseSync | null = null;
    try {
      if (existsSync(`${path}-journal`)) return null; // a commit is in flight
      const before = stat(path);
      const url = pathToFileURL(path);
      url.search = '?mode=ro&nolock=1';
      db = new DatabaseSync(url, { readOnly: true });
      let sdkSessionId: string | null = null;
      for (const row of db.prepare("SELECT key, value FROM session_metadata WHERE key IN ('defaultChatProviderData', 'agentHost.chatProviderData')").all()) {
        try {
          const v = JSON.parse(String((row as { value: unknown }).value)) as { sdkSessionId?: unknown };
          if (typeof v.sdkSessionId === 'string') sdkSessionId = v.sdkSessionId;
        } catch {
          // unknown shape
        }
      }
      const turns = new Map<string, string>();
      for (const row of db.prepare('SELECT id, event_id FROM turns WHERE event_id IS NOT NULL').all()) {
        const r = row as { id: unknown; event_id: unknown };
        if (typeof r.id === 'string' && typeof r.event_id === 'string') turns.set(r.event_id, r.id);
      }
      db.close();
      db = null;
      const after = stat(path);
      if (!before || !after || before.mtime !== after.mtime || before.size !== after.size || existsSync(`${path}-journal`)) return null;
      return { sdkSessionId, turns };
    } catch (e) {
      opts.log.debug('turn index: cannot read db (retried next poll)', { path, error: (e as Error).message });
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  return {
    refresh(since) {
      if (!existsSync(opts.dir)) return;
      let changed = false;
      for (const name of readdirSync(opts.dir)) {
        const path = join(opts.dir, name, 'session.db');
        const mtime = stat(path)?.mtime ?? 0;
        if (!mtime || mtime < since) continue;
        if (dbs.get(path)?.mtime === mtime) continue;
        const state = readDb(path);
        if (!state) continue; // keep the previous state; retried next poll
        dbs.set(path, { mtime, ...state });
        changed = true;
      }
      if (!changed) return;
      // Several dbs may name the same SDK session (a chat-backing db without turns): merge, never overwrite.
      const next = new Map<string, Map<string, string>>();
      for (const { sdkSessionId, turns } of dbs.values()) {
        if (!sdkSessionId) continue;
        const m = next.get(sdkSessionId) ?? new Map<string, string>();
        for (const [e, t] of turns) m.set(e, t);
        next.set(sdkSessionId, m);
      }
      bySession = next;
    },
    turnFor(sessionId, eventId) {
      const m = bySession.get(sessionId);
      if (!m) return undefined;
      return m.get(eventId) ?? null;
    },
  };
}
