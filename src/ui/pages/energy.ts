// Energy Graph (menu → "Energy Graph"): every day from the first report to today, rotated — time runs up the window
// (today on top), energy 1 … 5 left to right. A day = a bar from its lowest to its highest energy; a day without
// energy = a subtle grey row. Hovering a day shows its reports (HH:MM, read-only). Cmd+scroll zooms around the pointer,
// Shift+scroll moves, double-click = everything again — like the timelines (D-82). Refreshes itself every minute.
import { api, boot, closeOnEscape, el, topBar, windowId } from './page.ts';
import { reportRow } from './report-card.ts';
import type { EnergyDay } from '../../reports/energy.ts';

interface Model { today: string; days: EnergyDay[] }

/** Vertical room a date label needs. */
const LABEL_PX = 26;
/** Label every Nth day; from a week on they fall on Sundays (the week's start). */
const STEPS = [1, 2, 7, 14, 28, 56, 91, 182, 364, 728, 1456, 2912];
/** Narrowest zoom, in days. */
const MIN_DAYS = 3;
/** Week separators only while a week is at least this tall. */
const WEEK_LINE_MIN_PX = 8;

const weekdayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
const ordinal = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86_400_000;
};
// 1970-01-04 was a Sunday.
const labelled = (day: string, step: number): boolean => (ordinal(day) - 3) % step === 0;
const weekdayName = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number);
  return weekdayFmt.format(new Date(y!, m! - 1, d!, 12));
};
/** Horizontal position of an energy value inside the plot (1 at the left end, 5 at the right one). */
const x = (v: number): string => `calc(var(--eg-pad) + ${(v - 1) / 4} * (100% - 2 * var(--eg-pad)))`;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

