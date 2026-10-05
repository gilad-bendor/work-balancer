// Warn dialog (R-UI-WARN): a gentle heads-up when about 30 worked minutes are left; dismissible (Got it / ✕ / Esc),
// once per level entry. Opened without focus (never steals keystrokes); a click gives it focus.
import { boot, closeOnEscape, closeWindow, el, fill, focusOnInteract } from './page.ts';

interface Model {
  remainingSeconds: number | null;
  countdownBeforeMin: number | null;
}

void boot<Model | null>(({ strings: s, model }) => {
  closeOnEscape(s.escUnsaved!);
  focusOnInteract();
  const n = Math.max(1, Math.ceil((model?.remainingSeconds ?? 0) / 60));
  const ok = el('button', { class: 'primary' }, s.warnOk!);
  ok.addEventListener('click', closeWindow);
  document.body.replaceChildren(el('main', { class: 'card' },
    el('h1', {}, fill(s.warnTitle, { n })),
    el('p', { class: 'muted' }, fill(s.warnBody, { m: model?.countdownBeforeMin ?? 10 })),
    el('div', { class: 'row end' }, ok),
  ));
});
