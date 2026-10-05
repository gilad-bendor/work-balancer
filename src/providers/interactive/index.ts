// `interactive` provider (raw; ledger R-INFO-2): per-minute input, foreground apps, lock/sleep — from Lua's sensor
// samples. Persists one `minute` record per monitored minute (data-format.md §3.1); re-emits a minute's full record
// when late samples change it (readers take the last record per minute).
import type { PerMinuteInfoProvider, TimeRangeInfoProvider } from '../../core/registry.ts';
import { clip, normalize, overlap, subtract, type Interval } from '../../core/intervals.ts';
import { dayKey, MINUTE_MS, minuteKey, type MinuteKey } from '../../core/time.ts';
import type { Logger } from '../../core/log.ts';
import type { Store } from '../../store/store.ts';
import { isMinuteRecord, type AnyRecord, type SystemEvent } from '../../store/records.ts';
import type { SensorSamples } from '../../bridge/protocol.ts';
import type { WorkSource } from '../work/index.ts';

export const PROVIDER = 'interactive';
/** Input instants closer than this are one run (the sampler runs every second). */
export const RUN_JOIN_MS = 2000;
/** A minute is written once it is this old (lets the heartbeat carrying its last samples arrive). */
export const FINALIZE_AFTER_MS = 70_000;
const APP_MIN_SECONDS = 5;
/** Input/unlock this long after an unmatched sleep event means the wake event was missed. */
export const SYNTHETIC_WAKE_AFTER_MS = 60_000;
/** The heartbeat's `locked` flag lags real lock/unlock events (the immediate push after an unlock still says
 * locked): it only repairs the timeline when the newest lock/unlock event is older than this. */
export const LOCK_FLAG_GRACE_MS = 10_000;
const TOP_APPS = 3;

export interface TopApp {
  id: string;
  name: string;
  s: number;
}

export interface InteractiveMinute {
  /** Input runs inside the minute, as [fromOffsetMs, toOffsetMs] (closed) relative to the minute. */
  inputs: [number, number][];
  activeSeconds: number;
  lastInputAt: number | null;
  topApps: TopApp[];
  lockedSeconds: number;
  asleepSeconds: number;
}

export interface InteractiveRange {
  monitoredMinutes: number;
  activeSeconds: number;
  firstInputAt: number | null;
  lastInputAt: number | null;
  topApps: TopApp[];
  lockedSeconds: number;
  asleepSeconds: number;
}

declare module '../../core/registry.ts' {
  interface ProviderTypeMap {
    interactive: { minute: InteractiveMinute; range: InteractiveRange };
  }
}

export interface InteractiveProvider extends PerMinuteInfoProvider<InteractiveMinute>, TimeRangeInfoProvider<InteractiveRange> {
  /** Startup: fold persisted `minute` (this provider) and `system` records. */
  load(records: readonly AnyRecord[]): void;
  /** Idempotent: re-sent samples change nothing. `since..sentAt` is the span Lua covered with these samples. */
  ingest(samples: SensorSamples, cover: { since: number; until: number }, receivedAt: number): void;
  /** Writes finalized minutes that are new or changed (`all`: also the current, partial minute — on shutdown). */
  flushMinutes(now: number, opts?: { all?: boolean }): number;
  /** End of the latest covered span (persisted or live), or null when nothing is known. */
  coverageEnd(): number | null;
  /** Locked ∪ asleep inside [from, to). */
  blocked(from: number, to: number): Interval[];
  /** Forget raw state before `t` (keeps memory bounded; the week's data stays). */
  prune(t: number): void;
  workSource: WorkSource;
}

/** Compact on disk: zero/empty/null fields are omitted (readers default them). */
export function encodeMinute(m: InteractiveMinute): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (m.inputs.length) o.inputs = m.inputs;
  if (m.activeSeconds) o.activeSeconds = m.activeSeconds;
  if (m.lastInputAt !== null) o.lastInputAt = m.lastInputAt;
  if (m.topApps.length) o.topApps = m.topApps;
  if (m.lockedSeconds) o.lockedSeconds = m.lockedSeconds;
  if (m.asleepSeconds) o.asleepSeconds = m.asleepSeconds;
  return o;
}

