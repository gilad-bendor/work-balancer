// Effects manager: collects every effect's desired windows/dims, applies the live gate, reconciles against Lua's
// report on each heartbeat, logs `effect.shown`/`effect.closed` for audited effects, and serves the page API.
import { createHash } from 'node:crypto';
import type { Logger } from '../core/log.ts';
import type { ActualUi, CloseBy, DesiredUi, DimSpec, Effect, UiCommand, WindowSpec } from '../core/effects.ts';
import type { Route } from '../bridge/server.ts';
import type { Store } from '../store/store.ts';
import { reconcile, type QuietRule } from './reconcile.ts';
import { pageStrings } from '../ui/strings.ts';
import { addDays, dayKey } from '../core/time.ts';

export interface EffectsManager {
  register(effect: Effect): void;
  /** One heartbeat: digest Lua's report, return the commands for the reply. */
  heartbeat(input: { actual: ActualUi; acks: readonly string[]; panic: boolean; now: number }): UiCommand[];
  desired(now: number): DesiredUi;
  routes(): Route[];
  status(now: number): unknown;
}

export interface EffectsDeps {
  env: 'live' | 'dev';
  store: Store;
  log: Logger;
  now: () => number;
  /** Live gate: system-initiated effects are off in `live` until the owner enables them (ledger D-48). */
  gateOpen: () => boolean;
  lastInputAt: (now: number) => number | null;
  quiet: () => QuietRule;
  /** Opacity of screen-covering windows (config `overlayOpacity`). */
  overlayOpacity?: () => number;
}

const MAX_REMEMBERED = 500;

export const windowRev = (w: object): string => createHash('sha1').update(JSON.stringify(w)).digest('hex').slice(0, 10);

/** Effect name of a window id (`block:main` → `block`). */
export const effectOf = (windowId: string): string => windowId.split(':')[0]!;

function remember(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > MAX_REMEMBERED) set.delete(set.values().next().value!);
}

