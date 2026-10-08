// Manage Reports (menu, R-UI-MENU-3): a new report now (its stage follows the time of day), then every report newest
// first — edit, dismiss — with a stub for each recent day without one (add one for that day, or skip it). Reports
// dismissed here stay visible (greyed, "Bring back") until the window closes; reopened, they are gone.
import type { ReportStub, ReportView } from '../../reports/reports.ts';
import { act, api, boot, closeOnEscape, closeWindow, el, focusOnInteract, submitOnCmdEnter, topBar, windowId } from './page.ts';
import { reportFields, type ReportValue } from './report-fields.ts';
import { reportCard, stubCard } from './report-card.ts';

interface Model {
  today: string;
  reports: ReportView[];
  stubs: ReportStub[];
  statuses: string[];
  stages: string[];
  preferredDay?: string | null;
}

void boot<Model>(({ strings: s, model }) => {
  focusOnInteract();
  let current = model;
  const dismissedHere = new Map<number, ReportView>();
  const list = el('div', { class: 'reports' });
  const msg = el('p', { class: 'msg', role: 'status' });
  const main = el('main', { class: 'card' });
  closeOnEscape(s.escUnsaved!, () => !fields.isEmpty() || !!main.querySelector('.report-editor, .catch-up'));

  /** `done`: the card whose action just succeeded (its editor closes); other open editors keep what was typed. */
  const refresh = async (done: string | null = null): Promise<boolean> => {
    try {
      current = (await api<{ model: Model }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`)).model;
      render(done);
      return true;
    } catch { msg.textContent = s.saveFailed!; return false; }
  };
  const run = async (action: string, payload: unknown, done: string | null = null): Promise<boolean> => {
    msg.textContent = '';
    try {
      const r = await act(action, payload);
      if (r.ok) return await refresh(done);
      msg.textContent = r.error === 'empty' ? s.nothingToSave! : s.saveFailed!;
    } catch { msg.textContent = s.saveFailed!; }
    return false;
  };
  const handlers = {
    edit: (id: number, value: ReportValue) => run('report-edit', { id, ...value }, `r:${id}`),
    dismiss: (id: number) => {
      const r = current.reports.find((x) => x.id === id);
      void run('report-dismiss', { id }).then((ok) => { if (ok && r) { dismissedHere.set(id, { ...r, dismissed: true }); render(); } });
    },
    undismiss: (id: number) => {
      void run('report-undismiss', { id }).then((ok) => { if (ok) { dismissedHere.delete(id); render(); } });
    },
  };

  function render(done: string | null = null): void {
    // A card being edited or filled in is kept as it is: re-rendering would lose what the owner typed.
    const open = new Map([...list.querySelectorAll<HTMLElement>('article[data-key]')]
      .filter((a) => a.dataset.key !== done && a.querySelector('.report-editor, .catch-up'))
      .map((a) => [a.dataset.key!, a]));
    type Entry = { id: string; sort: string; el: () => HTMLElement };
    const live = new Set(current.reports.map((r) => r.id));
    const reports = [...current.reports, ...[...dismissedHere.values()].filter((r) => !live.has(r.id))];
    const entries: Entry[] = [
      ...reports.map((r) => ({ id: `r:${r.id}`, sort: `${r.day} ${r.timestamp} ${String(r.id).padStart(16, '0')}`, el: () => reportCard(r, s, current.statuses, handlers) })),
      // A stub sorts at the end of its day (above that day's reports — there are none — and below later days).
      ...current.stubs.map((x) => ({ id: `s:${x.day}`, sort: `${x.day} ~`, el: () => stubCard(x, s, current.statuses, current.stages, () => void refresh(`s:${x.day}`)) })),
    ].sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0));
    const node = (e: Entry): HTMLElement => {
      const n = open.get(e.id) ?? e.el();
      n.dataset.key = e.id;
      return n;
    };
    list.replaceChildren(...(entries.length ? entries.map(node) : [el('p', { class: 'muted' }, s.reportNone!)]));
  }

  const fields = reportFields(s, current.statuses);
  const save = el('button', { class: 'primary' }, s.reportSave!);
  const submitNew = async (): Promise<void> => {
    if (save.disabled) return;
    if (fields.isEmpty()) { msg.textContent = s.nothingToSave!; return; }
    save.disabled = true;
    if (await run('report-new', fields.value())) { fields.reset(); msg.textContent = s.reportSaved!; }
    save.disabled = false;
  };
  save.addEventListener('click', () => void submitNew());
  submitOnCmdEnter(fields.feedback, () => void submitNew());
  const notNow = el('button', {}, s.reportNotNow!);
  notNow.addEventListener('click', closeWindow);

  render();
  main.replaceChildren(
    el('p', { class: 'muted' }, s.reportsIntro!),
    el('section', { class: 'report-new' }, el('h2', {}, s.reportNewTitle!), fields.root, el('div', { class: 'row end' }, save)),
    msg,
    list,
    ...(current.preferredDay ? [el('div', { class: 'row end' }, notNow)] : []),
  );
  document.body.replaceChildren(topBar(s.reportsTitle!, s.close!), main);
  if (current.preferredDay) list.querySelector(`[data-day="${current.preferredDay}"]`)?.scrollIntoView({ block: 'center' });
  // Day change (04:00): the stubs move on.
  setInterval(() => {
    void api<{ model: Model }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => {
      if (r.model.today === current.today) return;
      current = r.model;
      render();
    }).catch(() => {});
  }, 30_000);
});
