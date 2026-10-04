// Lua ⇄ Node bridge protocol (instructions §4.4). Bump PROTOCOL_VERSION on any incompatible change; Lua shows
// "reload needed" on a mismatch.
import type { MenubarSpec, UiCommand } from '../core/effects.ts';
import { SYSTEM_EVENTS, type SystemEvent } from '../store/records.ts';

export const PROTOCOL_VERSION = 1;

/** A foreground interval of one app, [from, to) epoch ms (Lua clock). `to` may be the sample time of a still-open interval. */
export interface AppInterval {
  id: string;
  name: string;
  from: number;
  to: number;
}

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
    windows: string[];
    dimmed: boolean;
    latches: { panic: boolean; quit: boolean };
    /** Who set the panic latch (`hotkey` / `cli`), when set. */
    panicBy: string | null;
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
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
      ),
      system: arr(s.system).filter(
        (e): e is SystemSample => isObj(e) && (SYSTEM_EVENTS as readonly unknown[]).includes(e.event) && isNum(e.at),
      ),
      locked: s.locked === true,
      since: isNum(s.since) ? s.since : null,
    },
    ui: {
      windows: arr(ui.windows).filter((w): w is string => typeof w === 'string'),
      dimmed: ui.dimmed === true,
      latches: { panic: latches.panic === true, quit: latches.quit === true },
      panicBy: typeof ui.panicBy === 'string' ? ui.panicBy : null,
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
