// A note as a card (notes manager, morning review): date · kind, feedback choices/energy, text, and the actions the
// page offers (edit in place, dismiss, bring back).
import { el, submitOnCmdEnter } from './page.ts';
import { dayLabel } from './format.ts';

type Strings = Record<string, string>;

export interface NoteView {
  id: string;
  kind: 'context' | 'feedback' | 'note';
  text: string;
  choices: string[];
  energy: number | null;
  day: string;
  createdAt: number;
  dismissed: boolean;
}

export interface NoteHandlers {
  /** Unsaved editor text per note id: kept across re-renders (another note's action must not lose it). */
  drafts?: Map<string, string>;
  /** Resolves true when saved (the page re-renders); false keeps the editor open with the text. */
  edit?(id: string, text: string): Promise<boolean>;
  dismiss?(id: string): void;
  undismiss?(id: string): void;
}

const KIND: Record<NoteView['kind'], string> = { context: 'kindContext', feedback: 'kindFeedback', note: 'kindNote' };

export function noteCard(n: NoteView, s: Strings, h: NoteHandlers): HTMLElement {
  const card = el('article', { class: `note${n.dismissed ? ' dismissed' : ''}` });
  const head = el('div', { class: 'note-head muted' }, `${dayLabel(n.day)} · ${s[KIND[n.kind]] ?? n.kind}`);
  const body = el('div', { class: 'note-body' });
  if (n.choices.length || n.energy !== null) {
    body.append(el('div', { class: 'chips' },
      ...n.choices.map((c) => el('span', { class: 'chip static' }, c)),
      ...(n.energy !== null ? [el('span', { class: 'chip static' }, `${s.energyShort ?? ''} ${n.energy}/5`)] : []),
    ));
  }
  if (n.text) body.append(el('p', { class: 'note-text' }, n.text));

  const actions = el('div', { class: 'row' });
  let restoring = false;
  const view = (): void => {
    actions.replaceChildren();
    if (h.edit && !n.dismissed) {
      const b = el('button', {}, s.edit ?? 'Edit');
      b.addEventListener('click', editMode);
      actions.append(b);
    }
    if (h.dismiss && !n.dismissed) {
      const b = el('button', {}, s.dismiss ?? 'Dismiss');
      b.addEventListener('click', () => h.dismiss!(n.id));
      actions.append(b);
    }
    if (h.undismiss && n.dismissed) {
      const b = el('button', {}, s.undismiss ?? 'Bring back');
      b.addEventListener('click', () => h.undismiss!(n.id));
      actions.append(b);
    }
  };
  const editMode = (): void => {
    const area = el('textarea', { rows: '3', 'data-draft': '1' });
    area.value = h.drafts?.get(n.id) ?? n.text;
    h.drafts?.set(n.id, area.value);
    area.addEventListener('input', () => h.drafts?.set(n.id, area.value));
    const save = el('button', { class: 'primary' }, s.save ?? 'Save');
    const cancel = el('button', {}, s.cancel ?? 'Cancel');
    const textEl = body.querySelector('.note-text');
    if (textEl) textEl.replaceWith(area);
    else body.append(area);
    actions.replaceChildren(save, cancel);
    const stopEditing = (): void => {
      h.drafts?.delete(n.id);
      area.replaceWith(...(n.text ? [el('p', { class: 'note-text' }, n.text)] : []));
      view();
    };
    cancel.addEventListener('click', stopEditing);
    area.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        stopEditing();
      }
    });
    const submit = (): void => {
      if (save.disabled) return;
      save.disabled = true;
      void h.edit!(n.id, area.value).then((ok) => { if (!ok) save.disabled = false; });
    };
    save.addEventListener('click', submit);
    submitOnCmdEnter(area, submit);
    if (!restoring) area.focus();
  };
  view();
  if (h.drafts?.has(n.id) && h.edit && !n.dismissed) {
    restoring = true;
    editMode();
    restoring = false;
  }
  card.append(head, body, actions);
  return card;
}
