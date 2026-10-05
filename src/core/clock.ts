// The only place that reads the OS clock. Logic receives a Clock (instructions §3.3), so day-boundary, DST, budget and
// ladder behaviour is testable, and the dev instance can run at a fake time.

export interface Clock {
  now(): number;
  /** Added to real time. Non-zero only for a fake/offset clock; incoming Lua timestamps are shifted by it too. */
  readonly offsetMs: number;
}

export const systemClock: Clock = { now: () => Date.now(), offsetMs: 0 };

export function offsetClock(offsetMs: number, base: () => number = Date.now): Clock {
  return { now: () => base() + offsetMs, offsetMs };
}

export function fixedClock(start: number): Clock & { set(t: number): void; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    offsetMs: 0,
    set: (v) => { t = v; },
    advance: (ms) => { t += ms; },
  };
}

/** Parses WB_FAKE_NOW: epoch ms, or anything `Date.parse` accepts (e.g. `2026-10-04T21:30` = local time). */
export function parseFakeNow(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) throw new Error(`WB_FAKE_NOW: give a time too (e.g. ${value.trim()}T10:00 = local time); a bare date is read as UTC midnight`);
  const asNumber = Number(value);
  const t = Number.isFinite(asNumber) && /^\d+$/.test(value.trim()) ? asNumber : Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`WB_FAKE_NOW: cannot parse ${JSON.stringify(value)}`);
  return t;
}

/** WB_FAKE_NOW set → a clock that starts at that instant and then runs in real time. */
export function clockFromEnv(env: NodeJS.ProcessEnv, realNow: () => number = Date.now): Clock {
  const fake = env.WB_FAKE_NOW?.trim();
  if (!fake) return systemClock;
  return offsetClock(parseFakeNow(fake) - realNow(), realNow);
}
