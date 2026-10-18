// Activity summary (menu → "Show activity summary", R-UI-MENU-3): today, this week per day vs budgets, the last 20
// weeks; days and weeks as timelines (D-80). Reports live in Manage Reports (D-83). Read-only; refreshes itself every minute while open.
import { api, boot, closeOnEscape, el, fill, topBar, windowId } from './page.ts';
import { dayLabel, hm, timeLabel } from './format.ts';
import type { TimelineView } from '../../timeline/timeline.ts';
import { timeline } from './timeline.ts';

interface DayRow {
  day: string;
  weekday: string;
  workedSeconds: number | null;
  isToday: boolean;
  budgetSeconds: number | null;
  referenceSeconds: number | null;
  enforced: boolean;
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
  weeks: { start: string; workedSeconds: number; current: boolean; timeline: TimelineView }[];
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

    const w = m.week;
    const week = el('section', {},
      el('h2', {}, s.summaryWeek!),
      el('div', { class: 'days' }, ...w.days.map((d) => {
        const target = d.budgetSeconds ?? d.referenceSeconds;
        return el('div', { class: `day${d.isToday ? ' today' : ''}` },
          el('span', { class: 'day-name' }, dayLabel(d.day)),
          timeline(d.timeline, s),
          el('span', { class: 'day-value' }, d.workedSeconds === null ? '' : `${hm(d.workedSeconds)}${target !== null ? ` / ${hm(target)}` : ''}`),
        );
      }),
      el('div', { class: 'day whole-week' },
        el('span', { class: 'day-name' }, s.summaryWholeWeek!),
        timeline(w.timeline, s),
        el('span', { class: 'day-value' }, `${hm(w.workedSeconds)}${w.budgetSeconds !== null ? ` / ${hm(w.budgetSeconds)}` : ''}`),
      )),
      kv(s.summaryTokensBypassesWeek!, `${w.tokensUsed} / ${w.bypassesUsed}`),
    );

    const weeks = el('section', {},
      el('h2', {}, fill(s.summaryWeeks, { n: m.weeks.length })),
      el('div', { class: 'days' }, ...[...m.weeks].reverse().map((x) => el('div', { class: `day${x.current ? ' today' : ''}` },
        el('span', { class: 'day-name' }, x.start),
        timeline(x.timeline, s),
        el('span', { class: 'day-value' }, `${hm(x.workedSeconds)}${x.current ? ` ${s.summaryThisWeek}` : ''}`),
      ))),
    );

    main.replaceChildren(today, week, weeks);
  }

  if (model) render(model);
  document.body.replaceChildren(topBar(s.summaryTitle!, s.close!), main);
  setInterval(() => {
    void api<{ model: Summary | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => { if (r.model) render(r.model); }).catch(() => {});
  }, 60_000);
});
