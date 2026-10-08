// Countdown (R-UI-COUNTDOWN): "≈ N min of work left today", a note box + an end-of-workday report (park the thought).
// Not dismissible (no ✕, no Esc) but it can be made small: a pill at the top right (`?pill=1`) that keeps the minutes.
// Its Save ends the day (owner, D-60): the remaining minutes are given up and the block follows.
// Opened without focus (never steals keystrokes); a click gives it focus.
// `?early=1` (menu "Early End-Of-Day"): the same dialog opened by the owner — closable (✕, Esc), no pill.
import type { ReportView } from '../../reports/reports.ts';
import { act, api, boot, closeOnEscape, el, fill, focusOnInteract, tellLua, windowId } from './page.ts';
import { parkPanel, type ParkPanel } from './park.ts';
import type { ReportValue } from './report-fields.ts';

interface Model {
  remainingSeconds: number | null;
  reportStatuses: string[];
  draft: string;
  reportDraft?: ReportValue | null;
  recorded?: ReportView[];
}

const params = new URLSearchParams(location.search);
const pill = params.get('pill') === '1';
const early = params.get('early') === '1';
const minutesLeft = (m: Model | null): number => Math.max(0, Math.ceil((m?.remainingSeconds ?? 0) / 60));

void boot<Model | null>(({ strings: s, model }) => {
  focusOnInteract();
  const title = el('h1', {});
  const show = (m: Model | null): void => {
    const n = minutesLeft(m);
    title.textContent = early ? s.countdownEarlyTitle! : pill ? fill(s.countdownPill, { n }) : n > 0 ? fill(s.countdownTitle, { n }) : s.countdownDone!;
  };
  let park: ParkPanel | null = null;
  const toggle = (action: 'collapse' | 'expand') => async (): Promise<void> => {
    await park?.flush(); // the rebuilt window starts from the daemon's draft
    try {
      await act(action);
    } catch {
      // the next heartbeat retries nothing — the owner can click again
    }
    tellLua('push'); // the daemon rebuilds the window in its other size at once
  };

  if (pill) {
    document.body.classList.add('pill');
    const open = el('button', {}, s.countdownExpand!);
    open.addEventListener('click', () => void toggle('expand')());
    document.body.replaceChildren(el('main', { class: 'card' }, el('div', { class: 'row' }, title, open)));
  } else {
    park = parkPanel(s, model?.reportStatuses ?? [], {
      draft: model?.draft ?? '', reportDraft: model?.reportDraft ?? null, recorded: model?.recorded ?? [],
      saveLabel: s.countdownSave!, savedText: s.countdownSaved!, cmdEnterHint: s.countdownCmdEnter!,
    });
    const box = park.box;
    if (early) closeOnEscape(s.escUnsaved!, () => [...document.querySelectorAll('textarea')].some((t) => t.value.trim() !== '') || !!document.querySelector('.report-fields button[aria-pressed=true]'));
    const small = el('button', {}, s.countdownCollapse!);
    small.addEventListener('click', () => void toggle('collapse')());
    document.body.classList.add('scroll');
    document.body.replaceChildren(el('main', { class: 'card' },
      el('div', { class: 'row between' }, title, ...(early ? [] : [small])),
      el('p', { class: 'muted' }, early ? s.countdownEarlyIntro! : s.countdownIntro!),
      park.root,
    ));
    if (early) box.focus();
  }
  show(model);
  setInterval(() => {
    void api<{ model: Model | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => show(r.model)).catch(() => {});
  }, 10_000);
});
