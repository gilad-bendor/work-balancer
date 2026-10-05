// Break nudge (R-POL-5): after ~90 min of continuous work. Gentle, dismissible, never blocking: "Taking a break now"
// (quiet for this stretch) or snooze (also ✕ / Esc). Opened without focus; a click gives it focus.
import { act, boot, closeOnEscape, el, fill, focusOnInteract, tellLua } from './page.ts';
import { duration } from './format.ts';

interface Model {
  stretchSeconds: number;
  snoozeMin: number;
}

void boot<Model | null>(({ strings: s, model }) => {
  closeOnEscape(s.escUnsaved!);
  focusOnInteract();
  const done = (action: 'break' | 'snooze') => () => void act(action).catch(() => tellLua('close'));
  const rest = el('button', { class: 'primary' }, s.nudgeBreak!);
  const snooze = el('button', {}, fill(s.nudgeSnooze, { m: model?.snoozeMin ?? 15 }));
  rest.addEventListener('click', done('break'));
  snooze.addEventListener('click', done('snooze'));
  document.body.replaceChildren(el('main', { class: 'card' },
    el('h1', {}, fill(s.nudgeTitle, { t: duration((model?.stretchSeconds ?? 0) * 1000, s) })),
    el('p', { class: 'muted' }, s.nudgeBody!),
    el('div', { class: 'row end' }, snooze, rest),
  ));
});
