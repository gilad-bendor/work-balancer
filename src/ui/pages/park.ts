// "Park the thought" (R-UI-CTX + R-UI-FB) for the countdown and the block: the context-memory box and the feedback form,
// saved through the window's `save` action (notes with source `countdown` / `block`). What was saved is cleared; a part
// that could not be written keeps its text. The box's text is also sent as a `draft` (the countdown's draft reappears
// in the block, so a thought typed a minute before the budget ends is not lost).
import { act, el, submitOnCmdEnter } from './page.ts';
import { feedbackForm } from './feedback.ts';

type Strings = Record<string, string>;
type Part = 'saved' | 'failed' | 'none';

export interface ParkPanel {
  root: HTMLElement;
  box: HTMLTextAreaElement;
}

export function parkPanel(s: Strings, choices: readonly string[], opts: { title?: string; draft?: string; saveLabel?: string; savedText?: string; cmdEnterHint?: string } = {}): ParkPanel {
  const box = el('textarea', { rows: '2', placeholder: s.contextPlaceholder ?? '' });
  box.value = opts.draft ?? '';
  const fb = feedbackForm(s, choices);
  const msg = el('p', { class: 'msg', role: 'status' });
  const saveLabel = opts.saveLabel ?? s.save ?? '';
  const save = el('button', { class: 'primary' }, saveLabel);

  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  box.addEventListener('input', () => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void act('draft', { text: box.value }).catch(() => {}), 700);
  });

  const submit = async (): Promise<void> => {
    if (save.disabled) return;
    if (!box.value.trim() && fb.isEmpty()) {
      msg.textContent = s.nothingToSave ?? '';
      return;
    }
    save.disabled = true;
    save.textContent = s.saving ?? '';
    try {
      const r = await act<{ context: Part; feedback: Part }>('save', { context: box.value, feedback: fb.value() });
      if (r.context === 'saved') box.value = '';
      if (r.feedback === 'saved') fb.reset();
      msg.textContent = r.ok ? (opts.savedText ?? s.savedForTomorrow ?? '') : r.error === 'empty' ? (s.nothingToSave ?? '') : (s.saveFailed ?? '');
    } catch {
      msg.textContent = s.saveFailed ?? '';
    }
    save.disabled = false;
    save.textContent = saveLabel;
  };
  save.addEventListener('click', () => void submit());
  // `cmdEnterHint`: Cmd+Enter does not submit — the countdown's Save ends the day, never by reflex (review M10#6).
  const onCmdEnter = opts.cmdEnterHint ? () => { msg.textContent = opts.cmdEnterHint!; } : () => void submit();
  submitOnCmdEnter(box, onCmdEnter);
  submitOnCmdEnter(fb.comment, onCmdEnter);

  const root = el('section', { class: 'park' },
    ...(opts.title ? [el('h2', {}, opts.title)] : []),
    el('label', { class: 'label' }, s.contextLabel ?? ''),
    box,
    fb.root,
    msg,
    el('div', { class: 'row end' }, save),
  );
  return { root, box };
}
