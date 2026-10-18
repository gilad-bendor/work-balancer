// A timeline (ledger D-80): one time range [from, to) as a double bar. The upper half groups the time by state
// (Active, Inactive, … — one block each, in `order`, bottom-aligned); the lower half shows the same time in time order
// (top-aligned, often many small segments). Hovering a segment makes it glow and shows a tooltip. States and their
// looks come from the model (`src/timeline/timeline.ts` + the owner's `config/categories.ts`), so a new state needs no
// change here. Reusable by any page: `timeline(view, strings)`.
// Zoom (D-82, owner): one view window — fractions [f0, f1] of each timeline's own range — is shared by every timeline
// on the page, both halves alike. Cmd+scroll zooms around the pointer, Shift+scroll moves, wherever the pointer is;
// double-click a timeline = the full range again. The window lives in this module, so it survives a page re-render.
import { el } from './page.ts';
import { duration } from './format.ts';
import type { TimelineSegment, TimelineView } from '../../timeline/timeline.ts';

type Strings = Record<string, string>;

interface Group { state: string; ms: number; from: number; to: number }

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayTimeFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

let tip: HTMLElement | null = null;
let lit: HTMLElement | null = null;

function hideTip(): void {
  tip?.classList.remove('shown');
  lit?.classList.remove('lit');
  lit = null;
}

function showTip(lines: string[], x: number, y: number): void {
  if (!tip) {
    tip = el('div', { class: 'tl-tip', role: 'tooltip' });
    document.body.append(tip);
    document.addEventListener('scroll', hideTip, true);
  }
  tip.replaceChildren(...lines.map((l) => el('div', {}, l)));
  tip.classList.add('shown');
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = x + 16 + w > window.innerWidth - 8 ? x - 16 - w : x + 16;
  const top = y + 20 + h > window.innerHeight - 8 ? y - 12 - h : y + 20;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function light(seg: HTMLElement): void {
  if (lit === seg) return;
  lit?.classList.remove('lit');
  seg.classList.add('lit');
  lit = seg;
}

/** Narrowest window: a fraction of each range (≈ 3 min of a day, ≈ 20 min of a week). */
const MIN_SPAN = 0.002;
let win = { f0: 0, f1: 1 };
// Weak: a re-rendered page drops its old timelines, and nothing here may keep them alive (review).
const appliers = new WeakMap<Element, () => void>();

function applyAll(): void {
  for (const box of document.querySelectorAll('.tl')) appliers.get(box)?.();
}

function setWindow(f0: number, span: number): void {
  const w = Math.min(1, Math.max(MIN_SPAN, span));
  const start = Math.min(1 - w, Math.max(0, f0));
  win = { f0: start, f1: start + w };
  hideTip();
  applyAll();
}

function onWheel(e: WheelEvent): void {
  if (!e.metaKey && !e.shiftKey) return;
  const target = e.target instanceof Element ? e.target.closest<HTMLElement>('.tl') : null;
  const ref = target ?? document.querySelector<HTMLElement>('.tl');
  if (!ref) return;
  const r = ref.getBoundingClientRect();
  if (r.width <= 0) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.width : 1;
  const span = win.f1 - win.f0;
  if (e.metaKey) {
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const anchor = win.f0 + x * span;
    const next = Math.min(1, Math.max(MIN_SPAN, span * Math.exp((e.deltaY || e.deltaX) * unit * 0.002)));
    setWindow(anchor - x * next, next);
  } else {
    // macOS turns Shift + a vertical wheel into a horizontal one.
    setWindow(win.f0 + (((e.deltaX || e.deltaY) * unit) / r.width) * span, span);
  }
}

let installed = false;
function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('wheel', onWheel, { passive: false });
}

