// "Park the thought" for the countdown and the block: a note box (R-UI-NOTE) and an end-of-workday report
// (R-UI-REPORT), saved through the window's `save` action. What was saved is cleared; a part that could not be written
// keeps its text. Both parts are also sent as a `draft`, so they survive the countdown's pill ⇄ full rebuilds and
// reappear in the block (a thought typed a minute before the budget ends is not lost). Once today has an end-of-workday
// report, it is shown instead of a second empty form ("Add another report" opens one).
import type { ReportView } from '../../reports/reports.ts';
import { act, el, submitOnCmdEnter } from './page.ts';
import { reportFields, type ReportValue } from './report-fields.ts';
import { reportBody, reportHead } from './report-card.ts';

type Strings = Record<string, string>;
type Part = 'saved' | 'failed' | 'none';

export interface ParkPanel {
  root: HTMLElement;
  box: HTMLTextAreaElement;
  /** Sends a pending draft now (before the window is rebuilt). */
  flush(): Promise<void>;
}

export function parkPanel(s: Strings, statuses: readonly string[], opts: {
  title?: string; draft?: string; reportDraft?: ReportValue | null; recorded?: ReportView[];
  saveLabel?: string; savedText?: string; cmdEnterHint?: string;
} = {}): ParkPanel {
  const box = el('textarea', { rows: '2', placeholder: s.notePlaceholder ?? '' });
  box.value = opts.draft ?? '';
  let recorded = opts.recorded ?? [];
  let showReport = recorded.length === 0 || !!opts.reportDraft;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** The latest draft request, so a flush also waits for one already on its way. */
  let inFlight: Promise<void> = Promise.resolve();
  const sendDraft = (): Promise<void> => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    // Without the form on screen, the report draft is left as it is. Chained: drafts reach the daemon in order, each
    // with the values of the moment it is sent.
    inFlight = inFlight.then(() => act('draft', showReport ? { text: box.value, report: fields.value() } : { text: box.value })).then(() => {}, () => {});
    return inFlight;
  };
  const scheduleDraft = (): void => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void sendDraft(), 700);
  };
  const flush = (): Promise<void> => (draftTimer ? sendDraft() : inFlight);
  const fields = reportFields(s, statuses, scheduleDraft);
  if (opts.reportDraft) fields.setValue(opts.reportDraft);
  const msg = el('p', { class: 'msg', role: 'status' });
  const saveLabel = opts.saveLabel ?? s.save ?? '';
  const save = el('button', { class: 'primary' }, saveLabel);
  const reportSlot = el('div');

  const renderReport = (): void => {
    const done = recorded.length ? [el('div', { class: 'recorded' },
      el('p', { class: 'muted' }, s.reportRecordedToday ?? ''),
      ...recorded.map((r) => el('div', { class: 'report' }, el('div', { class: 'report-head muted' }, reportHead(r, s)), reportBody(r, s))),
    )] : [];
    if (showReport) {
      reportSlot.replaceChildren(...done, fields.root);
      return;
    }
    const another = el('button', {}, s.reportAddAnother ?? '');
    another.addEventListener('click', () => { showReport = true; renderReport(); });
    reportSlot.replaceChildren(...done, el('div', { class: 'row' }, another));
  };
  renderReport();

  box.addEventListener('input', scheduleDraft);

  const submit = async (): Promise<void> => {
    if (save.disabled) return;
    if (!box.value.trim() && (!showReport || fields.isEmpty())) {
      msg.textContent = s.nothingToSave ?? '';
      return;
    }
    save.disabled = true;
    save.textContent = s.saving ?? '';
    // Send the last edits first (also a cleared part), so the save forgets exactly what it wrote.
    await flush();
    try {
      const value = fields.value();
      const r = await act<{ note: Part; report: Part; forfeited?: boolean }>('save', { note: box.value, report: showReport ? value : null });
      if (r.note === 'saved') box.value = '';
      if (r.report === 'saved') {
        fields.reset();
        recorded = [...recorded, { ...value, id: 0, timestamp: '', day: '', stage: 'end-of-workday', source: 'block', createdAt: 0, skip: false, dismissed: false }];
        showReport = false;
        renderReport();
      }
      // Saved, but the day could not be ended (the forfeit record failed): say exactly that.
      msg.textContent = r.ok && r.forfeited === false ? (s.countdownNotEnded ?? '')
        : r.ok ? (opts.savedText ?? s.savedForTomorrow ?? '') : r.error === 'empty' ? (s.nothingToSave ?? '') : (s.saveFailed ?? '');
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
  submitOnCmdEnter(fields.feedback, onCmdEnter);

  const root = el('section', { class: 'park' },
    ...(opts.title ? [el('h2', {}, opts.title)] : []),
    el('label', { class: 'label' }, s.noteLabel ?? ''),
    box,
    reportSlot,
    msg,
    el('div', { class: 'row end' }, save),
  );
  return { root, box, flush };
}
