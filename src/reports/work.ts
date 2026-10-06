import type { AnyRecord } from '../store/records.ts';
import { clip, normalize, subtract, type Interval } from '../core/intervals.ts';
import type { WorkSource } from '../providers/work/index.ts';

/** Only the mandatory welcome overlay is excluded; ordinary notes review and voluntary reports remain unchanged. */
export function reportPeriods(records: readonly AnyRecord[], until: number, coveredUntil?: (at: number) => number | null): Interval[] {
  const periods: Interval[] = [];
  const gaps = records.filter((r) => r.type === 'monitor.gap' && typeof r.from === 'number').map((r) => r.from as number);
  let shown: number | null = null;
  const add = (from: number, end: number): void => {
    const coverage = coveredUntil ? coveredUntil(from) ?? from : until;
    const gap = gaps.filter((at) => at >= from && at < end).reduce((first, at) => Math.min(first, at), end);
    periods.push([from, Math.min(end, until, coverage, gap)]);
  };
  for (const r of records) {
    if (r.windowId !== 'review:fresh') continue;
    const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : r.ts;
    if (r.type === 'effect.shown' && shown === null) shown = at;
    if (r.type === 'effect.closed' && shown !== null) {
      add(shown, at);
      shown = null;
    }
  }
  if (shown !== null) add(shown, until);
  return normalize(periods);
}

export function withoutReportWork(source: WorkSource, periods: () => Interval[], version: () => number): WorkSource {
  return {
    ...source,
    version: () => source.version() + version(),
    ...(source.activity ? {
      activity(from: number, to: number) {
        // Sources use closed runs, whereas interval helpers use half-open ranges.
        return source.activity!(from, to).flatMap(([a, b]) =>
          subtract([[a, b + 1]], periods()).map(([start, end]) => [start, end - 1] as const));
      },
    } : {}),
    ...(source.credited ? {
      credited: (from: number, to: number) => subtract(source.credited!(from, to), periods()),
    } : {}),
  };
}

export function reportWorkSource(periods: () => Interval[], version: () => number): WorkSource {
  return { name: 'daily-report', version, blocked: (from, to) => clip(periods(), from, to) };
}
