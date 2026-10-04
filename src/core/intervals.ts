// Half-open interval arithmetic on epoch ms: [from, to). Inputs need not be sorted; outputs are sorted and disjoint.

export type Interval = readonly [number, number];

export function normalize(list: readonly Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).slice().sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function union(...lists: readonly (readonly Interval[])[]): Interval[] {
  return normalize(lists.flat());
}

/** a − b. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const bs = normalize(b);
  const out: Interval[] = [];
  for (const [from, to] of normalize(a)) {
    let cur = from;
    for (const [bf, bt] of bs) {
      if (bt <= cur) continue;
      if (bf >= to) break;
      if (bf > cur) out.push([cur, bf]);
      cur = Math.max(cur, bt);
      if (cur >= to) break;
    }
    if (cur < to) out.push([cur, to]);
  }
  return out;
}

export function clip(list: readonly Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  for (const [a, b] of list) {
    const x = Math.max(a, from);
    const y = Math.min(b, to);
    if (y > x) out.push([x, y]);
  }
  return out;
}

export function total(list: readonly Interval[]): number {
  return list.reduce((s, [a, b]) => s + (b - a), 0);
}

/** Overlap length of a (normalized) list with [from, to). */
export function overlap(list: readonly Interval[], from: number, to: number): number {
  return total(clip(list, from, to));
}
