// Report cards (the welcome, countdown/block) and compact report rows (Manage Reports, D-83): a report with its
// timestamp and stage; a "stub" for a recent day without a report (add one for that day — picking a stage, not a time —
// or skip the day); the skip confirmation.
import type { ReportStub, ReportView } from '../../reports/reports.ts';
import { act, el, fill, submitOnCmdEnter } from './page.ts';
import { energyStars, reportFields, statusIcon, type ReportValue } from './report-fields.ts';
import { stageIcon } from './day-icons.ts';


type Strings = Record<string, string>;

const dateFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export function ageLabel(daysAgo: number, s: Strings): string {
  return daysAgo === 0 ? s.reportToday! : daysAgo === 1 ? s.reportYesterday! : fill(s.reportDaysAgo, { n: daysAgo });
}

/** "Wednesday 7 October 2026". */
export function dayDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return dateFormat.format(new Date(y!, m! - 1, d!, 12));
}

/** "Wednesday 7 October 2026 · Yesterday". */
export function dayHeading(day: string, daysAgo: number, s: Strings): string {
  return `${dayDate(day)} · ${ageLabel(daysAgo, s)}`;
}

export const stageLabel = (stage: string | null, s: Strings): string => (stage ? s[`stage_${stage}`] ?? stage : '');

/** "2026-10-07 17:22 · end of workday" (a skip: "… · Skipped"). */
export function reportHead(r: ReportView, s: Strings): string {
  return [r.timestamp, stageLabel(r.stage, s), r.skip ? s.reportSkipped : ''].filter(Boolean).join(' · ');
}

/** Status chips, energy and feedback, read-only. */
export function reportBody(r: ReportValue, s: Strings): HTMLElement {
  const body = el('div', { class: 'report-body' });
  if (r.status.length || r.energy !== null) {
    body.append(el('div', { class: 'chips' },
      ...r.status.map((c) => el('span', { class: 'chip static' }, c)),
      ...(r.energy !== null ? [el('span', { class: 'chip static' }, `${s.energyShort} ${r.energy}/5`)] : []),
    ));
  }
  if (r.feedback) body.append(el('p', { class: 'report-text' }, r.feedback));
  return body;
}

export interface ReportHandlers {
  /** Resolves true when saved (the page re-renders); false keeps the editor open. */
  edit?(id: number, value: ReportValue): Promise<boolean>;
  dismiss?(id: number): void;
  undismiss?(id: number): void;
}

export function reportCard(r: ReportView, s: Strings, statuses: readonly string[], h: ReportHandlers): HTMLElement {
  const card = el('article', { class: `report${r.dismissed ? ' dismissed' : ''}${r.skip ? ' skip' : ''}` });
  const head = el('div', { class: 'report-head muted' }, reportHead(r, s));
  let body = reportBody(r, s);
  const actions = el('div', { class: 'row' });
  const view = (): void => {
    actions.replaceChildren();
    if (h.edit && !r.dismissed) {
      const b = el('button', {}, s.edit!);
      b.addEventListener('click', editMode);
      actions.append(b);
    }
    if (h.dismiss && !r.dismissed) {
      const b = el('button', {}, s.dismiss!);
      b.addEventListener('click', () => h.dismiss!(r.id));
      actions.append(b);
    }
    if (h.undismiss && r.dismissed) {
      const b = el('button', {}, s.undismiss!);
      b.addEventListener('click', () => h.undismiss!(r.id));
      actions.append(b);
    }
  };
  const editMode = (): void => {
    const fields = reportFields(s, statuses);
    fields.setValue(r);
    const save = el('button', { class: 'primary' }, s.save!);
    const cancel = el('button', {}, s.cancel!);
    const msg = el('p', { class: 'msg', role: 'status' });
    const editor = el('div', { class: 'report-editor', 'data-draft': '1' }, fields.root, msg);
    body.replaceWith(editor);
    actions.replaceChildren(save, cancel);
    const stop = (): void => {
      body = reportBody(r, s);
      editor.replaceWith(body);
      view();
    };
    cancel.addEventListener('click', stop);
    editor.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        stop();
      }
    });
    const submit = (): void => {
      if (save.disabled) return;
      if (fields.isEmpty()) { msg.textContent = s.nothingToSave!; return; }
      save.disabled = true;
      void h.edit!(r.id, fields.value()).then((ok) => { if (!ok) save.disabled = false; });
    };
    save.addEventListener('click', submit);
    submitOnCmdEnter(fields.feedback, submit);
    fields.feedback.focus();
  };
  view();
  card.append(head, body, actions);
  return card;
}

