// The reusable feedback form (ledger R-UI-FB): multi-select choices from the policy's `feedbackChoices`, a free-text
// comment, and an optional energy 1–5. Used by the quick note now and by countdown / block / review later (M10).
import { el } from './page.ts';

type Strings = Record<string, string>;

export interface FeedbackValue {
  choices: string[];
  text: string;
  energy: number | null;
}

export interface FeedbackForm {
  root: HTMLElement;
  comment: HTMLTextAreaElement;
  value(): FeedbackValue;
  isEmpty(): boolean;
  reset(): void;
  setValue(value: FeedbackValue): void;
}

export function feedbackForm(s: Strings, choices: readonly string[]): FeedbackForm {
  const picked = new Set<string>();
  let energy: number | null = null;

  const toggle = (b: HTMLButtonElement, on: boolean): void => b.setAttribute('aria-pressed', on ? 'true' : 'false');

  const chips = choices.map((c) => {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, c);
    b.addEventListener('click', () => {
      if (picked.has(c)) picked.delete(c);
      else picked.add(c);
      toggle(b, picked.has(c));
    });
    return b;
  });

  const energyButtons = [1, 2, 3, 4, 5].map((n) => {
    const b = el('button', { type: 'button', class: 'chip energy', 'aria-pressed': 'false', title: String(n) }, String(n));
    b.addEventListener('click', () => {
      energy = energy === n ? null : n; // clicking the chosen value again clears it
      energyButtons.forEach((x, i) => toggle(x, energy === i + 1));
    });
    return b;
  });

  const comment = el('textarea', { rows: '2', placeholder: s.feedbackComment ?? '' });

  const root = el('section', { class: 'feedback' },
    el('h2', {}, s.feedbackTitle ?? ''),
    el('p', { class: 'muted' }, s.feedbackHint ?? ''),
    el('div', { class: 'chips' }, ...chips),
    el('div', { class: 'row energy-row' },
      el('span', { class: 'muted' }, s.energyLabel ?? ''),
      el('span', { class: 'muted small' }, s.energyLow ?? ''),
      ...energyButtons,
      el('span', { class: 'muted small' }, s.energyHigh ?? ''),
    ),
    comment,
  );

  return {
    root,
    comment,
    value: () => ({ choices: [...picked], text: comment.value, energy }),
    isEmpty: () => !picked.size && energy === null && !comment.value.trim(),
    reset() {
      picked.clear();
      energy = null;
      comment.value = '';
      [...chips, ...energyButtons].forEach((b) => toggle(b, false));
    },
    setValue(value) {
      picked.clear();
      for (const choice of value.choices) if (choices.includes(choice)) picked.add(choice);
      energy = value.energy;
      comment.value = value.text;
      chips.forEach((b, i) => toggle(b, picked.has(choices[i]!)));
      energyButtons.forEach((b, i) => toggle(b, energy === i + 1));
    },
  };
}
