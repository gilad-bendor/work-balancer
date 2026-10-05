// The effects reconciler (instructions §4.3). PURE: desired UI + Lua's actual UI → idempotent commands.
// Re-sending a command is harmless (Lua opens an id+rev once, closes a missing id as a no-op, runs a pulse once), so
// lost replies and restarts on either side heal on the next heartbeat.
import type { DesiredUi, UiCommand, WindowSpec } from '../core/effects.ts';

export interface QuietRule {
  /** R-UI-QUIET: nothing intrusive starts within this long after the last input. */
  afterInputMs: number;
  /** … unless it has been due this long (Q-13): an owner typing non-stop cannot postpone an effect forever. */
  maxDeferMs: number;
}

export const DEFAULT_QUIET: QuietRule = { afterInputMs: 10_000, maxDeferMs: 120_000 };

export interface ReconcileInput {
  now: number;
  desired: DesiredUi;
  /** Window id → rev currently on screen (Lua's report). */
  actual: Readonly<Record<string, string>>;
  /** Pulse ids Lua has already acknowledged (never re-sent). */
  pulsesDone: ReadonlySet<string>;
  lastInputAt: number | null;
  quiet: QuietRule;
  /** Key (`win:<id>` / `dim:<pulseId>`) → when it first became due but could not start. Carried between beats. */
  dueSince: ReadonlyMap<string, number>;
  /** Lua's panic latch (or the daemon's view of it): nothing intrusive at all. */
  panic: boolean;
  /** Window ids already on screen earlier today: re-appearing (reload, lost window) is never deferred — otherwise a
   * reload while typing would lift a block for up to maxDefer. */
  shownToday?: ReadonlySet<string>;
}

export interface ReconcileOutput {
  commands: UiCommand[];
  dueSince: Map<string, number>;
  /** Keys held back by R-UI-QUIET this beat (diagnostics). */
  deferred: string[];
}

export function reconcile(i: ReconcileInput): ReconcileOutput {
  const commands: UiCommand[] = [];
  const dueSince = new Map<string, number>();
  const deferred: string[] = [];
  const windows = i.panic ? i.desired.windows.filter((w) => !w.intrusive) : i.desired.windows;
  const dims = i.panic ? [] : i.desired.dims;
  const quietNow = i.lastInputAt !== null && i.now - i.lastInputAt < i.quiet.afterInputMs;

  /** True if a new intrusive thing may start now; records when it became due otherwise. */
  const mayStart = (key: string): boolean => {
    const since = i.dueSince.get(key) ?? i.now;
    if (!quietNow || i.now - since >= i.quiet.maxDeferMs) return true;
    dueSince.set(key, since);
    deferred.push(key);
    return false;
  };

  const wanted = new Map<string, WindowSpec>(windows.map((w) => [w.id, w]));
  for (const id of Object.keys(i.actual).sort()) {
    if (!wanted.has(id)) commands.push({ id: `close:${id}`, op: 'window.close', windowId: id });
  }
  for (const w of windows) {
    const rev = i.actual[w.id];
    if (rev === w.rev) continue;
    // An update of a window already on screen is not a new effect: never deferred.
    if (rev === undefined && w.intrusive && !i.shownToday?.has(w.id) && !mayStart(`win:${w.id}`)) continue;
    commands.push({ id: `open:${w.id}:${w.rev}`, op: 'window.open', window: w });
  }
  for (const d of dims) {
    if (i.pulsesDone.has(d.pulseId)) continue;
    if (!mayStart(`dim:${d.pulseId}`)) continue;
    commands.push({ id: `dim:${d.pulseId}`, op: 'dim', dim: d });
  }
  return { commands, dueSince, deferred };
}