// Compact rows (Manage Reports, owner 2026-10-18, D-83): one report per line on an invisible grid —
//   | timestamp + part-of-day icon - status icons | feedback (wraps) | energy stars · edit · dismiss |
// Editing / adding opens the same forms as the cards, full width.

const icon = (glyph: string | undefined, name: string): HTMLElement =>
  glyph ? el('span', { class: 'r-icon', title: name, role: 'img', 'aria-label': name }, glyph) : el('span', { class: 'r-tag' }, name);

const iconButton = (glyph: string, label: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', { class: 'icon-btn', title: label, 'aria-label': label }, glyph);
  b.addEventListener('click', onClick);
  return b;
};

function rowHead(r: ReportView, s: Strings): HTMLElement {
  const stage = r.stage ? [' ', stageIcon(r.stage, stageLabel(r.stage, s))] : [];
  const tags = r.status.length ? [el('span', { class: 'r-sep' }, '-'), ...r.status.map((c) => icon(statusIcon(s, c), c))] : [];
  return el('div', { class: 'r-when' }, r.timestamp, ...stage, ...tags);
}

export function reportRow(r: ReportView, s: Strings, statuses: readonly string[], h: ReportHandlers): HTMLElement {
  const row = el('article', { class: `report-row${r.dismissed ? ' dismissed' : ''}${r.skip ? ' skip' : ''}`, 'data-row-day': r.day });
  const view = (): void => {
    row.classList.remove('editing');
    const actions: HTMLElement[] = [];
    if (h.edit && !r.dismissed) actions.push(iconButton('✏️', s.edit!, editMode));
    if (h.dismiss && !r.dismissed) actions.push(iconButton('🗑️', s.dismiss!, () => h.dismiss!(r.id)));
    if (h.undismiss && r.dismissed) actions.push(iconButton('↩️', s.undismiss!, () => h.undismiss!(r.id)));
    row.replaceChildren(
      rowHead(r, s),
      el('div', { class: 'r-text' }, ...(r.skip ? [el('span', { class: 'muted' }, s.reportSkipped!)] : r.feedback ? [r.feedback] : [])),
      el('div', { class: 'r-side' }, energyStars(r.energy, s), el('span', { class: 'r-actions' }, ...actions)),
    );
  };
  const editMode = (): void => {
    const fields = reportFields(s, statuses);
    fields.setValue(r);
    const save = el('button', { class: 'primary' }, s.save!);
    const cancel = el('button', {}, s.cancel!);
    const msg = el('p', { class: 'msg', role: 'status' });
    const editor = el('div', { class: 'report-editor', 'data-draft': '1' }, fields.root, msg);
    row.classList.add('editing');
    row.replaceChildren(el('div', { class: 'report-head muted' }, reportHead(r, s)), editor, el('div', { class: 'row end' }, cancel, save));
    cancel.addEventListener('click', view);
    editor.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        view();
      }
    });
    const submit = (): void => {
      if (save.disabled) return;
      if (fields.isEmpty()) { msg.textContent = s.nothingToSave!; return; }
      save.disabled = true;
      void h.edit!(r.id, fields.value()).then((ok) => { if (!ok) save.disabled = false; });
    };
    save.addEventListener('click', submit);
    submitOnCmdEnter(fields.feedback, submit);
    fields.feedback.focus();
  };
  view();
  return row;
}

/** A recent day without a report, as a compact row; today and yesterday are emphasised. */
export function stubRow(stub: ReportStub, s: Strings, statuses: readonly string[], stages: readonly string[], onChanged: () => void): HTMLElement {
  const row = el('article', { class: `report-row stub${stub.daysAgo <= 1 ? ' fresh' : ''}`, 'data-day': stub.day, 'data-row-day': stub.day });
  const msg = el('span', { class: 'msg', role: 'status' });
  const view = (): void => {
    row.classList.remove('editing');
    // The same icons, in the same column, as a report's edit / dismiss (owner 2026-10-18); names in the tooltips.
    const add = iconButton('✏️', s.reportStubAdd!, () => {
      row.classList.add('editing');
      row.replaceChildren(el('div', { class: 'report-head' }, dayHeading(stub.day, stub.daysAgo, s)),
        catchUpForm(stub, s, statuses, stages, { onSaved: onChanged, onCancel: view }));
    });
    const skip = iconButton('🗑️', s.reportSkip!, () => {
      skip.disabled = true;
      confirmSkip(stub, s, row, (skipped) => {
        if (skipped) onChanged();
        else { skip.disabled = false; msg.textContent = ''; }
      });
    });
    row.replaceChildren(
      el('div', { class: 'r-when' }, stub.day),
      el('div', { class: 'r-text muted' }, msg),
      el('div', { class: 'r-side' }, energyStars(null, s, { empty: true }), el('span', { class: 'r-actions' }, add, skip)),
    );
  };
  view();
  return row;
}

