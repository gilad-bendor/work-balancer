// Morning review (R-UI-REVIEW): the notes waiting for you, editable, each with Dismiss. Closing dismisses nothing.
// The window opens without focus (it must not catch keystrokes meant for another app); a click gives it focus.
import { act, api, boot, closeOnEscape, closeWindow, el, fill, focusOnInteract, isPrimary, windowId } from './page.ts';
import { noteCard, type NoteView } from './notes-view.ts';
import type { DailyReport } from '../../reports/reports.ts';
import { reportForm } from './report-form.ts';

void boot<{ notes: NoteView[]; report?: DailyReport | null; feedbackChoices?: string[]; olderCount?: number } | null>(({ strings: s, model }) => {
  if (model?.report) {
    document.body.classList.add('mode-overlay');
    const form = el('div');
    const msg = el('p', { class: 'msg', role: 'status' });
    const drafts = new Map<string, string>();
    const renderReport = (): void => {
      if (!model?.report) { closeWindow(); return; }
      const report = model.report;
      const done = el('button', { class: 'primary' }, s.reviewDone!);
      done.addEventListener('click', closeWindow);
      const catchup = el('button', {}, fill(s.reportCatchup, { n: model.olderCount ?? 0 }));
      catchup.addEventListener('click', () => {
        void api('/bridge/ui-request', { open: 'reports' }).then(closeWindow).catch(() => { msg.textContent = s.saveFailed!; });
      });
      const noteAction = async (action: string, payload: { id: string; text?: string }): Promise<boolean> => {
        try {
          const r = await act<{ notes: NoteView[] }>(action, payload);
          if (!r.ok) { msg.textContent = s.saveFailed!; return false; }
          if (model) model.notes = r.notes;
          drafts.delete(payload.id);
          renderReport();
          return true;
        } catch { msg.textContent = s.saveFailed!; return false; }
      };
      const notes = report.status !== 'pending' ? (model.notes ?? []).map((n) => noteCard(n, s, {
        drafts,
        edit: (id, text) => noteAction('edit', { id, text }),
        dismiss: (id) => void noteAction('dismiss', { id }),
        undismiss: (id) => void noteAction('undismiss', { id }),
      })) : [];
      form.replaceChildren(reportForm(report, s, model.feedbackChoices ?? [], () => {
        void api<{ model: typeof model }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => {
          model = r.model;
          if (model?.report) renderReport();
          else closeWindow();
        }).catch(() => { msg.textContent = s.saveFailed!; });
      }), ...notes, ...(report.status !== 'pending' ? [el('div', { class: 'row end' }, ...(model.olderCount ? [catchup] : []), done)] : []));
    };
    if (isPrimary) renderReport();
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
        if (action === 'edit' || action === 'dismiss') drafts.delete((payload as { id: string }).id);
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

  const drafts = new Map<string, string>();
  const handlers = {
    drafts,
    edit: (id: string, text: string) => run('edit', { id, text }),
    dismiss: (id: string) => void run('dismiss', { id }),
    undismiss: (id: string) => void run('undismiss', { id }),
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
