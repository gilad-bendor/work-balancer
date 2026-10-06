import type { DailyReport } from '../../reports/reports.ts';
import { act, el, fill, submitOnCmdEnter } from './page.ts';
import { feedbackForm } from './feedback.ts';

const dateFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export function reportLabel(report: DailyReport, s: Record<string, string>): string {
  const [y, m, d] = report.day.split('-').map(Number);
  const age = report.daysAgo === 0 ? s.reportToday : report.daysAgo === 1 ? s.reportYesterday : fill(s.reportDaysAgo, { n: report.daysAgo });
  return `${dateFormat.format(new Date(y!, m! - 1, d!, 12))} · ${age}`;
}

export function reportForm(report: DailyReport, s: Record<string, string>, choices: readonly string[], onSaved: () => void): HTMLElement {
  const root = el('section', { class: 'daily-report' });
  const heading = el('h2', {}, reportLabel(report, s));
  if (report.status === 'answered') {
    const amend = el('button', {}, s.reportAmend!);
    amend.addEventListener('click', () => edit());
    root.append(heading, el('p', {}, `${s.reportAnswered}: ${report.energy}/5`), amend);
  } else edit();

  function edit(): void {
    const fb = feedbackForm({ ...s, feedbackTitle: report.daysAgo === 0 ? s.reportQuestionToday! : s.reportQuestion!, energyLabel: s.reportEnergy! }, choices);
    fb.setValue(report);
    const hint = el('p', { class: 'msg', role: 'status' });
    const save = el('button', { class: 'primary' }, s.reportSave!);
    const skip = el('button', { class: 'small muted' }, s.reportSkip!);
    const controls = el('div', { class: 'row end' }, ...(report.status === 'pending' ? [skip] : []), save);
    const form = el('div', {}, fb.root, hint, controls);
    const busy = (value: boolean): void => { for (const button of root.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value; fb.comment.disabled = value; };
    const submit = async (): Promise<void> => {
      if (save.disabled) return;
      if (fb.value().energy === null) { hint.textContent = s.reportEnergyRequired!; return; }
      busy(true);
      try {
        const r = await act('report-submit', { day: report.day, ...fb.value() });
        if (r.ok) { busy(false); hint.textContent = s.reportAnswered!; onSaved(); return; }
        hint.textContent = r.error === 'energy' ? s.reportEnergyRequired! : s.saveFailed!;
      } catch { hint.textContent = s.saveFailed!; }
      busy(false);
    };
    save.addEventListener('click', () => void submit());
    submitOnCmdEnter(fb.comment, () => void submit());
    skip.addEventListener('click', async () => {
      busy(true);
      try {
        const r = await act<{ nonce: string; delayMs: number }>('report-arm-skip', { day: report.day });
        if (!r.ok) { hint.textContent = s.saveFailed!; busy(false); return; }
        const dialog = el('dialog', { 'aria-label': fill(s.reportSkipTitle, { date: reportLabel(report, s) }) });
        const cancel = el('button', { class: 'primary', autofocus: '' }, s.reportReturn!);
        const confirm = el('button', {}, s.reportConfirmSkip!);
        confirm.disabled = true;
        const timer = setTimeout(() => { confirm.disabled = false; }, r.delayMs);
        const dismiss = (): void => { clearTimeout(timer); dialog.close(); dialog.remove(); busy(false); };
        cancel.addEventListener('click', dismiss);
        dialog.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); });
        dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
        confirm.addEventListener('click', async () => {
          confirm.disabled = true;
          cancel.disabled = true;
          try {
            const skipped = await act('report-skip', { day: report.day, nonce: r.nonce });
            if (skipped.ok) { dismiss(); onSaved(); return; }
            hint.textContent = s.saveFailed!;
          } catch { hint.textContent = s.saveFailed!; }
          dismiss();
        });
        dialog.append(el('h2', {}, fill(s.reportSkipTitle, { date: reportLabel(report, s) })), el('p', {}, report.daysAgo <= 1 ? s.reportSkipFresh! : s.reportSkipOlder!), el('div', { class: 'row end' }, cancel, confirm));
        root.append(dialog);
        dialog.showModal();
        cancel.focus();
      } catch { hint.textContent = s.saveFailed!; busy(false); }
    });
    root.replaceChildren(heading, ...(report.status === 'skipped' ? [el('p', { class: 'muted' }, s.reportSkipped!)] : []), form);
  }
  return root;
}
