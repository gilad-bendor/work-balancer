// Inactivity dialog (R-UI-INACT, D-56): full screen on every screen, no Esc, no timeout — it ends by answering. Input
// while it is up does not end the gap: the gap keeps growing (live, with seconds) until Submit. A slider of the minutes
// worked (0 = back, the default rule · max = the whole gap · between = some): pinned to max it follows the growing gap,
// otherwise it keeps its minutes (and drifts left). Two presets move it (highlighted iff it is at their value); Submit
// is enabled once the owner touched a preset or the slider. Inputs on the primary screen only.
import { act, api, boot, el, isPrimary, windowId } from './page.ts';
import { duration, timeLabel } from './format.ts';

interface Gap {
  gapId: string;
  from: number;
  /** Fixed end (the owner returned before the dialog appeared), or null: the gap is still growing. */
  to: number | null;
  maxMinutes: number;
}

interface Model {
  now: number;
  gaps: Gap[];
}

const clock = (ms: number): string => {
  const t = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${Math.floor(t / 60)}:${ss}`;
};

void boot<Model | null>(({ strings: s, model }) => {
  document.body.classList.add('mode-overlay');
  if (!isPrimary) {
    document.body.replaceChildren(el('main', { class: 'card' }, el('h1', {}, s.inactTitle!), el('p', {}, s.inactOtherScreen!)));
    return;
  }
  // The daemon's clock (a dev instance may run a fake one).
  let skew = model ? model.now - Date.now() : 0;
  const now = (): number => Date.now() + skew;
  let gap: Gap | null = model?.gaps[0] ?? null;
  let minutes = 0;
  let pinned = false; // "whole": follows the growing gap
  let touched = false;

  const since = el('p', { class: 'gap-since' });
  const timer = el('span', { class: 'gap-timer' });
  const back = el('button', { type: 'button', class: 'chip' }, s.inactBack!);
  const whole = el('button', { type: 'button', class: 'chip' }, s.inactWhole!);
  const slider = el('input', { type: 'range', min: '0', max: '0', step: '1', value: '0' });
  const label = el('span', { class: 'some-label' });
  const submit = el('button', { class: 'primary' }, s.inactSubmit!);
  const msg = el('p', { class: 'msg', role: 'status' });
  submit.disabled = true;

  const end = (): number => (gap?.to ?? now());
  const maxMin = (): number => (gap ? Math.floor(Math.max(0, end() - gap.from) / 60_000) : 0);

  function update(): void {
    if (!gap) return;
    since.textContent = `${s.inactAway} ${timeLabel(gap.from)}${gap.to !== null ? ` – ${timeLabel(gap.to)}` : ''} · `;
    since.append(timer);
    timer.textContent = clock(end() - gap.from);
    const max = maxMin();
    slider.max = String(max);
    if (pinned) minutes = max;
    minutes = Math.min(minutes, max);
    slider.value = String(minutes);
    label.textContent = `${s.inactWorked} ${minutes} ${s.inactMin} ${s.inactOf} ${max}`;
    back.setAttribute('aria-pressed', minutes === 0 && !pinned ? 'true' : 'false');
    whole.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  }
  const touch = (): void => {
    touched = true;
    submit.disabled = false;
  };

  back.addEventListener('click', () => { pinned = false; minutes = 0; touch(); update(); });
  whole.addEventListener('click', () => { pinned = true; touch(); update(); });
  slider.addEventListener('input', () => {
    minutes = Number(slider.value);
    pinned = minutes >= maxMin() && minutes > 0;
    touch();
    update();
  });
  submit.addEventListener('click', async () => {
    if (!gap || !touched) return;
    submit.disabled = true;
    msg.textContent = '';
    try {
      const choice = pinned ? 'whole' : minutes === 0 ? 'back' : 'some';
      const r = await act('resolve', { gapId: gap.gapId, choice, minutes });
      if (r.ok) return; // the daemon closes the dialog
      msg.textContent = s.saveFailed!;
    } catch {
      msg.textContent = s.saveFailed!;
    }
    submit.disabled = false;
  });

  document.body.replaceChildren(el('main', { class: 'card' },
    el('h1', {}, s.inactTitle!),
    el('p', { class: 'muted' }, s.inactIntro!),
    since,
    el('div', { class: 'row' }, back, whole),
    el('div', { class: 'row some' }, slider, label),
    msg,
    el('div', { class: 'row end' }, submit),
  ));
  update();
  setInterval(update, 1000);
  // A new gap (the previous one answered elsewhere) or a fixed end: from the daemon every 5 s.
  setInterval(() => {
    void api<{ model: Model | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => {
      if (!r.model) return;
      skew = r.model.now - Date.now();
      const next = r.model.gaps[0] ?? null;
      if (next?.gapId !== gap?.gapId) {
        minutes = 0;
        pinned = false;
        touched = false;
        submit.disabled = true;
      }
      gap = next;
      update();
    }).catch(() => {});
  }, 5000);
});
