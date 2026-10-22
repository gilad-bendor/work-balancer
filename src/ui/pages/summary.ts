// Activity summary (menu → "Show activity summary", R-UI-MENU-3): today, this week per day vs budgets, every past
// week (D-90); days and weeks as timelines (D-80). Every timeline expands to its days (a week) and its reports (D-89).
// Read-only; refreshes itself every minute while open.
import { api, boot, closeOnEscape, el, fill, topBar, windowId } from './page.ts';
import { dayLabel, hm, timeLabel } from './format.ts';
import type { TimelineView } from '../../timeline/timeline.ts';
import type { ReportView } from '../../reports/reports.ts';
import { clipView, timelineRow, type TimelineEntry } from './timeline.ts';

interface DayInfo {
  day: string;
  weekday: string;
  workedSeconds: number | null;
  isToday: boolean;
  from: number;
  to: number;
  budgetSeconds: number | null;
  referenceSeconds: number | null;
  enforced: boolean;
}

interface DayRow extends DayInfo {
  timeline: TimelineView;
}

interface Summary {
  today: {
    day: string; workedSeconds: number; limitSeconds: number | null; referenceSeconds: number | null; remainingSeconds: number | null;
    level: string; enforcing: boolean; tokensLeft: number[]; tokensUsed: number; bypassesUsed: number; prompts: number; answers: number;
    topApps: { name: string; seconds: number }[]; longestStretchSeconds: number; breaks: number; currentStretchSeconds: number | null;
    firstActivityAt: number | null; lastActivityAt: number | null; unmonitoredMinutes: number;
  };
  week: { start: string; workedSeconds: number; budgetSeconds: number | null; tokensUsed: number; bypassesUsed: number; timeline: TimelineView; days: DayRow[] };
  weeks: { start: string; workedSeconds: number; current: boolean; timeline: TimelineView; days: DayInfo[] }[];
  /** Not dismissed, oldest first, from the first week on. */
  reports: ReportView[];
  activeNotes: number;
}

const LEVEL: Record<string, string> = { ok: 'levelOk', orange: 'levelOrange', warn: 'levelWarn', countdown: 'levelCountdown', blocked: 'levelBlocked' };

void boot<Summary | null>(({ strings: s, model }) => {
  closeOnEscape(s.escUnsaved!);
  const none = s.summaryNone!;
  const main = el('main', { class: 'card wide' });

  const kv = (k: string, v: string | Node): HTMLElement => el('div', { class: 'kv' }, el('span', { class: 'muted' }, k), el('span', {}, v));

  function render(m: Summary): void {
    const t = m.today;
    const today = el('section', {},
      el('h2', {}, `${s.summaryToday} — ${dayLabel(t.day)}`),
      el('div', { class: 'grid' },
        kv(s.summaryWorked!, hm(t.workedSeconds)),
        kv(s.summaryBudget!, t.limitSeconds !== null ? hm(t.limitSeconds) : t.referenceSeconds !== null ? `${hm(t.referenceSeconds)} (${s.summaryReference})` : s.summaryNoBudget!),
        kv(s.summaryLeft!, t.remainingSeconds !== null ? hm(t.remainingSeconds) : none),
        kv(s.summaryState!, t.enforcing ? (s[LEVEL[t.level] ?? 'levelOk'] ?? t.level) : none),
        kv(s.summaryTokens!, t.enforcing ? (t.tokensLeft.length ? t.tokensLeft.map((n) => `${n} min`).join(' · ') : '0') : none),
        kv(s.summaryBypasses!, String(t.bypassesUsed)),
        kv(s.summaryPrompts!, `${t.prompts} / ${t.answers}`),
        kv(s.summaryStretch!, t.currentStretchSeconds !== null ? hm(t.currentStretchSeconds) : s.summaryOnBreak!),
        kv(s.summaryLongest!, hm(t.longestStretchSeconds)),
        kv(s.summaryBreaks!, String(t.breaks)),
        kv(s.summaryFirstLast!, t.firstActivityAt !== null && t.lastActivityAt !== null ? `${timeLabel(t.firstActivityAt)} – ${timeLabel(t.lastActivityAt)}` : none),
        kv(s.summaryUnmonitored!, t.unmonitoredMinutes ? `${t.unmonitoredMinutes} min` : none),
        kv(s.summaryNotesWaiting!, String(m.activeNotes)),
      ),
      el('div', { class: 'kv' }, el('span', { class: 'muted' }, s.summaryTopApps!),
        el('span', {}, t.topApps.length ? t.topApps.map((a) => `${a.name} ${hm(a.seconds)}`).join(' · ') : none)),
    );

    const between = (from: string, to: string): ReportView[] => m.reports.filter((r) => r.day >= from && r.day <= to);
    const target = (d: DayInfo): number | null => d.budgetSeconds ?? d.referenceSeconds;
    const dayEntry = (key: string, d: DayInfo, view: TimelineView): TimelineEntry => {
      const t = target(d);
      return {
        key, label: dayLabel(d.day), view, reports: between(d.day, d.day), ...(d.isToday ? { className: 'today' } : {}),
        value: d.workedSeconds === null ? '' : `${hm(d.workedSeconds)}${t !== null ? ` / ${hm(t)}` : ''}`,
      };
    };
    const lastDay = (days: DayInfo[], start: string): string => days.at(-1)?.day ?? start;

    const w = m.week;
    const week = el('section', {},
      el('h2', {}, s.summaryWeek!),
      el('div', { class: 'days' },
        ...w.days.map((d) => timelineRow(dayEntry(`week/${d.day}`, d, d.timeline), s)),
        timelineRow({
          key: 'week/whole', label: s.summaryWholeWeek!, view: w.timeline, className: 'whole-week',
          value: `${hm(w.workedSeconds)}${w.budgetSeconds !== null ? ` / ${hm(w.budgetSeconds)}` : ''}`,
          days: () => w.days.map((d) => dayEntry(`week/whole/${d.day}`, d, d.timeline)),
          reports: between(w.start, lastDay(w.days, w.start)),
        }, s),
      ),
      kv(s.summaryTokensBypassesWeek!, `${w.tokensUsed} / ${w.bypassesUsed}`),
    );

    const weeks = el('section', {},
      el('h2', {}, m.weeks.length === 1 ? s.summaryWeeksOne! : fill(s.summaryWeeks, { n: m.weeks.length })),
      el('div', { class: 'days' }, ...[...m.weeks].reverse().map((x) => {
        const key = `weeks/${x.start}`;
        return timelineRow({
          key, label: x.start, view: x.timeline, ...(x.current ? { className: 'today' } : {}),
          value: `${hm(x.workedSeconds)}${x.current ? ` ${s.summaryThisWeek}` : ''}`,
          days: () => x.days.map((d) => {
            const t = target(d);
            return dayEntry(`${key}/${d.day}`, d, clipView(x.timeline, d.from, d.to, t === null ? null : t * 1000));
          }),
          reports: between(x.start, lastDay(x.days, x.start)),
        }, s);
      })),
    );

    main.replaceChildren(today, week, weeks);
  }

  if (model) render(model);
  document.body.replaceChildren(topBar(s.summaryTitle!, s.close!), main);
  setInterval(() => {
    void api<{ model: Summary | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => { if (r.model) render(r.model); }).catch(() => {});
  }, 60_000);
});
