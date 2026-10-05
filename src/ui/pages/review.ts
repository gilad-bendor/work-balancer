// Morning review (R-UI-REVIEW): the notes waiting for you, editable, each with Dismiss. Closing dismisses nothing.
// The window opens without focus (it must not catch keystrokes meant for another app); a click gives it focus.
import { act, boot, closeOnEscape, closeWindow, el, focusOnInteract } from './page.ts';
import { noteCard, type NoteView } from './notes-view.ts';

void boot<{ notes: NoteView[] } | null>(({ strings: s, model }) => {
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
  render();
  document.body.replaceChildren(el('main', { class: 'card' },
    el('h1', {}, s.reviewTitle!),
    el('p', { class: 'muted' }, s.reviewIntro!),
    msg,
    list,
    el('div', { class: 'row end' }, done),
  ));
});
