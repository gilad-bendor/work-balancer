// Lua ⇄ Node bridge protocol (instructions §4.4). Bump PROTOCOL_VERSION on any incompatible change; Lua shows
// "reload needed" on a mismatch.
import type { ClosedWindow, CloseBy, MenubarSpec, UiCommand } from '../core/effects.ts';
import { SYSTEM_EVENTS, type SystemEvent } from '../store/records.ts';

export const PROTOCOL_VERSION = 1;

/** A foreground interval of one app, [from, to) epoch ms (Lua clock). `to` may be the sample time of a still-open interval. */
export interface AppInterval {
  id: string;
  name: string;
  from: number;
  to: number;
  /** Focused window title (Lua 0.7+), for the categorizer only — never stored or logged (D-67). */
  title?: string;
}

/** Window titles longer than this are cut (they only feed the categorizer). */
export const MAX_TITLE = 300;

export interface SystemSample {
  event: SystemEvent;
  at: number;
}

export interface SensorSamples {
  /** Input instants (epoch ms), derived from hs.host.idleTime() sampled every second. */
  inputs: number[];
  apps: AppInterval[];
  system: SystemSample[];
  /** Screen currently locked (from hs.caffeinate.sessionProperties) — robust against missed lock/unlock events. */
  locked: boolean;
  /** Start of the span these samples cover (Lua load time, or the last acknowledged heartbeat's sentAt). */
  since: number | null;
}

export interface Heartbeat {
  protocol: number;
  /** Random per Lua load; `seq` is monotonic within it. */
  loadId: string;
  seq: number;
  sentAt: number;
  samples: SensorSamples;
  ui: {
    /** Window id → rev on screen (M7). Older Lua sent a list of ids; they map to rev "". */
    windows: Record<string, string>;
    /** Windows that went away since the last acknowledged heartbeat (re-sent until a 200; deduped by id+at). */
    closed: ClosedWindow[];
    dimmed: boolean;
    latches: { panic: boolean; quit: boolean };
    /** Who set the panic latch (`hotkey` / `cli`), when set. */
    panicBy: string | null;
    /** When the panic latch was set (epoch ms, Lua clock); the daemon decides its 04:00 expiry. */
    panicAt: number | null;
  };
  acks: string[];
}

export interface HeartbeatReply {
  protocol: number;
  serverNow: number;
  dayKey: string;
  menubar: MenubarSpec;
  commands: UiCommand[];
  duplicate: boolean;
  /** The panic latch Lua reports was set before the last 04:00: Lua clears it (R-UI-ESC). */
  panicExpired: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const CLOSE_BY: readonly CloseBy[] = ['user', 'page', 'system', 'panic', 'failopen', 'load-failed', 'reload'];

function parseWindows(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) {
    for (const id of v) if (typeof id === 'string') out[id] = '';
  } else if (isObj(v)) {
    for (const [id, rev] of Object.entries(v)) if (typeof rev === 'string') out[id] = rev;
  }
  return out;
}

/** Validates and normalises a heartbeat body; throws with a short reason. Unknown fields are ignored. */
export function parseHeartbeat(body: unknown): Heartbeat {
  if (!isObj(body)) throw new Error('body must be an object');
  if (!isNum(body.protocol)) throw new Error('protocol missing');
  if (typeof body.loadId !== 'string' || !body.loadId) throw new Error('loadId missing');
  if (!isNum(body.seq) || !isNum(body.sentAt)) throw new Error('seq/sentAt missing');
  const s = isObj(body.samples) ? body.samples : {};
  const ui = isObj(body.ui) ? body.ui : {};
  const latches = isObj(ui.latches) ? ui.latches : {};
  // Lua encodes an empty table as {} rather than [], so accept objects where arrays are expected.
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : []);
  return {
    protocol: body.protocol,
    loadId: body.loadId,
    seq: body.seq,
    sentAt: body.sentAt,
    samples: {
      inputs: arr(s.inputs).filter(isNum),
      apps: arr(s.apps).filter(
        (a): a is AppInterval => isObj(a) && typeof a.id === 'string' && typeof a.name === 'string' && isNum(a.from) && isNum(a.to) && a.to >= a.from,
      ).map((a) => {
        const { title, ...rest } = a;
        return typeof title === 'string' && title ? { ...rest, title: title.slice(0, MAX_TITLE) } : rest;
      }),
      system: arr(s.system).filter(
        (e): e is SystemSample => isObj(e) && (SYSTEM_EVENTS as readonly unknown[]).includes(e.event) && isNum(e.at),
      ),
      locked: s.locked === true,
      since: isNum(s.since) ? s.since : null,
    },
    ui: {
      windows: parseWindows(ui.windows),
      closed: arr(ui.closed).filter(
        (c): c is ClosedWindow => isObj(c) && typeof c.id === 'string' && (CLOSE_BY as readonly unknown[]).includes(c.by) && isNum(c.at),
      ).map((c) => ({ id: c.id, by: c.by, at: c.at })),
      dimmed: ui.dimmed === true,
      latches: { panic: latches.panic === true, quit: latches.quit === true },
      panicBy: typeof ui.panicBy === 'string' ? ui.panicBy : null,
      panicAt: isNum(ui.panicAt) ? ui.panicAt : null,
    },
    acks: arr(body.acks).filter((a): a is string => typeof a === 'string'),
  };
}

/** Shifts every Lua timestamp by the clock offset (non-zero only for a fake/offset dev clock). */
export function shiftSamples(s: SensorSamples, offsetMs: number): SensorSamples {
  if (!offsetMs) return s;
  return {
    inputs: s.inputs.map((t) => t + offsetMs),
    apps: s.apps.map((a) => ({ ...a, from: a.from + offsetMs, to: a.to + offsetMs })),
    system: s.system.map((e) => ({ ...e, at: e.at + offsetMs })),
    locked: s.locked,
    since: s.since === null ? null : s.since + offsetMs,
  };
}
