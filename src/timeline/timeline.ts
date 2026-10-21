// Timelines (daily/weekly, ledger D-67/D-73/D-80): a time range cut into contiguous segments, each in one state
// (Active, Inactive, Blocked, Future, …). Pure: callers pass the intervals of each state; the page module
// `src/ui/pages/timeline.ts` draws the result. A new state = one more layer here + a style in `config/categories.ts`.
import { clip, normalize, subtract, type Interval } from '../core/intervals.ts';
import { MINUTE_MS } from '../core/time.ts';
import { grantSpans } from '../policy/evaluate.ts';
import type { AnyRecord } from '../store/records.ts';
import type { CategoryStyle } from '../categories/categories.ts';

/** Built-in timeline states, in the order the "grouped by state" half shows them. */
export const TIMELINE_STATES = ['Active', 'Inactive', 'Blocked', 'Future'] as const;

export interface TimelineSegment {
  from: number;
  to: number;
  state: string;
}

/** What a page needs to draw one timeline (`src/ui/pages/timeline.ts`). */
export interface TimelineView {
  from: number;
  to: number;
  /** Contiguous, sorted, covering [from, to); neighbours always differ in state. */
  segments: TimelineSegment[];
  /** Order of the states in the grouped half (states missing here go last). */
  order: string[];
  styles: Record<string, CategoryStyle>;
  /** Optional tick on the grouped half, as a duration from its start (e.g. the day's budget). */
  markMs?: number;
}

export interface TimelineLayer {
  state: string;
  intervals: readonly Interval[];
}

/** Cuts [from, to) into segments. `layers` are by precedence (first wins where they overlap); time no layer covers
 * is `base`. Adjacent segments of one state are merged. */
export function buildSegments(from: number, to: number, layers: readonly TimelineLayer[], base: string): TimelineSegment[] {
  if (to <= from) return [];
  const ls = layers.map((l) => clip(normalize(l.intervals), from, to));
  const cuts = [...new Set([from, to, ...ls.flatMap((l) => l.flat())])].sort((a, b) => a - b);
  const ptr = ls.map(() => 0);
  const out: TimelineSegment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    let state = base;
    for (let j = 0; j < ls.length; j++) {
      const l = ls[j]!;
      while (ptr[j]! < l.length && l[ptr[j]!]![1] <= a) ptr[j]!++;
      const iv = l[ptr[j]!];
      if (iv && iv[0] <= a) { state = layers[j]!.state; break; }
    }
    const last = out.at(-1);
    if (last?.state === state) last.to = b;
    else out.push({ from: a, to: b, state });
  }
  return out;
}

/** Time under a budget block: from each `policy.transition` into `blocked` until the next one out of it (at the
 * latest `dayEndOf(ts)` — a block lasts until 04:00), minus the grants of tokens and bypasses (minutes of `busy`, D-86). */
export function blockedIntervals(records: readonly AnyRecord[], dayEndOf: (ts: number) => number, busy: readonly Interval[]): Interval[] {
  const blocked: Interval[] = [];
  let since: number | null = null;
  let until = 0;
  const close = (t: number): void => {
    if (since !== null) blocked.push([since, Math.min(t, until)]);
    since = null;
  };
  const transitions = records.filter((r) => r.type === 'policy.transition').sort((x, y) => x.ts - y.ts);
  for (const r of transitions) {
    if (since !== null && r.ts >= until) close(until);
    if (r.to === 'blocked') {
      if (since === null) { since = r.ts; until = dayEndOf(r.ts); }
    } else close(r.ts);
  }
  close(until);
  const grants = grantSpans(
    records.filter((r) => (r.type === 'token.used' || r.type === 'bypass.used') && typeof r.minutes === 'number') as unknown as { ts: number; minutes: number }[],
    records.filter((r) => r.type === 'grant.ended').map((r) => r.ts),
    busy,
    Infinity,
  ).spans;
  return subtract(blocked, grants);
}