export function createEffectsManager(deps: EffectsDeps): EffectsManager {
  const effects = new Map<string, Effect>();
  let dueSince = new Map<string, number>();
  let deferred: string[] = [];
  let actual: ActualUi = { windows: {}, dimmed: false, closed: [] };
  const pulsesDone = new Set<string>();
  let adopted = false;
  let focusSeq = 0;
  const closedSeen = new Set<string>();
  const warnedIds = new Set<string>();
  /** Window ids seen on screen today (R-UI-QUIET never defers their re-appearance). */
  let shownDay = '';
  let shownToday = new Set<string>();
  /** Audited windows whose last record is `effect.shown` — rebuilt from yesterday + today, so restarts don't re-log. */
  const openAudited = new Set<string>();
  {
    const today = dayKey(deps.now());
    for (const r of deps.store.readDays?.(addDays(today, -1), today) ?? []) {
      if (typeof r.windowId !== 'string') continue;
      if (r.type === 'effect.shown') openAudited.add(r.windowId);
      else if (r.type === 'effect.closed') openAudited.delete(r.windowId);
    }
  }

  function desired(now: number): DesiredUi {
    const gate = deps.gateOpen();
    const windows: WindowSpec[] = [];
    const dims: DimSpec[] = [];
    for (const e of effects.values()) {
      let d: ReturnType<Effect['desired']>;
      try {
        d = e.desired(now);
      } catch (err) {
        // Fail open: a broken effect shows nothing (principle 5).
        deps.log.error('effect.desired failed', { effect: e.name, error: err as Error });
        continue;
      }
      const open = gate || e.gateExempt === true;
      for (const raw of d.windows) {
        // Anything that covers a screen captures all input: always treated as intrusive (gate, panic, quiet).
        // A user-initiated window must not cover a screen (ui-and-tone.md §2): said loudly, then treated as intrusive.
        const covers = raw.mode === 'overlay' || raw.placement === 'full';
        if (covers && !raw.intrusive && !warnedIds.has(`cover:${raw.id}`)) {
          deps.log.warn('a non-intrusive window covers the screen — treated as intrusive (gated, deferred, panic-able)', { id: raw.id });
          remember(warnedIds, `cover:${raw.id}`);
        }
        const w = covers && !raw.intrusive ? { ...raw, intrusive: true } : raw;
        if (effectOf(w.id) !== e.name) {
          if (!warnedIds.has(w.id)) deps.log.warn('window id not prefixed by its effect — ignored', { effect: e.name, id: w.id });
          remember(warnedIds, w.id);
          continue;
        }
        if (w.intrusive && !open) continue;
        const opacity = covers ? (deps.overlayOpacity?.() ?? 1) : undefined;
        const spec = opacity !== undefined && opacity < 1 ? { ...w, opacity } : w;
        windows.push({ ...spec, rev: windowRev(spec) });
      }
      if (open) dims.push(...d.dims);
    }
    return { windows, dims };
  }

  function audit(type: 'effect.shown' | 'effect.closed', windowId: string, by?: CloseBy): void {
    const e = effects.get(effectOf(windowId));
    if (!e?.audit) return;
    if (type === 'effect.shown') {
      if (openAudited.has(windowId)) return;
      openAudited.add(windowId);
    } else {
      if (!openAudited.has(windowId)) {
        // Lua reports a close for a window never reported as shown (closed within one beat of opening): it was shown.
        if (by === 'reload' || by === undefined) return;
        deps.store.append({ type: 'effect.shown', effect: e.name, windowId });
      }
      openAudited.delete(windowId);
    }
    deps.store.append(by ? { type, effect: e.name, windowId, by } : { type, effect: e.name, windowId });
  }

  function heartbeat({ actual: next, acks, panic, now }: Parameters<EffectsManager['heartbeat']>[0]): UiCommand[] {
    for (const a of acks) if (a.startsWith('dim:')) remember(pulsesDone, a.slice(4));
    for (const c of next.closed) {
      const key = `${c.id}@${c.at}`;
      if (closedSeen.has(key)) continue;
      remember(closedSeen, key);
      audit('effect.closed', c.id, c.by);
      // Closed on purpose: its next appearance is a new effect (R-UI-QUIET applies again). Only involuntary losses
      // (reload, fail-open, load failure) re-appear without deferral.
      if (c.by === 'user' || c.by === 'page' || c.by === 'system' || c.by === 'panic') shownToday.delete(c.id);
      const e = effects.get(effectOf(c.id));
      try {
        e?.closed?.(c.id, c.by, now);
      } catch (err) {
        deps.log.error('effect.closed failed', { id: c.id, error: err as Error });
      }
    }
    // Audited windows that vanished without a close report: Lua reloaded (its windows died with it).
    for (const id of [...openAudited]) {
      if (id in next.windows) continue;
      audit('effect.closed', id, 'reload');
      try {
        effects.get(effectOf(id))?.closed?.(id, 'reload', now);
      } catch (err) {
        deps.log.error('effect.closed failed', { id, error: err as Error });
      }
    }
    for (const id of Object.keys(next.windows)) audit('effect.shown', id);
    actual = next;
    if (!adopted) {
      adopted = true;
      // A restarted daemon must not close windows the owner opened (or is typing in): their effects adopt them.
      for (const e of effects.values()) {
        const ids = Object.keys(next.windows).filter((id) => effectOf(id) === e.name);
        if (ids.length && e.adopt) {
          try {
            e.adopt(ids, now);
          } catch (err) {
            deps.log.error('effect.adopt failed', { effect: e.name, error: err as Error });
          }
        }
      }
    }
    const day = dayKey(now);
    if (day !== shownDay) {
      shownDay = day;
      shownToday = new Set();
    }
    for (const id of Object.keys(next.windows)) shownToday.add(id);
    const r = reconcile({
      now, desired: desired(now), actual: next.windows, pulsesDone, lastInputAt: deps.lastInputAt(now), quiet: deps.quiet(), dueSince, panic, shownToday,
    });
    dueSince = r.dueSince;
    deferred = r.deferred;
    const focus: UiCommand[] = [];
    for (const e of effects.values()) {
      let ids: string[] = [];
      try {
        ids = e.focusRequests?.() ?? [];
      } catch (err) {
        deps.log.error('effect.focusRequests failed', { effect: e.name, error: err as Error });
      }
      for (const id of ids) {
        // Only for a window already on screen: a window being opened takes focus by its own spec.
        if (effectOf(id) === e.name && id in next.windows) focus.push({ id: `focus:${id}:${++focusSeq}`, op: 'window.focus', windowId: id });
      }
    }
    return [...r.commands, ...focus];
  }

  const effectFor = (win: unknown): Effect | null => (typeof win === 'string' ? (effects.get(effectOf(win)) ?? null) : null);

  function routes(): Route[] {
    return [
      {
        method: 'GET', path: '/api/ui/strings', auth: true,
        handle: () => ({ json: { env: deps.env, strings: pageStrings } }),
      },
      {
        method: 'GET', path: '/api/ui/model', auth: true,
        handle: ({ query }) => {
          const win = query.get('win');
          const e = effectFor(win);
          if (!e || !win) return { status: 404, json: { error: 'unknown window' } };
          return { json: { env: deps.env, windowId: win, model: e.model?.(win, deps.now()) ?? null } };
        },
      },
      {
        method: 'POST', path: '/api/ui/action', auth: true,
        handle: ({ body }) => {
          const b = (body && typeof body === 'object' ? body : {}) as { win?: unknown; action?: unknown; payload?: unknown };
          const e = effectFor(b.win);
          if (!e?.action || typeof b.action !== 'string') return { status: 404, json: { ok: false, error: 'unknown window or action' } };
          return { json: e.action(b.win as string, b.action, b.payload ?? null, deps.now()) };
        },
      },
      {
        // A menu click (Lua). Only user-initiated effects answer requests; Lua pushes a heartbeat right after.
        method: 'POST', path: '/bridge/ui-request', auth: true,
        handle: ({ body }) => {
          const open = body && typeof body === 'object' ? (body as { open?: unknown }).open : undefined;
          const e = typeof open === 'string' ? effects.get(open) : undefined;
          if (!e?.request) return { status: 404, json: { ok: false, error: 'unknown request' } };
          e.request(deps.now());
          return { json: { ok: true } };
        },
      },
      {
        method: 'GET', path: '/api/ui/state', auth: true,
        handle: () => ({ json: status(deps.now()) }),
      },
    ];
  }

  function status(now: number) {
    return { gateOpen: deps.gateOpen(), desired: desired(now), actual, deferred, effects: [...effects.keys()] };
  }

  return {
    register(effect) {
      if (effects.has(effect.name)) throw new Error(`effect ${effect.name} registered twice`);
      effects.set(effect.name, effect);
    },
    heartbeat,
    desired,
    routes,
    status,
  };
}