export function decodeMinute(data: unknown): InteractiveMinute {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const inputs = Array.isArray(d.inputs)
    ? d.inputs.filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'number'))
    : [];
  const topApps = Array.isArray(d.topApps)
    ? d.topApps.filter((a): a is TopApp => !!a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.s === 'number')
    : [];
  return {
    inputs,
    activeSeconds: num(d.activeSeconds, 0),
    lastInputAt: typeof d.lastInputAt === 'number' ? d.lastInputAt : null,
    topApps,
    lockedSeconds: num(d.lockedSeconds, 0),
    asleepSeconds: num(d.asleepSeconds, 0),
  };
}

interface TimelineEvent {
  event: SystemEvent;
  at: number;
}

export function createInteractiveProvider(opts: { store: Store; log: Logger; now: () => number }): InteractiveProvider {
  const { store, log } = opts;
  // Input runs, stored padded: run [a, b] ⇔ [a, b + RUN_JOIN_MS), so normalize() joins instants ≤ RUN_JOIN_MS apart.
  let padded: Interval[] = [];
  const apps = new Map<string, { name: string; list: Interval[] }>();
  let events: TimelineEvent[] = [];
  const eventKeys = new Set<string>();
  let coverage: Interval[] = [];
  /** Last persisted record per minute (loaded or written by us). */
  const written = new Map<MinuteKey, InteractiveMinute>();
  /** Minutes loaded from disk: their topApps are kept (raw app intervals are not persisted). */
  const loadedBase = new Map<MinuteKey, InteractiveMinute>();
  let dirtyFrom = Infinity;
  let version = 0;
  let blockedCache: { version: number; locked: Interval[]; asleep: Interval[] } | null = null;
  /** System events whose write failed — retried on the next flush (never lose a lock/sleep). */
  let unsaved: TimelineEvent[] = [];

  const runs = (from: number, to: number): Interval[] =>
    padded.filter(([a, pb]) => pb - RUN_JOIN_MS >= from && a < to).map(([a, pb]) => [a, pb - RUN_JOIN_MS] as const);

  function timelines(): { locked: Interval[]; asleep: Interval[] } {
    if (blockedCache?.version === version) return blockedCache;
    const locked: Interval[] = [];
    const asleep: Interval[] = [];
    let lockedSince: number | null = null;
    let asleepSince: number | null = null;
    for (const e of events) {
      if (e.event === 'lock' && lockedSince === null) lockedSince = e.at;
      else if (e.event === 'unlock' && lockedSince !== null) { locked.push([lockedSince, e.at]); lockedSince = null; }
      else if (e.event === 'sleep' && asleepSince === null) asleepSince = e.at;
      else if (e.event === 'wake' && asleepSince !== null) { asleep.push([asleepSince, e.at]); asleepSince = null; }
    }
    if (lockedSince !== null) locked.push([lockedSince, Infinity]);
    if (asleepSince !== null) asleep.push([asleepSince, Infinity]);
    blockedCache = { version, locked: normalize(locked), asleep: normalize(asleep) };
    return blockedCache;
  }

  const isLockedAt = (t: number): boolean => timelines().locked.some(([a, b]) => a <= t && t < b);

  function addEvent(e: TimelineEvent, persist: boolean): void {
    const key = `${e.event}@${e.at}`;
    if (eventKeys.has(key)) return;
    eventKeys.add(key);
    events.push(e);
    events.sort((x, y) => x.at - y.at);
    version++;
    dirtyFrom = Math.min(dirtyFrom, e.at);
    if (persist && !store.append({ type: 'system', ts: e.at, event: e.event })) unsaved.push(e);
  }

  function compute(m: MinuteKey): InteractiveMinute {
    const end = m + MINUTE_MS;
    // Open lock/sleep intervals run to Infinity: never count the future (a partial minute flushed at shutdown).
    const now = opts.now();
    const { locked: allLocked, asleep: allAsleep } = timelines();
    const locked = clip(allLocked, -Infinity, now);
    const asleep = clip(allAsleep, -Infinity, now);
    const blocked = normalize([...clip(locked, m, end), ...clip(asleep, m, end)]);
    const inMinute = runs(m, end).map(([a, b]) => [Math.max(a, m), Math.min(b, end - 1)] as [number, number]);
    const seconds = new Set<number>();
    for (const [a, b] of inMinute) for (let s = Math.floor(a / 1000); s <= Math.floor(b / 1000); s++) seconds.add(s);
    const appSeconds: TopApp[] = [];
    for (const [id, { name, list }] of apps) {
      const fg = clip(list, m, end);
      if (!fg.length) continue;
      const s = Math.round((overlap(fg, m, end) - overlapOf(fg, blocked)) / 1000);
      appSeconds.push({ id, name, s });
    }
    const base = loadedBase.get(m);
    if (base) {
      for (const b of base.topApps) {
        const live = appSeconds.find((a) => a.id === b.id);
        if (!live) appSeconds.push({ ...b });
        else live.s = Math.max(live.s, b.s);
      }
    }
    const topApps = appSeconds.filter((a) => a.s >= APP_MIN_SECONDS).sort((x, y) => y.s - x.s || x.id.localeCompare(y.id)).slice(0, TOP_APPS);
    return {
      inputs: inMinute.map(([a, b]) => [a - m, b - m]),
      activeSeconds: Math.min(60, seconds.size),
      lastInputAt: inMinute.length ? inMinute[inMinute.length - 1]![1] : null,
      topApps,
      lockedSeconds: Math.round(overlap(locked, m, end) / 1000),
      asleepSeconds: Math.round(overlap(asleep, m, end) / 1000),
    };
  }

  const covered = (m: MinuteKey): boolean => overlap(coverage, m, m + MINUTE_MS) > 0;
  const blockedIn = (from: number, to: number): Interval[] => {
    const { locked, asleep } = timelines();
    return normalize([...clip(locked, from, to), ...clip(asleep, from, to)]);
  };
  const fullyAsleep = (m: MinuteKey): boolean => overlap(timelines().asleep, m, m + MINUTE_MS) >= MINUTE_MS;
  // This provider's choice of which minutes are worth a record (D-31): none for a minute without input that was
  // entirely locked/asleep — the lock/sleep `system` records already describe it.
  const skippable = (m: MinuteKey, rec: InteractiveMinute): boolean => !rec.inputs.length && overlap(blockedIn(m, m + MINUTE_MS), m, m + MINUTE_MS) >= MINUTE_MS;

  const provider: InteractiveProvider = {
    name: PROVIDER,
    dependsOn: [],

    load(records) {
      for (const r of records) {
        if (isMinuteRecord(r) && r.provider === PROVIDER) {
          const d = decodeMinute(r.data);
          written.set(r.minute, d);
          loadedBase.set(r.minute, d);
          coverage.push([r.minute, r.minute + MINUTE_MS]);
          for (const [a, b] of d.inputs) padded.push([r.minute + a, r.minute + b + RUN_JOIN_MS]);
        } else if (r.type === 'system' && typeof r.event === 'string') {
          addEvent({ event: r.event as SystemEvent, at: r.ts }, false);
        }
      }
      padded = normalize(padded);
      coverage = normalize(coverage);
      dirtyFrom = Infinity; // loaded minutes are as persisted
      version++;
    },

    ingest(samples, cover, receivedAt) {
      for (const e of samples.system) addEvent({ event: e.event, at: e.at }, true);
      // The heartbeat's `locked` flag repairs a missed lock/unlock event (e.g. across a reload).
      const lastLockEvent = events.filter((e) => e.event === 'lock' || e.event === 'unlock').at(-1);
      const flagSettled = !lastLockEvent || receivedAt - lastLockEvent.at > LOCK_FLAG_GRACE_MS;
      if (flagSettled && samples.locked !== isLockedAt(receivedAt)) addEvent({ event: samples.locked ? 'lock' : 'unlock', at: receivedAt }, true);
      // Repair a missed wake only on evidence of the owner (an input or an unlock after the sleep): a heartbeat alone
      // proves nothing — Lua keeps sending ~1 s after "will sleep" (H-8), and dark wakes run Hammerspoon briefly
      // without any wake event (2026-10-04 19:08).
      const openSleep = timelines().asleep.at(-1);
      if (openSleep && openSleep[1] === Infinity) {
        const after = openSleep[0] + SYNTHETIC_WAKE_AFTER_MS;
        const evidence = [...samples.inputs.filter((t) => t > after), ...samples.system.filter((e) => e.event === 'unlock' && e.at > after).map((e) => e.at)];
        if (evidence.length) addEvent({ event: 'wake', at: Math.min(...evidence) }, true);
      }
      if (samples.inputs.length) {
        padded = normalize([...padded, ...samples.inputs.map((t) => [t, t + RUN_JOIN_MS] as const)]);
        dirtyFrom = Math.min(dirtyFrom, ...samples.inputs);
      }
      // Only *newly* covered time marks minutes dirty: the still-open app interval is re-sent with an old `from`
      // on every heartbeat.
      for (const a of samples.apps) {
        const entry = apps.get(a.id) ?? { name: a.name, list: [] };
        const fresh = subtract([[a.from, a.to]], entry.list);
        if (!fresh.length) continue;
        entry.name = a.name;
        entry.list = normalize([...entry.list, [a.from, a.to]]);
        apps.set(a.id, entry);
        dirtyFrom = Math.min(dirtyFrom, fresh[0]![0]);
      }
      if (cover.until > cover.since) {
        const fresh = subtract([[cover.since, cover.until]], coverage);
        if (fresh.length) {
          coverage = normalize([...coverage, [cover.since, cover.until]]);
          dirtyFrom = Math.min(dirtyFrom, fresh[0]![0]);
        }
      }
      version++;
    },

    flushMinutes(now, flushOpts) {
      // While a day's file cannot be written, one attempt per day per tick (no retry flood); other days go on.
      const failedDays = new Set<string>();
      unsaved = unsaved.filter((e) => {
        if (failedDays.has(dayKey(e.at))) return true;
        if (store.append({ type: 'system', ts: e.at, event: e.event })) return false;
        failedDays.add(dayKey(e.at));
        return true;
      });
      if (dirtyFrom === Infinity) return 0;
      const last = flushOpts?.all ? minuteKey(now) : minuteKey(now - FINALIZE_AFTER_MS) - MINUTE_MS;
      let n = 0;
      let failedFrom = Infinity;
      let m = minuteKey(dirtyFrom);
      for (; m <= last; m += MINUTE_MS) {
        if (!covered(m) || fullyAsleep(m)) continue;
        if (failedDays.has(dayKey(m))) {
          failedFrom = Math.min(failedFrom, m); // that day's file is failing: retry next tick
          continue;
        }
        const rec = compute(m);
        const prev = written.get(m);
        if (!prev && skippable(m, rec)) continue;
        if (prev && JSON.stringify(encodeMinute(prev)) === JSON.stringify(encodeMinute(rec))) continue;
        if (!store.append({ type: 'minute', provider: PROVIDER, minute: m, data: encodeMinute(rec) })) {
          failedFrom = Math.min(failedFrom, m); // stays dirty: retried on the next flush
          failedDays.add(dayKey(m));
          continue;
        }
        written.set(m, rec);
        n++;
      }
      // The partial minute flushed with `all` stays dirty: a later daemon re-emits it in full.
      dirtyFrom = Math.min(failedFrom, flushOpts?.all ? minuteKey(now) : Math.max(m, minuteKey(dirtyFrom)));
      if (n) log.debug('interactive minutes written', { n });
      return n;
    },

    coverageEnd: () => (coverage.length ? coverage[coverage.length - 1]![1] : null),

    blocked: (from, to) => blockedIn(from, to),

    prune(t) {
      padded = padded.filter(([, pb]) => pb > t);
      for (const [id, e] of apps) {
        e.list = e.list.filter(([, b]) => b > t);
        if (!e.list.length) apps.delete(id);
      }
      // Keep the last event before t: it defines the lock/sleep state at t.
      const before = events.filter((e) => e.at < t);
      const keep = new Set<TimelineEvent>();
      const lastOf = (kinds: SystemEvent[]) => before.filter((e) => kinds.includes(e.event)).at(-1);
      for (const e of [lastOf(['lock', 'unlock']), lastOf(['sleep', 'wake'])]) if (e) keep.add(e);
      events = events.filter((e) => e.at >= t || keep.has(e));
      coverage = coverage.filter(([, b]) => b > t);
      for (const m of [...written.keys()]) if (m + MINUTE_MS <= t) { written.delete(m); loadedBase.delete(m); }
      version++;
    },

    getMinuteInfo(m) {
      if (!covered(m) || fullyAsleep(m)) return written.get(m) ?? null;
      const settled = m + MINUTE_MS <= Math.min(dirtyFrom, opts.now() - FINALIZE_AFTER_MS);
      const prev = written.get(m);
      if (settled && prev) return prev;
      const rec = compute(m);
      return !prev && skippable(m, rec) ? null : rec;
    },

    getRangeInfo(start, end) {
      const r: InteractiveRange = { monitoredMinutes: 0, activeSeconds: 0, firstInputAt: null, lastInputAt: null, topApps: [], lockedSeconds: 0, asleepSeconds: 0 };
      const appTotals = new Map<string, TopApp>();
      // Locked/asleep totals come from the timeline: fully locked idle minutes have no record (D-31).
      const hi = Math.min(end, opts.now());
      if (hi > start) {
        const { locked, asleep } = timelines();
        r.lockedSeconds = Math.round(overlap(locked, start, hi) / 1000);
        r.asleepSeconds = Math.round(overlap(asleep, start, hi) / 1000);
      }
      for (let m = start; m < end; m += MINUTE_MS) {
        const info = provider.getMinuteInfo(m);
        if (!info) continue;
        r.monitoredMinutes++;
        r.activeSeconds += info.activeSeconds;
        if (info.inputs.length) {
          const first = m + info.inputs[0]![0];
          if (r.firstInputAt === null || first < r.firstInputAt) r.firstInputAt = first;
        }
        if (info.lastInputAt !== null && (r.lastInputAt === null || info.lastInputAt > r.lastInputAt)) r.lastInputAt = info.lastInputAt;
        for (const a of info.topApps) {
          const t = appTotals.get(a.id) ?? { id: a.id, name: a.name, s: 0 };
          t.s += a.s;
          appTotals.set(a.id, t);
        }
      }
      if (!r.monitoredMinutes && !r.lockedSeconds && !r.asleepSeconds) return null;
      r.topApps = [...appTotals.values()].sort((x, y) => y.s - x.s).slice(0, 5);
      return r;
    },

    workSource: {
      name: PROVIDER,
      activity: (from, to) => runs(from, to),
      blocked: (from, to) => blockedIn(from, to),
      version: () => version,
    },
  };
  return provider;
}

function overlapOf(a: readonly Interval[], b: readonly Interval[]): number {
  return b.reduce((s, [x, y]) => s + overlap(a, x, y), 0);
}
