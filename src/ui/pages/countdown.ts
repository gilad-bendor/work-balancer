// Countdown (R-UI-COUNTDOWN): "≈ N min of work left today", the context-memory box + feedback (park the thought). Not
// dismissible (no ✕, no Esc) but it can be made small: a pill at the top right (`?pill=1`) that keeps the minutes.
// Its Save ends the day (owner, D-60): the remaining minutes are given up and the block follows.
// Opened without focus (never steals keystrokes); a click gives it focus.
import { act, api, boot, el, fill, focusOnInteract, tellLua, windowId } from './page.ts';
import { parkPanel, type ParkPanel } from './park.ts';
import type { FeedbackValue } from './feedback.ts';

interface Model {
  remainingSeconds: number | null;
  feedbackChoices: string[];
  draft: string;
  feedbackDraft?: FeedbackValue | null;
}

const pill = new URLSearchParams(location.search).get('pill') === '1';
const minutesLeft = (m: Model | null): number => Math.max(0, Math.ceil((m?.remainingSeconds ?? 0) / 60));

void boot<Model | null>(({ strings: s, model }) => {
  focusOnInteract();
  const title = el('h1', {});
  const show = (m: Model | null): void => {
    const n = minutesLeft(m);
    title.textContent = pill ? fill(s.countdownPill, { n }) : n > 0 ? fill(s.countdownTitle, { n }) : s.countdownDone!;
  };
  let park: ParkPanel | null = null;
  const toggle = (action: 'collapse' | 'expand') => async (): Promise<void> => {
    await park?.flush(); // the rebuilt window starts from the daemon's draft
    try {
      await act(action);
    } catch {
      // the next heartbeat retries nothing — the owner can click again
    }
    tellLua('push'); // the daemon rebuilds the window in its other size at once
  };

  if (pill) {
    document.body.classList.add('pill');
    const open = el('button', {}, s.countdownExpand!);
    open.addEventListener('click', () => void toggle('expand')());
    document.body.replaceChildren(el('main', { class: 'card' }, el('div', { class: 'row' }, title, open)));
  } else {
    const small = el('button', {}, s.countdownCollapse!);
    small.addEventListener('click', () => void toggle('collapse')());
    park = parkPanel(s, model?.feedbackChoices ?? [], { draft: model?.draft ?? '', feedbackDraft: model?.feedbackDraft ?? null, saveLabel: s.countdownSave!, savedText: s.countdownSaved!, cmdEnterHint: s.countdownCmdEnter! });
    document.body.classList.add('scroll');
    document.body.replaceChildren(el('main', { class: 'card' },
      el('div', { class: 'row between' }, title, small),
      el('p', { class: 'muted' }, s.countdownIntro!),
      park.root,
    ));
  }
  show(model);
  setInterval(() => {
    void api<{ model: Model | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => show(r.model)).catch(() => {});
  }, 10_000);
});
