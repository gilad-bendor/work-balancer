import type { DailyReport } from '../../reports/reports.ts';
import { api, boot, closeOnEscape, closeWindow, el, focusOnInteract, topBar, windowId } from './page.ts';
import { reportForm, reportLabel } from './report-form.ts';

interface Model { today: string; reports: DailyReport[]; feedbackChoices: string[]; preferredDay?: string | null }

void boot<Model>(({ strings: s, model }) => {
  focusOnInteract();
  const main = el('main', { class: 'card wide' });
  const picker = el('div', { class: 'chips' });
  const form = el('div');
  const hint = el('p', { class: 'msg', role: 'status' });
  const notNow = el('button', {}, s.reportNotNow!);
  notNow.addEventListener('click', closeWindow);
  let current = model;
  let selected: string | null = null;
  const forms = new Map<string, { root: HTMLElement; report: DailyReport }>();
  closeOnEscape(s.escUnsaved!, () => [...forms.values()].some(({ root }) =>
    !!root.querySelector('button[aria-pressed=true]')
    || [...root.querySelectorAll<HTMLTextAreaElement>('textarea')].some((box) => box.value.trim() !== '')));
  const refresh = async (): Promise<void> => {
    try {
      current = (await api<{ model: Model }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`)).model;
      render();
    } catch { hint.textContent = s.saveFailed!; }
  };
  function render(): void {
    const reports = [...current.reports].reverse();
    for (const [day, cached] of forms) {
      const latest = reports.find((r) => r.day === day);
      if (!latest) continue;
      cached.report.daysAgo = latest.daysAgo;
      const heading = cached.root.querySelector('h2');
      if (heading) heading.textContent = reportLabel(latest, s);
      const question = cached.root.querySelector('.feedback h2');
      if (question) question.textContent = latest.daysAgo === 0 ? s.reportQuestionToday! : s.reportQuestion!;
    }
    if (!selected) selected = current.preferredDay ?? reports.find((r) => r.status === 'pending')?.day ?? reports[0]?.day ?? null;
    picker.replaceChildren(...reports.map((r) => {
      const button = el('button', { class: 'chip', 'aria-pressed': String(r.day === selected) },
        `${reportLabel(r, s)}${r.status === 'pending' ? '' : ` · ${r.status === 'answered' ? s.reportAnswered : s.reportSkipped}`}`);
      button.addEventListener('click', () => {
        selected = r.day; render();
      });
      return button;
    }));
    const report = reports.find((r) => r.day === selected);
    if (report && !forms.has(report.day)) forms.set(report.day, {
      report,
      root: reportForm(report, s, current.feedbackChoices, () => {
        forms.delete(report.day);
        void refresh();
      }),
    });
    form.replaceChildren(...(report ? [forms.get(report.day)!.root] : [el('p', {}, s.reportEmpty!)]));
  }
  render();
  main.append(el('p', { class: 'muted' }, s.reportIntro!), picker, hint, form, el('div', { class: 'row end' }, notNow));
  document.body.replaceChildren(topBar(s.reportTitle!, s.close!), main);
  setInterval(() => {
    void api<{ model: Model }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => {
      if (r.model.today === current.today) return;
      current = r.model;
      render();
    }).catch(() => { hint.textContent = s.saveFailed!; });
  }, 30_000);
});
