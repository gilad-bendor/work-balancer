// The report fields (ledger R-UI-REPORT): "How are you doing?" statuses (multi-select, from the policy), energy 1–5
// and a free feedback text. Used by Manage Reports, the welcome, the countdown and the block.
import { el, fill } from './page.ts';

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

/** Five stars filled to the energy level (3.5 = three full, one half, one empty; D-83). No energy: nothing — or, with
 * `empty`, five grey stars (the form's preview). Display only. */
export function energyStars(energy: number | null, s: Strings, opts: { empty?: boolean } = {}): HTMLElement {
  const box = el('span', { class: 'stars' });
  if (energy === null && !opts.empty) return box;
  if (energy !== null) {
    const label = fill(s.reportEnergyOf, { n: energy });
    box.setAttribute('title', label);
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', label);
  } else box.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i++) {
    const f = Math.min(1, Math.max(0, (energy ?? 0) - i));
    box.append(el('span', { class: 'star', 'aria-hidden': 'true', style: `--fill:${f * 100}%` }, '★'));
  }
  return box;
}

/** A status chip / tag icon from strings.ts (`icon_status_<name>`), or undefined. */
export const statusIcon = (s: Strings, status: string): string | undefined => s[`icon_status_${status}`];

/** `onChange`: any status, energy or feedback change (pages use it to keep a draft). */
export function reportFields(s: Strings, statuses: readonly string[], onChange?: () => void): ReportFieldsForm {
  const picked = new Set<string>();
  // Energy: no level, one level N, or two consecutive levels N, N + 1 (= N + 0.5).
  let levels: number[] = [];
  const energyOf = (): number | null => (levels.length ? Math.min(...levels) + (levels.length - 1) * 0.5 : null);
  const legal = (x: number[]): boolean => x.length <= 1 || (x.length === 2 && Math.abs(x[0]! - x[1]!) === 1);

  const toggle = (b: HTMLButtonElement, on: boolean): void => b.setAttribute('aria-pressed', on ? 'true' : 'false');

  const chips = statuses.map((c) => {
    const glyph = statusIcon(s, c);
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, ...(glyph ? [el('span', { class: 'chip-icon', 'aria-hidden': 'true' }, glyph), ' '] : []), c);
    b.addEventListener('click', () => {
      if (picked.has(c)) picked.delete(c);
      else picked.add(c);
      toggle(b, picked.has(c));
      onChange?.();
    });
    return b;
  });

  const stars = el('span', { class: 'energy-stars' });
  const showLevels = (): void => {
    energyButtons.forEach((x, i) => toggle(x, levels.includes(i + 1)));
    stars.replaceChildren(energyStars(energyOf(), s, { empty: true }));
  };
  const halfHint = el('p', { class: 'muted small energy-hint' }, s.energyHalfHint ?? '');
  const energyButtons: HTMLButtonElement[] = [1, 2, 3, 4, 5].map((n) => {
    const b = el('button', { type: 'button', class: 'chip energy', 'aria-pressed': 'false', title: String(n) }, String(n));
    b.addEventListener('click', (e: MouseEvent) => {
      if (e.metaKey) {
        // Cmd+Click toggles one level, but only into a legal state; otherwise the hint blinks.
        const next = levels.includes(n) ? levels.filter((x) => x !== n) : [...levels, n];
        if (!legal(next)) { halfHint.animate?.([{ opacity: 0.2 }, { opacity: 1 }], { duration: 500 }); return; }
        levels = next;
      } else {
        levels = levels.length === 1 && levels[0] === n ? [] : [n]; // clicking the chosen value again clears it
      }
      showLevels();
      onChange?.();
    });
    return b;
  });

  showLevels();
  const feedback = el('textarea', { rows: '2', placeholder: s.reportFeedbackPlaceholder ?? '' });
  if (onChange) feedback.addEventListener('input', onChange);

  const root = el('section', { class: 'report-fields' },
    el('h2', {}, s.reportStatusTitle ?? '', ' ', el('span', { class: 'muted hint' }, `(${s.reportStatusHint ?? ''})`)),
    el('div', { class: 'chips' }, ...chips),
    el('div', { class: 'row energy-row' },
      el('span', { class: 'muted' }, s.reportEnergyLabel ?? ''),
      el('span', { class: 'muted small' }, s.energyLow ?? ''),
      ...energyButtons,
      el('span', { class: 'muted small' }, s.energyHigh ?? ''),
      stars,
    ),
    halfHint,
    feedback,
  );

  return {
    root,
    feedback,
    value: () => ({ status: [...picked], feedback: feedback.value, energy: energyOf() }),
    isEmpty: () => !picked.size && !levels.length && !feedback.value.trim(),
    reset() {
      picked.clear();
      levels = [];
      feedback.value = '';
      chips.forEach((b) => toggle(b, false));
      showLevels();
    },
    setValue(value) {
      picked.clear();
      for (const x of value.status) if (statuses.includes(x)) picked.add(x);
      const e = value.energy;
      levels = e === null ? [] : Number.isInteger(e) ? [e] : [Math.floor(e), Math.ceil(e)];
      feedback.value = value.feedback;
      chips.forEach((b, i) => toggle(b, picked.has(statuses[i]!)));
      showLevels();
    },
  };
}
