// "Park the thought" (R-UI-CTX + R-UI-FB) for the countdown and the block: the context-memory box and the feedback form,
// saved through the window's `save` action (notes with source `countdown` / `block`). What was saved is cleared; a part
// that could not be written keeps its text. Both parts are also sent as a `draft`, so they survive the countdown's
// pill ⇄ full rebuilds and reappear in the block (a thought typed a minute before the budget ends is not lost).
import { act, el, submitOnCmdEnter } from './page.ts';
import { feedbackForm, type FeedbackValue } from './feedback.ts';

type Strings = Record<string, string>;
type Part = 'saved' | 'failed' | 'none';

export interface ParkPanel {
  root: HTMLElement;
  box: HTMLTextAreaElement;
  /** Sends a pending draft now (before the window is rebuilt). */
  flush(): Promise<void>;
}

export function parkPanel(s: Strings, choices: readonly string[], opts: { title?: string; draft?: string; feedbackDraft?: FeedbackValue | null; saveLabel?: string; savedText?: string; cmdEnterHint?: string; showFeedback?: boolean } = {}): ParkPanel {
  const box = el('textarea', { rows: '2', placeholder: s.contextPlaceholder ?? '' });
  box.value = opts.draft ?? '';
  const withFeedback = opts.showFeedback !== false;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** The latest draft request, so a flush also waits for one already on its way. */
  let inFlight: Promise<void> = Promise.resolve();
  const sendDraft = (): Promise<void> => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    // Without the form on screen, the feedback draft is left as it is. Chained: drafts reach the daemon in order, each
    // with the values of the moment it is sent.
    inFlight = inFlight.then(() => act('draft', withFeedback ? { text: box.value, feedback: fb.value() } : { text: box.value })).then(() => {}, () => {});
    return inFlight;
  };
  const scheduleDraft = (): void => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void sendDraft(), 700);
  };
  const flush = (): Promise<void> => (draftTimer ? sendDraft() : inFlight);
  const fb = feedbackForm(s, choices, scheduleDraft);
  if (withFeedback && opts.feedbackDraft) fb.setValue(opts.feedbackDraft);
  const msg = el('p', { class: 'msg', role: 'status' });
  const saveLabel = opts.saveLabel ?? s.save ?? '';
  const save = el('button', { class: 'primary' }, saveLabel);

  box.addEventListener('input', scheduleDraft);

  const submit = async (): Promise<void> => {
    if (save.disabled) return;
    if (!box.value.trim() && fb.isEmpty()) {
      msg.textContent = s.nothingToSave ?? '';
      return;
    }
    save.disabled = true;
    save.textContent = s.saving ?? '';
    // Send the last edits first (also a cleared part), so the save forgets exactly what it wrote.
    await flush();
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
    ...(withFeedback ? [fb.root] : []),
    msg,
    el('div', { class: 'row end' }, save),
  );
  return { root, box, flush };
}
