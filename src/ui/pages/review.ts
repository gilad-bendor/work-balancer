// Morning review (R-UI-REVIEW, D-75): every morning-review day; the notes waiting for you, editable, each with Dismiss
// (none waiting = a clean start). Closing dismisses nothing.
// The window opens without focus (it must not catch keystrokes meant for another app); a click gives it focus.
// Welcome (`review:fresh`, full screen): yesterday has no report — add one (pick the part of the day) or skip it first.
// After a day without work it asks about today instead, with a bold note about yesterday (and older days).
import { act, api, boot, closeOnEscape, closeWindow, el, fill, focusOnInteract, hasTypedText, isPrimary, submitOnCmdEnter, windowId } from './page.ts';
import { noteCard, type NoteView } from './notes-view.ts';
import type { ReportStub, ReportView } from '../../reports/reports.ts';
import { catchUpForm, dayDate, dayHeading, reportCard } from './report-card.ts';
import { reportFields, type ReportValue } from './report-fields.ts';

type Welcome = ReportStub & { reports: ReportView[]; today?: (ReportStub & { reports: ReportView[] }) | null };

interface Model {
  notes: NoteView[];
  welcome?: Welcome | null;
  endOfDay?: (ReportStub & { missing: boolean; reports: ReportView[] }) | null;
  statuses?: string[];
  stages?: string[];
  olderCount?: number;
}

