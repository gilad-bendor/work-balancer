// Manage Notes (menu, R-UI-MENU-3): the new-note box first (parking a thought = open it and type), then waiting notes,
// then dismissed ones, each with its date; edit, dismiss, bring back. No delete (D-36).
import { act, boot, closeOnEscape, el, submitOnCmdEnter, topBar } from './page.ts';
import { noteCard, type NoteView } from './notes-view.ts';

void boot<{ notes: NoteView[] } | null>(({ strings: s, model }) => {
  closeOnEscape(s.escUnsaved!);
  let notes = model?.notes ?? [];
  const list = el('div', { class: 'notes' });
  const msg = el('p', { class: 'msg', role: 'status' });

  async function run(action: string, payload: unknown): Promise<boolean> {
    msg.textContent = '';
    try {
      const r = await act<{ notes: NoteView[] }>(action, payload);
      if (r.ok) {
        if (action === 'edit' || action === 'dismiss') drafts.delete((payload as { id: number }).id);
        notes = r.notes;
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
    const waiting = notes.filter((n) => !n.dismissed);
    const dismissed = notes.filter((n) => n.dismissed);
    list.replaceChildren(
      el('h2', {}, s.notesWaiting!),
      ...(waiting.length ? waiting.map((n) => noteCard(n, s, handlers)) : [el('p', { class: 'muted' }, s.notesEmpty!)]),
      ...(dismissed.length ? [el('h2', {}, s.notesDismissed!), ...dismissed.map((n) => noteCard(n, s, handlers))] : []),
    );
  }

  const addBox = el('textarea', { rows: '2', placeholder: s.notesAddPlaceholder! });
  const add = el('button', { class: 'primary' }, s.add!);
  const submitAdd = async (): Promise<void> => {
    if (add.disabled) return;
    if (!addBox.value.trim()) {
      msg.textContent = s.nothingToSave!;
      return;
    }
    add.disabled = true;
    if (await run('add', { text: addBox.value })) addBox.value = '';
    add.disabled = false;
  };
  add.addEventListener('click', () => void submitAdd());
  submitOnCmdEnter(addBox, () => void submitAdd());

  render();
  document.body.replaceChildren(topBar(s.notesTitle!, s.close!), el('main', { class: 'card' },
    el('p', { class: 'muted' }, s.notesIntro!),
    el('div', { class: 'add-note' }, addBox, el('div', { class: 'row end' }, add)),
    msg,
    list,
  ));
  addBox.focus();
});