/** Index of the segment containing `t` (segments are sorted and contiguous). */
function find(segments: readonly { from: number; to: number }[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.from <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function timeline(v: TimelineView, s: Strings): HTMLElement {
  const span = v.to - v.from;
  const style = (state: string) => v.styles[state] ?? { color: '#8a8780', thickness: 7, label: state };
  const pct = (ms: number): string => `${span > 0 ? (ms / span) * 100 : 0}%`;
  const len = (ms: number): string => {
    const sec = Math.floor(Math.max(0, ms) / 1000);
    return sec < 60 ? `${sec} ${s.timelineSec ?? 's'}` : duration(ms, { inactMin: s.timelineMin, inactHour: s.timelineHour });
  };
  const multiDay = span > 26 * 3600_000;
  const at = (t: number): string => (multiDay ? dayTimeFmt : timeFmt).format(new Date(t));

  const totals = new Map<string, number>();
  for (const g of v.segments) totals.set(g.state, (totals.get(g.state) ?? 0) + (g.to - g.from));
  const states = [...v.order.filter((st) => totals.has(st)), ...[...totals.keys()].filter((st) => !v.order.includes(st))];
  const groups: Group[] = [];
  let off = 0;
  for (const st of states) {
    const ms = totals.get(st)!;
    groups.push({ state: st, ms, from: off, to: off + ms });
    off += ms;
  }
  const thick = Math.max(1, ...states.map((st) => style(st).thickness));

  const seg = (left: number, width: number, state: string, edge: 'bottom' | 'top'): HTMLElement => {
    const st = style(state);
    return el('div', {
      class: 'tl-seg',
      style: `left:${pct(left)};width:${pct(width)};height:${st.thickness}px;${edge}:0;--c:${st.color}`,
    });
  };
  // Each half holds a full-range track; the view window scales and shifts the tracks (the halves clip them).
  const upTrack = el('div', { class: 'tl-track' }, ...groups.map((g) => seg(g.from, g.ms, g.state, 'bottom')));
  if (v.markMs != null && v.markMs > 0 && v.markMs <= span) upTrack.append(el('div', { class: 'tl-mark', style: `left:${pct(v.markMs)}` }));
  const downTrack = el('div', { class: 'tl-track' },
    ...v.segments.map((g: TimelineSegment) => seg(g.from - v.from, g.to - g.from, g.state, 'top')));
  const upper = el('div', { class: 'tl-half tl-up', style: `height:${thick}px` }, upTrack);
  const lower = el('div', { class: 'tl-half tl-down', style: `height:${thick}px` }, downTrack);
  const upSegs = [...upTrack.querySelectorAll<HTMLElement>('.tl-seg')];
  const downSegs = [...downTrack.querySelectorAll<HTMLElement>('.tl-seg')];

  const box = el('div', {
    class: 'tl',
    role: 'img',
    'aria-label': groups.map((g) => `${style(g.state).label} ${len(g.ms)}`).join(', '),
  }, upper, lower);

  const apply = (): void => {
    const w = win.f1 - win.f0;
    for (const t of [upTrack, downTrack]) {
      t.style.width = `${100 / w}%`;
      t.style.marginLeft = `${(-win.f0 / w) * 100}%`;
    }
  };
  apply();
  appliers.set(box, apply);
  install();
  box.addEventListener('dblclick', () => setWindow(0, 1));

  box.addEventListener('mousemove', (e) => {
    const r = box.getBoundingClientRect();
    if (!span || r.width <= 0 || !v.segments.length) return;
    const x = (e.clientX - r.left) / r.width;
    const ms = Math.min(span - 1, Math.max(0, (win.f0 + x * (win.f1 - win.f0)) * span));
    if (e.clientY < lower.getBoundingClientRect().top) {
      const i = find(groups, ms);
      const g = groups[i]!;
      light(upSegs[i]!);
      showTip([len(g.ms), style(g.state).label], e.clientX, e.clientY);
    } else {
      const i = find(v.segments, v.from + ms);
      const g = v.segments[i]!;
      light(downSegs[i]!);
      showTip([len(g.to - g.from), `${at(g.from)} – ${at(g.to)}`, style(g.state).label], e.clientX, e.clientY);
    }
  });
  box.addEventListener('mouseleave', hideTip);
  return box;
}