/** Splits worked time by app category (D-67). Within each minute, each category other than `defaultCategory` gets its
 * share of that minute's worked part (its foreground seconds ÷ all foreground seconds of the minute), placed at the
 * start of that part; the rest stays plain Active. Minutes without recorded categories stay Active. Built-in state
 * names are never categories. Returns one layer per category (sorted by name), each a subset of `active`. */
export function categoryLayers(
  active: readonly Interval[],
  categoriesAt: (minute: number) => Readonly<Record<string, number>> | null | undefined,
  defaultCategory: string,
): TimelineLayer[] {
  const perMinute = new Map<number, Interval[]>();
  for (const [a, b] of normalize(active)) {
    for (let m = Math.floor(a / MINUTE_MS) * MINUTE_MS; m < b; m += MINUTE_MS) {
      const part: Interval = [Math.max(a, m), Math.min(b, m + MINUTE_MS)];
      const list = perMinute.get(m);
      if (list) list.push(part);
      else perMinute.set(m, [part]);
    }
  }
  const out = new Map<string, Interval[]>();
  for (const [m, parts] of perMinute) {
    const cats = categoriesAt(m);
    if (!cats) continue;
    const entries = Object.entries(cats)
      .filter(([c, s]) => typeof s === 'number' && Number.isFinite(s) && s > 0 && !(TIMELINE_STATES as readonly string[]).includes(c));
    const sum = entries.reduce((acc, [, s]) => acc + s, 0);
    const others = entries.filter(([c]) => c !== defaultCategory).sort(([x], [y]) => x.localeCompare(y));
    if (!others.length) continue;
    const worked = parts.reduce((acc, [a, b]) => acc + (b - a), 0);
    let i = 0;
    let at = parts[0]![0];
    for (const [c, s] of others) {
      let need = (worked * s) / sum;
      const mine = out.get(c) ?? [];
      while (need > 0 && i < parts.length) {
        const end = Math.min(parts[i]![1], Math.round(at + need));
        if (end > at) mine.push([at, end]);
        need = end > at ? need - (end - at) : 0;
        at = end;
        if (at >= parts[i]![1]) { i++; at = parts[i]?.[0] ?? at; }
      }
      out.set(c, mine);
    }
  }
  return [...out.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([state, list]) => ({ state, intervals: normalize(list) }));
}

/** The usual timeline: Future (from `now`) > app categories > Active (worked) > Blocked > Inactive. Active time and
 * its categories = worked time (work + reported-as-work as one range, D-73), so they add up to the worked numbers. */
export function workTimeline(opts: {
  from: number;
  to: number;
  now: number;
  active: readonly Interval[];
  blocked: readonly Interval[];
  /** Parts of `active` in another app category (`categoryLayers`). */
  categories?: readonly TimelineLayer[];
  style: (state: string) => CategoryStyle;
  markMs?: number | null;
}): TimelineView {
  const merged = new Map<string, Interval[]>();
  for (const c of opts.categories ?? []) merged.set(c.state, [...(merged.get(c.state) ?? []), ...c.intervals]);
  const cats = [...merged].sort(([x], [y]) => x.localeCompare(y)).map(([state, intervals]) => ({ state, intervals }));
  const segments = buildSegments(opts.from, opts.to, [
    { state: 'Future', intervals: [[opts.now, opts.to]] },
    ...cats,
    { state: 'Active', intervals: opts.active },
    { state: 'Blocked', intervals: opts.blocked },
  ], 'Inactive');
  const order = ['Active', ...cats.map((c) => c.state), 'Inactive', 'Blocked', 'Future'];
  return {
    from: opts.from, to: opts.to, segments, order,
    styles: Object.fromEntries(order.map((s) => [s, opts.style(s)])),
    ...(opts.markMs != null ? { markMs: opts.markMs } : {}),
  };
}