/** Two steps, the confirm enabled after the daemon's delay (0.8 s for today/yesterday): a skip is never a reflex. */
export function confirmSkip(stub: ReportStub, s: Strings, host: HTMLElement, done: (skipped: boolean) => void): void {
  const fail = (): void => done(false);
  void act<{ nonce: string; delayMs: number }>('report-arm-skip', { day: stub.day }).then((r) => {
    if (!r.ok) { fail(); return; }
    const title = fill(s.reportSkipTitle, { date: dayHeading(stub.day, stub.daysAgo, s) });
    const dialog = el('dialog', { 'aria-label': title });
    const cancel = el('button', { class: 'primary', autofocus: '' }, s.reportReturn!);
    const confirm = el('button', {}, s.reportConfirmSkip!);
    confirm.disabled = true;
    const timer = setTimeout(() => { confirm.disabled = false; }, r.delayMs);
    const close = (): void => { clearTimeout(timer); dialog.close(); dialog.remove(); };
    cancel.addEventListener('click', () => { close(); done(false); });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); done(false); });
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
    confirm.addEventListener('click', () => {
      confirm.disabled = true;
      cancel.disabled = true;
      void act('report-skip', { day: stub.day, nonce: r.nonce }).then((x) => { close(); done(x.ok); }, () => { close(); fail(); });
    });
    dialog.append(el('h2', {}, title), el('p', {}, stub.daysAgo <= 1 ? s.reportSkipFresh! : s.reportSkipOlder!), el('div', { class: 'row end' }, cancel, confirm));
    host.append(dialog);
    dialog.showModal();
    cancel.focus();
  }, fail);
}

/** A report for an earlier part of a recent day: the owner picks the stage (default end of workday), not a time. */
export function catchUpForm(stub: ReportStub, s: Strings, statuses: readonly string[], stages: readonly string[], opts: {
  onSaved(): void;
  onCancel?: () => void;
  /** The day is no longer offered here (e.g. a new day began): the page refreshes instead of retrying. */
  onDayRefused?: () => void;
  /** Offer "Skip this day…" inside the form (the welcome). */
  skip?: boolean;
}): HTMLElement {
  let stage = 'end-of-workday';
  const stageButtons = stages.map((x) => {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(x === stage) }, stageIcon(x, ''), ' ', stageLabel(x, s));
    b.addEventListener('click', () => {
      stage = x;
      stageButtons.forEach((y, i) => y.setAttribute('aria-pressed', String(stages[i] === stage)));
    });
    return b;
  });
  const fields = reportFields(s, statuses);
  const msg = el('p', { class: 'msg', role: 'status' });
  const save = el('button', { class: 'primary' }, s.reportSave!);
  const root = el('div', { class: 'catch-up' });
  // Today: a report as of now (its stage follows the clock); earlier days: the picked stage.
  const today = stub.daysAgo === 0;
  const busy = (on: boolean): void => { for (const b of root.querySelectorAll<HTMLButtonElement>('button')) b.disabled = on; fields.feedback.disabled = on; };
  const submit = async (): Promise<void> => {
    if (save.disabled) return;
    if (fields.isEmpty()) { msg.textContent = s.nothingToSave!; return; }
    busy(true);
    try {
      const r = await act(today ? 'report-new' : 'report-add', today ? fields.value() : { day: stub.day, stage, ...fields.value() });
      if (r.ok) { opts.onSaved(); return; }
      if (r.error === 'day' && opts.onDayRefused) { opts.onDayRefused(); return; }
      msg.textContent = r.error === 'empty' ? s.nothingToSave! : s.saveFailed!;
    } catch { msg.textContent = s.saveFailed!; }
    busy(false);
  };
  save.addEventListener('click', () => void submit());
  submitOnCmdEnter(fields.feedback, () => void submit());
  const buttons: HTMLElement[] = [];
  if (opts.onCancel) {
    const cancel = el('button', {}, s.cancel!);
    cancel.addEventListener('click', opts.onCancel);
    buttons.push(cancel);
  }
  if (opts.skip) {
    const skip = el('button', { class: 'small muted' }, s.reportSkip!);
    skip.addEventListener('click', () => {
      busy(true);
      confirmSkip(stub, s, root, (skipped) => {
        if (skipped) opts.onSaved();
        else busy(false);
      });
    });
    buttons.push(skip);
  }
  root.append(
    ...(today ? [] : [el('div', { class: 'stage-row' }, el('span', { class: 'muted' }, s.reportStageQuestion!), el('div', { class: 'chips' }, ...stageButtons))]),
    fields.root, msg, el('div', { class: 'row end' }, ...buttons, save),
  );
  return root;
}
