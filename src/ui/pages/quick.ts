// Quick note (menu → "Quick note…", R-UI-MENU-2): context-memory box (R-UI-CTX) + feedback form (R-UI-FB).
// Saved parts are cleared; a part that could not be written keeps its text (the owner's words are never lost).
import { act, boot, closeOnEscape, closeWindow, el, submitOnCmdEnter } from './page.ts';
import { feedbackForm } from './feedback.ts';

type Part = 'saved' | 'failed' | 'none';

void boot<{ feedbackChoices: string[] } | null>(({ strings: s, model }) => {
  closeOnEscape(s.escUnsaved!);
  const ctx = el('textarea', { rows: '3', placeholder: s.contextPlaceholder! });
  const fb = feedbackForm(s, model?.feedbackChoices ?? []);
  const msg = el('p', { class: 'msg', role: 'status' });
  const save = el('button', { class: 'primary' }, s.save!);
  const close = el('button', {}, s.close!);

  const submit = async (): Promise<void> => {
    if (save.disabled) return;
    if (!ctx.value.trim() && fb.isEmpty()) {
      msg.textContent = s.nothingToSave!;
      return;
    }
    save.disabled = true;
    save.textContent = s.saving!;
    try {
      const r = await act<{ context: Part; feedback: Part }>('submit', { context: ctx.value, feedback: fb.value() });
      if (r.context === 'saved') ctx.value = '';
      if (r.feedback === 'saved') fb.reset();
      if (r.ok) {
        msg.textContent = s.quickSaved!;
        setTimeout(closeWindow, 1200);
        return;
      }
      msg.textContent = r.error === 'empty' ? s.nothingToSave! : s.saveFailed!;
    } catch {
      msg.textContent = s.saveFailed!;
    }
    save.disabled = false;
    save.textContent = s.save!;
  };
  save.addEventListener('click', () => void submit());
  submitOnCmdEnter(ctx, () => void submit());
  submitOnCmdEnter(fb.comment, () => void submit());
  close.addEventListener('click', closeWindow);

  document.body.replaceChildren(el('main', { class: 'card' },
    el('h1', {}, s.quickTitle!),
    el('p', { class: 'muted' }, s.quickIntro!),
    el('label', { class: 'label' }, s.contextLabel!),
    ctx,
    fb.root,
    msg,
    el('div', { class: 'row end' }, close, save),
  ));
  ctx.focus();
});
