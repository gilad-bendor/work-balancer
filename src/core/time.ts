// Time model (ledger R-TIME-1/2, instructions §6). Day key = the 04:00-bounded local civil day.
// Always calendar arithmetic on local civil dates — never `t − 4 h` (wrong on DST days) and never "24 × 60 minutes".

/** Epoch ms floored to a whole minute. */
export type MinuteKey = number;
/** `YYYY-MM-DD` of the 04:00-bounded day. */
export type DayKey = string;

export const MINUTE_MS = 60_000;
export const DAY_START_HOUR = 4;

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function minuteKey(t: number): MinuteKey {
  return Math.floor(t / MINUTE_MS) * MINUTE_MS;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function civil(y: number, m0: number, d: number): DayKey {
  // Normalise overflow (e.g. day 0, day 32) through UTC — pure calendar arithmetic, no time zone involved.
  const u = new Date(Date.UTC(y, m0, d));
  return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
}

export function parseDayKey(key: DayKey): { y: number; m0: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`bad day key: ${key}`);
  return { y: Number(m[1]), m0: Number(m[2]) - 1, d: Number(m[3]) };
}

export function dayKey(t: number): DayKey {
  const local = new Date(t);
  const shift = local.getHours() < DAY_START_HOUR ? -1 : 0;
  return civil(local.getFullYear(), local.getMonth(), local.getDate() + shift);
}

export function addDays(key: DayKey, n: number): DayKey {
  const { y, m0, d } = parseDayKey(key);
  return civil(y, m0, d + n);
}

/** Local civil 04:00 of the key's date. */
export function dayStart(key: DayKey): number {
  const { y, m0, d } = parseDayKey(key);
  return new Date(y, m0, d, DAY_START_HOUR, 0, 0, 0).getTime();
}

/** Exclusive end = next day's start (23 h or 25 h on DST days). */
export function dayEnd(key: DayKey): number {
  return dayStart(addDays(key, 1));
}

export function weekday(key: DayKey): Weekday {
  const { y, m0, d } = parseDayKey(key);
  return WEEKDAYS[new Date(Date.UTC(y, m0, d)).getUTCDay()]!;
}

/** Day key of the Sunday that starts the key's week (week = Sun 04:00 → next Sun 04:00). */
export function weekStartKey(key: DayKey): DayKey {
  return addDays(key, -WEEKDAYS.indexOf(weekday(key)));
}

/** Day keys from `from` to `to`, both inclusive. */
export function dayKeysBetween(from: DayKey, to: DayKey): DayKey[] {
  const out: DayKey[] = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
}

/** `h:mm`, floored (R-INFO-3). */
export function formatHM(seconds: number): string {
  const totalMin = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(totalMin / 60)}:${pad(totalMin % 60)}`;
}
