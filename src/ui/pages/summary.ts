// Activity summary (menu → "Show activity summary", R-UI-MENU-3): today, this week per day vs budgets, the last 4
// weeks, recent feedback. Read-only; refreshes itself every minute while open.
import { api, boot, closeOnEscape, el, topBar, windowId } from './page.ts';
import { dayLabel, hm, timeLabel } from './format.ts';
import type { NoteView } from './notes-view.ts';

interface DayRow {
  day: string;
  weekday: string;
  workedSeconds: number | null;
  isToday: boolean;
  budgetSeconds: number | null;
  referenceSeconds: number | null;
  enforced: boolean;
}

interface Summary {
  today: {
    day: string; workedSeconds: number; limitSeconds: number | null; referenceSeconds: number | null; remainingSeconds: number | null;
    level: string; enforcing: boolean; tokensLeft: number[]; tokensUsed: number; bypassesUsed: number; prompts: number; answers: number;
    topApps: { name: string; seconds: number }[]; longestStretchSeconds: number; breaks: number; currentStretchSeconds: number | null;
    firstActivityAt: number | null; lastActivityAt: number | null; unmonitoredMinutes: number;
  };
  week: { start: string; workedSeconds: number; budgetSeconds: number | null; tokensUsed: number; bypassesUsed: number; days: DayRow[] };
  weeks: { start: string; workedSeconds: number; current: boolean }[];
  feedback: NoteView[];
  activeNotes: number;
}

const LEVEL: Record<string, string> = { ok: 'levelOk', orange: 'levelOrange', warn: 'levelWarn', countdown: 'levelCountdown', blocked: 'levelBlocked' };

void boot<Summary | null>(({ strings: s, model }) => {
  closeOnEscape(s.escUnsaved!);
  const none = s.summaryNone!;
  const main = el('main', { class: 'card wide' });

  const kv = (k: string, v: string | Node): HTMLElement => el('div', { class: 'kv' }, el('span', { class: 'muted' }, k), el('span', {}, v));
  const bar = (value: number, max: number, mark: number | null, cls = ''): HTMLElement => {
    const b = el('div', { class: `bar ${cls}` }, el('div', { class: 'fill', style: `width:${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }));
    if (mark !== null && max > 0) b.append(el('div', { class: 'mark', style: `left:${Math.min(100, (mark / max) * 100)}%` }));
    return b;
  };

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
    const dayMax = Math.max(1, ...w.days.map((d) => Math.max(d.workedSeconds ?? 0, d.budgetSeconds ?? d.referenceSeconds ?? 0)));
    const week = el('section', {},
      el('h2', {}, s.summaryWeek!),
      el('div', { class: 'days' }, ...w.days.map((d) => {
        const target = d.budgetSeconds ?? d.referenceSeconds;
        return el('div', { class: `day${d.isToday ? ' today' : ''}` },
          el('span', { class: 'day-name' }, dayLabel(d.day)),
          bar(d.workedSeconds ?? 0, dayMax, target, d.enforced ? 'enforced' : ''),
          el('span', { class: 'day-value' }, d.workedSeconds === null ? '' : `${hm(d.workedSeconds)}${target !== null ? ` / ${hm(target)}` : ''}`),
        );
      })),
      kv(s.summaryWeekTotal!, `${hm(w.workedSeconds)}${w.budgetSeconds !== null ? ` / ${hm(w.budgetSeconds)}` : ''}`),
      kv(s.summaryTokensBypassesWeek!, `${w.tokensUsed} / ${w.bypassesUsed}`),
    );

    const weekMax = Math.max(1, w.budgetSeconds ?? 0, ...m.weeks.map((x) => x.workedSeconds));
    const weeks = el('section', {},
      el('h2', {}, s.summaryWeeks!),
      el('div', { class: 'days' }, ...m.weeks.map((x) => el('div', { class: `day${x.current ? ' today' : ''}` },
        el('span', { class: 'day-name' }, `${s.summaryWeekOf} ${dayLabel(x.start, { weekday: false })}`),
        bar(x.workedSeconds, weekMax, w.budgetSeconds),
        el('span', { class: 'day-value' }, `${hm(x.workedSeconds)}${x.current ? ` ${s.summaryThisWeek}` : ''}`),
      ))),
    );

    const feedback = el('section', {},
      el('h2', {}, s.summaryFeedback!),
      ...(m.feedback.length ? m.feedback.map((f) => el('div', { class: 'feedback-line' },
        el('span', { class: 'muted' }, `${dayLabel(f.day)} ${timeLabel(f.createdAt)}`),
        el('span', {}, [...f.choices, ...(f.energy !== null ? [`${s.energyShort} ${f.energy}/5`] : []), ...(f.text ? [`“${f.text}”`] : [])].join(' · ')),
      )) : [el('p', { class: 'muted' }, s.summaryNoFeedback!)]),
    );

    main.replaceChildren(today, week, weeks, feedback);
  }

  if (model) render(model);
  document.body.replaceChildren(topBar(s.summaryTitle!, s.close!), main);
  setInterval(() => {
    void api<{ model: Summary | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => { if (r.model) render(r.model); }).catch(() => {});
  }, 60_000);
});
