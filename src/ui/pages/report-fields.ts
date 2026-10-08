// The report fields (ledger R-UI-REPORT): "How are you doing?" statuses (multi-select, from the policy), energy 1–5
// and a free feedback text. Used by Manage Reports, the welcome, the countdown and the block.
import { el } from './page.ts';

type Strings = Record<string, string>;

export interface ReportValue {
  status: string[];
  feedback: string;
  energy: number | null;
}

export interface ReportFieldsForm {
  root: HTMLElement;
  feedback: HTMLTextAreaElement;
  value(): ReportValue;
  isEmpty(): boolean;
  reset(): void;
  setValue(value: ReportValue): void;
}

/** `onChange`: any status, energy or feedback change (pages use it to keep a draft). */
export function reportFields(s: Strings, statuses: readonly string[], onChange?: () => void): ReportFieldsForm {
  const picked = new Set<string>();
  let energy: number | null = null;

  const toggle = (b: HTMLButtonElement, on: boolean): void => b.setAttribute('aria-pressed', on ? 'true' : 'false');

  const chips = statuses.map((c) => {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, c);
    b.addEventListener('click', () => {
      if (picked.has(c)) picked.delete(c);
      else picked.add(c);
      toggle(b, picked.has(c));
      onChange?.();
    });
    return b;
  });

  const energyButtons = [1, 2, 3, 4, 5].map((n) => {
    const b = el('button', { type: 'button', class: 'chip energy', 'aria-pressed': 'false', title: String(n) }, String(n));
    b.addEventListener('click', () => {
      energy = energy === n ? null : n; // clicking the chosen value again clears it
      energyButtons.forEach((x, i) => toggle(x, energy === i + 1));
      onChange?.();
    });
    return b;
  });

  const feedback = el('textarea', { rows: '2', placeholder: s.reportFeedbackPlaceholder ?? '' });
  if (onChange) feedback.addEventListener('input', onChange);

  const root = el('section', { class: 'report-fields' },
    el('h2', {}, s.reportStatusTitle ?? ''),
    el('p', { class: 'muted' }, s.reportStatusHint ?? ''),
    el('div', { class: 'chips' }, ...chips),
    el('div', { class: 'row energy-row' },
      el('span', { class: 'muted' }, s.reportEnergyLabel ?? ''),
      el('span', { class: 'muted small' }, s.energyLow ?? ''),
      ...energyButtons,
      el('span', { class: 'muted small' }, s.energyHigh ?? ''),
    ),
    feedback,
  );

  return {
    root,
    feedback,
    value: () => ({ status: [...picked], feedback: feedback.value, energy }),
    isEmpty: () => !picked.size && energy === null && !feedback.value.trim(),
    reset() {
      picked.clear();
      energy = null;
      feedback.value = '';
      [...chips, ...energyButtons].forEach((b) => toggle(b, false));
    },
    setValue(value) {
      picked.clear();
      for (const x of value.status) if (statuses.includes(x)) picked.add(x);
      energy = value.energy;
      feedback.value = value.feedback;
      chips.forEach((b, i) => toggle(b, picked.has(statuses[i]!)));
      energyButtons.forEach((b, i) => toggle(b, energy === i + 1));
    },
  };
}