void boot<Model | null>(({ strings: s, model }) => {
  closeOnEscape(s.escUnsaved!);
  const main = el('main', { class: 'card energy' });
  document.body.replaceChildren(topBar(s.energyTitle!, s.close!), main);

  const scale = el('div', { class: 'eg-scale' },
    ...[1, 2, 3, 4, 5].map((v) => el('span', { class: 'eg-num', style: `left:${x(v)}` }, String(v))),
    el('span', { class: 'eg-word muted small', style: `left:${x(1)}` }, s.energyLow!),
    el('span', { class: 'eg-word muted small', style: `left:${x(5)}` }, s.energyHigh!),
  );
  const labels = el('div', { class: 'eg-labels' });
  const plot = el('div', { class: 'eg-plot' });
  const band = el('div', { class: 'eg-band' });
  const graph = el('div', { class: 'eg-graph' }, labels, plot, band);
  const tip = el('div', { class: 'eg-tip', role: 'tooltip' });
  document.body.append(tip);

  let today = '';
  /** Newest first: index 0 is the top row. */
  let days: EnergyDay[] = [];
  /** The view window: fractions of all days, from the top. */
  let win = { f0: 0, f1: 1 };
  let pointer: { x: number; y: number } | null = null;
  let tipIndex = -1;

  const rowOf = (i: number, H: number): { top: number; h: number } => {
    const span = win.f1 - win.f0;
    const n = days.length;
    return { top: ((i / n - win.f0) / span) * H, h: H / (span * n) };
  };

  function draw(): void {
    const n = days.length;
    const H = plot.clientHeight;
    if (!n || H <= 0) return;
    const rowH = H / ((win.f1 - win.f0) * n);
    const gap = rowH >= 8 ? 2 : rowH >= 3 ? 0.5 : 0;
    const step = STEPS.find((st) => st * rowH >= LABEL_PX) ?? STEPS.at(-1)!;
    const first = Math.max(0, Math.floor(win.f0 * n));
    const last = Math.min(n - 1, Math.ceil(win.f1 * n) - 1);
    const grid = [1, 2, 3, 4, 5].map((v) => el('div', { class: 'eg-grid', style: `left:${x(v)}` }));
    const rows: HTMLElement[] = [];
    const weeks: HTMLElement[] = [];
    const marks: HTMLElement[] = [];
    for (let i = first; i <= last; i++) {
      const d = days[i]!;
      const { top } = rowOf(i, H);
      // Sunday starts a week; the row below it is the previous week's Saturday. Hidden when weeks get too thin.
      if (d.weekday === 'sun' && i < n - 1 && 7 * rowH >= WEEK_LINE_MIN_PX) weeks.push(el('div', { class: 'eg-week', style: `top:${top + rowH}px` }));
      const vertical = `top:${top + gap}px;height:${Math.max(1, rowH - 2 * gap)}px`;
      rows.push(d.min === null || d.max === null
        ? el('div', { class: 'eg-none', style: vertical })
        : el('div', { class: 'eg-bar', style: `${vertical};left:${x(d.min - 0.5)};width:calc(${(d.max - d.min + 1) / 4} * (100% - 2 * var(--eg-pad)))` }));
      if (labelled(d.day, step)) {
        // Kept inside the column (16 px text): never half clipped at the top or bottom edge.
        const mid = clamp(top + rowH / 2, 9, H - 9);
        marks.push(el('div', { class: `eg-date${d.day === today ? ' today' : ''}`, style: `top:${mid}px` }, d.day));
      }
    }
    plot.replaceChildren(...grid, ...rows, ...weeks);
    labels.replaceChildren(...marks);
    hover();
  }

  function hideTip(): void {
    tip.classList.remove('shown');
    band.classList.remove('shown');
    tipIndex = -1;
  }

  function hover(): void {
    const r = plot.getBoundingClientRect();
    const H = plot.clientHeight;
    if (!pointer || !days.length || H <= 0 || pointer.y < r.top || pointer.y >= r.top + H || pointer.x < r.left || pointer.x >= r.right) return hideTip();
    const i = clamp(Math.floor((win.f0 + ((pointer.y - r.top) / H) * (win.f1 - win.f0)) * days.length), 0, days.length - 1);
    const { top, h } = rowOf(i, H);
    band.style.top = `${top}px`;
    band.style.height = `${Math.max(2, h)}px`;
    band.classList.add('shown');
    if (i !== tipIndex) {
      tipIndex = i;
      const d = days[i]!;
      // Manage Reports' rows, read-only, with the time of day only.
      const rows = d.reports.map((rep) => reportRow({ ...rep, timestamp: rep.timestamp.slice(11) }, s, [], {}));
      tip.replaceChildren(
        el('div', { class: 'eg-tip-head' }, `${d.day} · ${weekdayName(d.day)}`),
        rows.length ? el('div', { class: 'reports compact' }, ...rows) : el('p', { class: 'muted small' }, s.timelineNoReports!),
      );
    }
    tip.classList.add('shown');
    tip.style.maxHeight = '';
    // Full width (CSS): below the day, or above it — never over it; too tall for both = the roomier side, cut short.
    const below = r.top + top + h + 8;
    const aboveEnd = r.top + top - 8;
    const roomBelow = window.innerHeight - 8 - below;
    const roomAbove = aboveEnd - 8;
    const th = tip.offsetHeight;
    const useAbove = th > roomBelow && (th <= roomAbove || roomAbove > roomBelow);
    const fit = Math.max(0, Math.min(th, useAbove ? roomAbove : roomBelow));
    if (fit < th) tip.style.maxHeight = `${fit}px`;
    tip.style.top = `${useAbove ? aboveEnd - fit : below}px`;
  }

  let drawPending = false;
  /** At most one redraw per frame (a trackpad sends many wheel events). */
  function scheduleDraw(): void {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => {
      drawPending = false;
      draw();
    });
  }

  function setWindow(f0: number, span: number): void {
    const w = clamp(span, Math.min(1, MIN_DAYS / Math.max(1, days.length)), 1);
    const start = clamp(f0, 0, 1 - w);
    win = { f0: start, f1: start + w };
    scheduleDraw();
  }

  window.addEventListener('wheel', (e) => {
    if ((!e.metaKey && !e.shiftKey) || !days.length) return;
    const r = graph.getBoundingClientRect();
    const H = plot.clientHeight;
    if (H <= 0) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    const span = win.f1 - win.f0;
    if (e.metaKey) {
      const at = clamp((e.clientY - r.top) / H, 0, 1);
      const next = span * Math.exp((e.deltaY || e.deltaX) * unit * 0.002);
      const w = clamp(next, Math.min(1, MIN_DAYS / days.length), 1);
      setWindow(win.f0 + at * span - at * w, w);
    } else {
      // macOS turns Shift + a vertical wheel into a horizontal one.
      setWindow(win.f0 + (((e.deltaX || e.deltaY) * unit) / H) * span, span);
    }
  }, { passive: false });
  graph.addEventListener('dblclick', () => setWindow(0, 1));
  plot.addEventListener('mousemove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    hover();
  });
  plot.addEventListener('mouseleave', () => {
    pointer = null;
    hideTip();
  });
  document.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', draw);

  function show(m: Model | null): void {
    today = m?.today ?? '';
    days = [...(m?.days ?? [])].reverse();
    tipIndex = -1;
    if (!days.length) {
      pointer = null;
      hideTip();
      main.replaceChildren(el('p', { class: 'muted' }, s.energyEmpty!));
      return;
    }
    if (!main.contains(graph)) main.replaceChildren(el('div', { class: 'eg-head' }, el('span'), scale), graph);
    setWindow(win.f0, win.f1 - win.f0);
  }

  show(model);
  setInterval(() => {
    void api<{ model: Model | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => show(r.model)).catch(() => {});
  }, 60_000);
});
