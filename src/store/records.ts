// Record shapes and file routing. Canonical, versioned list: .github/data-format.md (keep in sync).
import type { MinuteKey } from '../core/time.ts';

export const SCHEMA_VERSION = 1;

export interface BaseRecord {
  v: number;
  ts: number;
  type: string;
}

/** Any parsed line: readers must tolerate unknown types and fields. */
export type AnyRecord = BaseRecord & { [k: string]: unknown };

export interface MinuteRecord<D = unknown> extends BaseRecord {
  type: 'minute';
  provider: string;
  minute: MinuteKey;
  data: D;
}

export const SYSTEM_EVENTS = ['sleep', 'wake', 'lock', 'unlock', 'display-sleep', 'display-wake'] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

export interface SystemRecord extends BaseRecord {
  type: 'system';
  event: SystemEvent;
}

export type GapCause = 'daemon-down' | 'quit' | 'hs-down' | 'stall';

export interface MonitorGapRecord extends BaseRecord {
  type: 'monitor.gap';
  from: number;
  to: number;
  cause: GapCause;
}

/** A record without `v` (filled by the store); `ts` defaults to the store clock's now. */
export type NewRecord = { type: string; ts?: number } & { [k: string]: unknown };

/**
 * Instant that decides which day file a record goes to (instructions §6): records *about a time* go to the day they
 * describe, even when written later; entity/action records (`null` here) go to the current day.
 */
export function aboutTime(r: NewRecord): number | null {
  switch (r.type) {
    case 'minute':
      return typeof r.minute === 'number' ? r.minute : null;
    case 'monitor.gap':
    case 'inactivity.resolved':
      return typeof r.from === 'number' ? r.from : null;
    case 'inactivity.detected':
      return typeof r.lastInputAt === 'number' ? r.lastInputAt : null;
    case 'system':
      return typeof r.ts === 'number' ? r.ts : null;
    default:
      return null;
  }
}

export function isMinuteRecord(r: AnyRecord): r is AnyRecord & MinuteRecord {
  return r.type === 'minute' && typeof r.provider === 'string' && typeof r.minute === 'number';
}

/** Last record per minute for one provider, in file/append order (late re-emissions win). */
export function lastWinsByMinute<D>(records: readonly AnyRecord[], provider: string): Map<MinuteKey, MinuteRecord<D>> {
  const out = new Map<MinuteKey, MinuteRecord<D>>();
  for (const r of records) {
    if (isMinuteRecord(r) && r.provider === provider) out.set(r.minute, r as unknown as MinuteRecord<D>);
  }
  return out;
}