void boot<Model | null>(({ strings: s, model }) => {
  if (model?.welcome) {
    document.body.classList.add('mode-overlay');
    const form = el('div');
    const msg = el('p', { class: 'msg', role: 'status' });
    const drafts = new Map<number, string>();
    const reload = (): void => {
      void api<{ model: Model | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => {
        model = r.model;
        if (model?.welcome) renderWelcome();
        else closeWindow();
      }).catch(() => { msg.textContent = s.saveFailed!; });
    };
    const title = el('h1', {}, s.reportWelcome!);
    const hint = el('p', { class: 'muted' }, isPrimary ? s.reportWelcomeHint! : s.reportOtherScreen!);
    // Kept across re-renders (for their day) so a draft survives opening the other form.
    let todayForm: { day: string; root: HTMLElement } | null = null;
    let yesterdayForm: { day: string; root: HTMLElement } | null = null;
    const refused = (): void => { todayForm = null; yesterdayForm = null; reload(); };
    const noteAction = async (action: string, payload: { id: number; text?: string }): Promise<boolean> => {
      try {
        const r = await act<{ notes: NoteView[] }>(action, payload);
        if (!r.ok) { msg.textContent = s.saveFailed!; return false; }
        if (model) model.notes = r.notes;
        drafts.delete(payload.id);
        renderWelcome();
        return true;
      } catch { msg.textContent = s.saveFailed!; return false; }
    };
    const editReport = async (id: number, value: ReportValue): Promise<boolean> => {
      try {
        const r = await act('report-edit', { id, ...value });
        if (r.ok) { reload(); return true; }
        msg.textContent = r.error === 'empty' ? s.nothingToSave! : s.saveFailed!;
      } catch { msg.textContent = s.saveFailed!; }
      return false;
    };
    /** The waiting notes and Continue — once the welcome is answered. */
    const finish = (m: Model): HTMLElement[] => {
      const done = el('button', { class: 'primary' }, s.reviewDone!);
      // Refused only when a new day began meanwhile (a new yesterday to ask about): show that form.
      done.addEventListener('click', () => { void act('close').then((r) => (r.ok ? undefined : reload()), closeWindow); });
      const catchup = el('button', {}, fill(s.reportCatchup, { n: m.olderCount ?? 0 }));
      catchup.addEventListener('click', () => {
        void api('/bridge/ui-request', { open: 'reports' }).then(closeWindow).catch(() => { msg.textContent = s.saveFailed!; });
      });
      const notes = (m.notes ?? []).map((n) => noteCard(n, s, {
        drafts,
        edit: (id, text) => noteAction('edit', { id, text }),
        dismiss: (id) => void noteAction('dismiss', { id }),
        undismiss: (id) => void noteAction('undismiss', { id }),
      }));
      return [...notes, el('div', { class: 'row end' }, ...(m.olderCount ? [catchup] : []), done)];
    };
    // Yesterday had no work: ask about today; yesterday and older days get a bold note (yesterday can be reported too).
    const renderToday = (m: Model, w: Welcome, today: NonNullable<Welcome['today']>): void => {
      const statuses = m.statuses ?? [];
      title.textContent = s.reportWelcomeToday!;
      if (isPrimary) hint.textContent = s.reportWelcomeTodayHint!;
      const parts: HTMLElement[] = [];
      if (todayForm?.day !== today.day) todayForm = null;
      if (yesterdayForm?.day !== w.day) yesterdayForm = null;
      if (today.reports.length) {
        todayForm = null;
        parts.push(el('p', { class: 'muted' }, s.reportRecordedToday!), ...today.reports.map((r) => reportCard(r, s, statuses, { edit: editReport })));
      } else {
        todayForm ??= { day: today.day, root: catchUpForm(today, s, statuses, [], { onSaved: reload, onDayRefused: refused }) };
        parts.push(todayForm.root);
      }
      if (w.reports.length) {
        yesterdayForm = null;
        parts.push(el('p', { class: 'muted' }, s.reportWelcomeDone!), ...w.reports.map((r) => reportCard(r, s, statuses, { edit: editReport })));
      } else {
        parts.push(el('p', { class: 'bold-note' }, fill(s.reportYesterdayMissing, { date: dayDate(w.day) })));
        if (yesterdayForm) parts.push(el('h2', {}, dayHeading(w.day, w.daysAgo, s)), yesterdayForm.root);
        else {
          const also = el('button', {}, s.reportYesterdayAlso!);
          also.addEventListener('click', () => {
            yesterdayForm = { day: w.day, root: catchUpForm(w, s, statuses, m.stages ?? [], {
              onSaved: () => { yesterdayForm = null; reload(); },
              onCancel: () => { yesterdayForm = null; renderWelcome(); },
              onDayRefused: refused,
              skip: true,
            }) };
            renderWelcome();
          });
          parts.push(el('div', { class: 'row' }, also));
        }
      }
      if (m.olderCount) parts.push(el('p', { class: 'bold-note' }, fill(s.reportOlderMissing, { n: m.olderCount })));
      if (today.reports.length || w.reports.length) parts.push(...finish(m));
      form.replaceChildren(...parts);
    };
    const renderWelcome = (): void => {
      if (!model?.welcome) { closeWindow(); return; }
      const w = model.welcome;
      const statuses = model.statuses ?? [];
      if (w.today) {
        renderToday(model, w, w.today);
        return;
      }
      todayForm = null;
      yesterdayForm = null;
      title.textContent = s.reportWelcome!;
      if (isPrimary) hint.textContent = s.reportWelcomeHint!;
      if (!w.reports.length) {
        form.replaceChildren(el('h2', {}, dayHeading(w.day, w.daysAgo, s)), catchUpForm(w, s, statuses, model.stages ?? [], { onSaved: reload, onDayRefused: reload, skip: true }));
        return;
      }
      form.replaceChildren(
        el('p', { class: 'muted' }, s.reportWelcomeDone!),
        ...w.reports.map((r) => reportCard(r, s, statuses, { edit: editReport })),
        ...finish(model),
      );
    };
    if (isPrimary) renderWelcome();
    else if (model.welcome.today) title.textContent = s.reportWelcomeToday!;
    document.body.replaceChildren(el('main', { class: 'card' }, title, hint, form, msg));
    return;
  }
  // Picked statuses / energy in the end-of-day form count as unsaved too.
  closeOnEscape(s.escUnsaved!, () => hasTypedText() || !!document.querySelector('.end-of-day .report-fields button[aria-pressed=true]'));
  focusOnInteract();
  // Notes dismissed here stay visible (greyed, with "Bring back") until the window closes.
  const shown = new Map((model?.notes ?? []).map((n) => [n.id, n]));
  const list = el('div', { class: 'notes' });
  const msg = el('p', { class: 'msg', role: 'status' });

  async function run(action: string, payload: unknown): Promise<boolean> {
    msg.textContent = '';
    try {
      const r = await act<{ notes: NoteView[] }>(action, payload);
      if (r.ok) {
        if (action === 'edit' || action === 'dismiss') drafts.delete((payload as { id: number }).id);
        const active = new Map(r.notes.map((n) => [n.id, n]));
        for (const [id, n] of shown) shown.set(id, active.get(id) ?? { ...n, dismissed: true });
        for (const n of r.notes) if (!shown.has(n.id)) shown.set(n.id, n);
        render();
        return true;
      }
      msg.textContent = r.error === 'empty' ? s.nothingToSave! : s.saveFailed!;
    } catch {
      msg.textContent = s.saveFailed!;
    }
    return false;
  }

  const drafts = new Map<number, string>();
  const handlers = {
    drafts,
    edit: (id: number, text: string) => run('edit', { id, text }),
    dismiss: (id: number) => void run('dismiss', { id }),
    undismiss: (id: number) => void run('undismiss', { id }),
  };

  function render(): void {
    const notes = [...shown.values()];
    list.replaceChildren(...(notes.length ? notes.map((n) => noteCard(n, s, handlers)) : [el('p', { class: 'muted' }, s.reviewEmpty!)]));
  }

  const done = el('button', { class: 'primary' }, s.reviewDone!);
  done.addEventListener('click', closeWindow);
  const catchup = el('button', {}, fill(s.reportCatchup, { n: model?.olderCount ?? 0 }));
  catchup.addEventListener('click', () => {
    void api('/bridge/ui-request', { open: 'reports' }).then(closeWindow).catch(() => { msg.textContent = s.saveFailed!; });
  });

  // Yesterday (a workday) ended without an end-of-day report — e.g. an early end: an optional one. Once saved, it stays
  // shown (editable) until the window closes.
  const statuses = model?.statuses ?? [];
  const endOfDay = el('section', { class: 'end-of-day' });
  const reloadEndOfDay = (failed: string): void => {
    void api<{ model: Model | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => renderEndOfDay(r.model?.endOfDay ?? null), () => { msg.textContent = failed; });
  };
  const editReport = async (id: number, value: ReportValue): Promise<boolean> => {
    try {
      const r = await act('report-edit', { id, ...value });
      if (r.ok) { reloadEndOfDay(s.reportSaved!); return true; }
      msg.textContent = r.error === 'empty' ? s.nothingToSave! : s.saveFailed!;
    } catch { msg.textContent = s.saveFailed!; }
    return false;
  };
  function renderEndOfDay(e: Model['endOfDay']): void {
    if (!e) { endOfDay.replaceChildren(); return; }
    const head = [el('h2', {}, s.reviewEndOfDayTitle!), el('p', { class: 'muted' }, dayHeading(e.day, e.daysAgo, s))];
    if (!e.missing) {
      endOfDay.replaceChildren(...head, el('p', { class: 'muted' }, s.reportWelcomeDone!), ...e.reports.map((r) => reportCard(r, s, statuses, { edit: editReport })));
      return;
    }
    const fields = reportFields(s, statuses);
    const save = el('button', { class: 'primary' }, s.reportSave!);
    const formMsg = el('p', { class: 'msg', role: 'status' });
    const submit = async (): Promise<void> => {
      if (save.disabled) return;
      if (fields.isEmpty()) { formMsg.textContent = s.nothingToSave!; return; }
      save.disabled = true;
      try {
        const r = await act('report-end-of-day', { day: e.day, ...fields.value() });
        // Saved (or saved meanwhile): show what is recorded; if that refresh fails, at least say it was saved.
        if (r.ok || r.error === 'exists') { endOfDay.replaceChildren(...head, el('p', { class: 'muted' }, s.reportSaved!)); reloadEndOfDay(s.reportSaved!); return; }
        // A new day began while the window stayed open: the form now belongs to an older day.
        if (r.error === 'day') { reloadEndOfDay(s.saveFailed!); return; }
        formMsg.textContent = r.error === 'empty' ? s.nothingToSave! : s.saveFailed!;
      } catch { formMsg.textContent = s.saveFailed!; }
      save.disabled = false;
    };
    save.addEventListener('click', () => void submit());
    submitOnCmdEnter(fields.feedback, () => void submit());
    endOfDay.replaceChildren(...head, el('p', { class: 'muted' }, s.reviewEndOfDayHint!), fields.root, formMsg, el('div', { class: 'row end' }, save));
  }
  if (model?.endOfDay?.missing) renderEndOfDay(model.endOfDay);

  render();
  document.body.replaceChildren(el('main', { class: 'card' },
    el('h1', {}, s.reviewTitle!),
    endOfDay,
    ...(shown.size ? [el('p', { class: 'muted' }, s.reviewIntro!)] : []),
    msg,
    list,
    el('div', { class: 'row end' }, ...(model?.olderCount ? [catchup] : []), done),
  ));
});
