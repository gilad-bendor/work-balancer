// Morning review (R-UI-REVIEW): the notes waiting for you, editable, each with Dismiss. Closing dismisses nothing.
// The window opens without focus (it must not catch keystrokes meant for another app); a click gives it focus.
// Welcome (`review:fresh`, full screen): yesterday has no report — add one (pick the part of the day) or skip it first.
import { act, api, boot, closeOnEscape, closeWindow, el, fill, focusOnInteract, isPrimary, windowId } from './page.ts';
import { noteCard, type NoteView } from './notes-view.ts';
import type { ReportStub, ReportView } from '../../reports/reports.ts';
import { catchUpForm, dayHeading, reportCard } from './report-card.ts';
import type { ReportValue } from './report-fields.ts';

interface Model {
  notes: NoteView[];
  welcome?: (ReportStub & { reports: ReportView[] }) | null;
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
    const renderWelcome = (): void => {
      if (!model?.welcome) { closeWindow(); return; }
      const w = model.welcome;
      const statuses = model.statuses ?? [];
      if (!w.reports.length) {
        form.replaceChildren(el('h2', {}, dayHeading(w.day, w.daysAgo, s)), catchUpForm(w, s, statuses, model.stages ?? [], { onSaved: reload, skip: true }));
        return;
      }
      const done = el('button', { class: 'primary' }, s.reviewDone!);
      // Refused only when a new day began meanwhile (a new yesterday to ask about): show that form.
      done.addEventListener('click', () => { void act('close').then((r) => (r.ok ? undefined : reload()), closeWindow); });
      const catchup = el('button', {}, fill(s.reportCatchup, { n: model.olderCount ?? 0 }));
      catchup.addEventListener('click', () => {
        void api('/bridge/ui-request', { open: 'reports' }).then(closeWindow).catch(() => { msg.textContent = s.saveFailed!; });
      });
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
      const notes = (model.notes ?? []).map((n) => noteCard(n, s, {
        drafts,
        edit: (id, text) => noteAction('edit', { id, text }),
        dismiss: (id) => void noteAction('dismiss', { id }),
        undismiss: (id) => void noteAction('undismiss', { id }),
      }));
      form.replaceChildren(
        el('p', { class: 'muted' }, s.reportWelcomeDone!),
        ...w.reports.map((r) => reportCard(r, s, statuses, { edit: editReport })),
        ...notes,
        el('div', { class: 'row end' }, ...(model.olderCount ? [catchup] : []), done),
      );
    };
    if (isPrimary) renderWelcome();
    document.body.replaceChildren(el('main', { class: 'card' }, el('h1', {}, s.reportWelcome!),
      el('p', { class: 'muted' }, isPrimary ? s.reportWelcomeHint! : s.reportOtherScreen!), form, msg));
    return;
  }
  closeOnEscape(s.escUnsaved!);
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
  render();
  document.body.replaceChildren(el('main', { class: 'card' },
    el('h1', {}, s.reviewTitle!),
    el('p', { class: 'muted' }, s.reviewIntro!),
    msg,
    list,
    el('div', { class: 'row end' }, ...(model?.olderCount ? [catchup] : []), done),
  ));
});
