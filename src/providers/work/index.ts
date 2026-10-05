// `work` digest (ledger R-INFO-3, R-INFO-5): busy = ⋃ [activity, activity + grace) − blocked (lock/sleep) ∪ credited.
// Computed on demand, never persisted; clipped to *now* (a grace window never counts future time).
// Sources plug in without changing this module: `interactive` (activity runs + lock/sleep), `prompt-history` (M5,
// prompt instants as activity), inactivity resolutions (M9, credited intervals).
import type { PerMinuteInfoProvider, TimeRangeInfoProvider } from '../../core/registry.ts';
import { clip, normalize, overlap, subtract, total, union, type Interval } from '../../core/intervals.ts';
import { dayEnd, dayStart, MINUTE_MS, type DayKey, type MinuteKey } from '../../core/time.ts';

export const PROVIDER = 'work';

export interface WorkSource {
  name: string;
  /** Closed activity runs [a, b] (an instant is [t, t]) intersecting [from, to). Each contributes [a, b + grace). */
  activity?(from: number, to: number): Interval[];
  /** Intervals that cut busy time (screen locked, asleep). */
  blocked?(from: number, to: number): Interval[];
  /** Intervals counted as work regardless (inactivity-dialog resolutions; they include locked time). */
  credited?(from: number, to: number): Interval[];
  /** Changes whenever this source's data changes (cache key). */
  version(): number;
}

export interface WorkMinute {
  workSeconds: number;
}

export interface WorkRange {
  workedSeconds: number;
  /** Longest continuous busy stretch inside the range. */
  longestStretchSeconds: number;
  /** Non-busy gaps between busy stretches inside the range. */
  breaks: number;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
}

declare module '../../core/registry.ts' {
  interface ProviderTypeMap {
    work: { minute: WorkMinute; range: WorkRange };
  }
}

export interface WorkProvider extends PerMinuteInfoProvider<WorkMinute>, TimeRangeInfoProvider<WorkRange> {
  /** Busy intervals inside [from, min(to, now)). */
  busy(from: number, to: number): Interval[];
  /** Worked seconds of a whole day (past days are cached until a source changes). */
  daySeconds(day: DayKey): number;
  /** The busy stretch running right now, or null when on a break. */
  currentStretch(): { from: number; seconds: number } | null;
}

export function createWorkProvider(opts: { sources: () => readonly WorkSource[]; graceMs: () => number; now: () => number }): WorkProvider {
  const dayCache = new Map<DayKey, { key: string; seconds: number }>();
  const versionKey = (): string => `${opts.graceMs()}|${opts.sources().map((s) => `${s.name}:${s.version()}`).join(',')}`;

  function busy(from: number, to: number): Interval[] {
    const hi = Math.min(to, opts.now());
    if (hi <= from) return [];
    const g = opts.graceMs();
    const sources = opts.sources();
    const active = union(sources.flatMap((s) => s.activity?.(from - g, hi) ?? []).map(([a, b]) => [a, b + g] as const));
    const blocked = normalize(sources.flatMap((s) => s.blocked?.(from, hi) ?? []));
    const credited = normalize(sources.flatMap((s) => s.credited?.(from, hi) ?? []));
    return clip(union(subtract(active, blocked), credited), from, hi);
  }

  const provider: WorkProvider = {
    name: PROVIDER,
    dependsOn: ['interactive', 'prompt-history'],
    busy,
    getMinuteInfo(m: MinuteKey) {
      if (m >= opts.now()) return null;
      return { workSeconds: Math.round(overlap(busy(m, m + MINUTE_MS), m, m + MINUTE_MS) / 1000) };
    },
    getRangeInfo(start, end) {
      const b = busy(start, end);
      const acts = opts.sources().flatMap((s) => s.activity?.(start, end) ?? []).filter(([a, bb]) => bb >= start && a < end);
      if (!b.length && !acts.length) return null;
      return {
        workedSeconds: total(b) / 1000,
        longestStretchSeconds: b.reduce((mx, [x, y]) => Math.max(mx, y - x), 0) / 1000,
        breaks: Math.max(0, b.length - 1),
        firstActivityAt: acts.length ? Math.max(start, Math.min(...acts.map(([a]) => a))) : null,
        lastActivityAt: acts.length ? Math.min(end, Math.max(...acts.map(([, bb]) => bb))) : null,
      };
    },
    daySeconds(day) {
      const from = dayStart(day);
      const to = dayEnd(day);
      const settled = to <= opts.now();
      const key = versionKey();
      const hit = dayCache.get(day);
      if (settled && hit?.key === key) return hit.seconds;
      const seconds = total(busy(from, to)) / 1000;
      if (settled) dayCache.set(day, { key, seconds });
      return seconds;
    },
    currentStretch() {
      const now = opts.now();
      const last = busy(now - 24 * 3600_000, now).at(-1);
      return last && last[1] >= now ? { from: last[0], seconds: (now - last[0]) / 1000 } : null;
    },
  };
  return provider;
}
