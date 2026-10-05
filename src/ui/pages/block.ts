// The block (R-UI-BLOCK): full screen on every screen until 04:00 — kind message, today/week numbers (+ a week strip),
// park the thought (context-memory + feedback), postpone tokens (two-step confirm, F-HS-2: a synthetic click must
// never spend one), and the emergency bypass (retype the sentence with pasting off, a reason, two-step confirm —
// R-POL-4). Not dismissible: no ✕, no Esc. A zero limit (week used up) first shows a short explanation (Q-3).
// Inputs on the primary screen only.
import { act, api, boot, el, fill, isPrimary, windowId } from './page.ts';
import { hm, timeLabel } from './format.ts';
import { parkPanel } from './park.ts';

interface Day {
  day: string;
  weekday: string;
  workedSeconds: number;
  budgetSeconds: number | null;
  isToday: boolean;
}

interface Model {
  zeroLimit: boolean;
  workedSeconds: number;
  limitSeconds: number;
  week: { workedSeconds: number; budgetSeconds: number | null; days: Day[] };
  liftsAt: number;
  tokens: { minutes: number; left: number }[];
  bypass: { minutes: number; phrase: string; usedToday: number };
  feedbackChoices: string[];
  draft: string;
}

/** Same comparison as the daemon (enforcement.ts `phraseKey`): case, spacing and punctuation do not matter. */
const phraseKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const CONFIRM_DELAY_MS = 800;
const ARM_TIMEOUT_MS = 20_000;

void boot<Model | null>(({ strings: s, model: first }) => {
  document.body.classList.add('mode-overlay', 'scroll');
  if (!first) throw new Error('no block model'); // fail open: the kind fallback, then Lua closes the window
  let model: Model = first;

  const numbers = el('p', { class: 'block-numbers' });
  const strip = el('div', { class: 'week-strip' });
  const showNumbers = (): void => {
    // A zero limit (week used up) has no "of 0:00" for today.
    numbers.textContent = `${s.blockToday} ${hm(model.workedSeconds)}${model.limitSeconds > 0 ? ` ${s.blockOf} ${hm(model.limitSeconds)}` : ''} · ${s.blockWeek} ${hm(model.week.workedSeconds)}`
      + (model.week.budgetSeconds !== null ? ` ${s.blockOf} ${hm(model.week.budgetSeconds)}` : '')
      + ` · ${s.blockLifts} ${timeLabel(model.liftsAt)}`;
    strip.replaceChildren(...model.week.days.map((d) => el('span', { class: `chip static${d.isToday ? ' today' : ''}` },
      `${d.weekday.charAt(0).toUpperCase()}${d.weekday.slice(1)} ${hm(d.workedSeconds)}${d.budgetSeconds !== null ? ` / ${hm(d.budgetSeconds)}` : ''}`)));
  };
  const head = (): HTMLElement[] => [
    el('h1', {}, s.blockTitle!),
    el('p', {}, s.blockBody!),
    el('div', { class: 'block-stats' }, numbers, strip),
  ];

  // ── Postpone tokens (two-step) ──
  const tokensBox = el('div', { class: 'tokens' });
  const msg = el('p', { class: 'msg', role: 'status' });
  let armed: number | null = null;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    armed = null;
    if (armTimer) clearTimeout(armTimer);
    renderTokens();
  };
  function renderTokens(): void {
    if (armed !== null) return;
    const left = model.tokens.filter((t) => t.left > 0);
    tokensBox.replaceChildren(...(left.length
      ? left.map((t) => {
        const b = el('button', { type: 'button', class: 'token' }, fill(s.blockToken, { m: t.minutes }), el('span', { class: 'muted small' }, ` · ${fill(s.blockTokenLeft, { k: t.left })}`));
        b.addEventListener('click', () => arm(t.minutes));
        return b;
      })
      : [el('p', { class: 'muted' }, s.blockNoTokens!)]));
  }
  function arm(minutes: number): void {
    armed = minutes;
    const yes = el('button', { class: 'primary' }, s.blockTokenYes!);
    const no = el('button', {}, s.blockNotNow!);
    yes.disabled = true;
    setTimeout(() => { yes.disabled = false; }, CONFIRM_DELAY_MS);
    no.addEventListener('click', disarm);
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        const r = await act('token', { minutes });
        if (r.ok) return; // the block lifts (the page tells Lua to close)
        msg.textContent = s.blockFailed!;
      } catch {
        msg.textContent = s.blockFailed!;
      }
      disarm();
    });
    // The confirm button sits elsewhere than the token buttons: one stray click can never do both steps.
    tokensBox.replaceChildren(el('div', { class: 'confirm' }, el('p', {}, fill(s.blockTokenConfirm, { m: minutes })), el('div', { class: 'row end' }, no, yes)));
    armTimer = setTimeout(disarm, ARM_TIMEOUT_MS);
  }

  // ── Emergency bypass ──
  const bypassBox = el('div', { class: 'bypass' });
  function bypassStart(): void {
    const open = el('button', { type: 'button' }, s.blockBypass!);
    open.addEventListener('click', bypassForm);
    bypassBox.replaceChildren(open, ...(model.bypass.usedToday ? [el('p', { class: 'muted small' }, fill(s.blockBypassUsed, { k: model.bypass.usedToday }))] : []));
  }
  function bypassForm(): void {
    const typed = el('textarea', { rows: '3', placeholder: s.blockBypassType!, spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off' });
    for (const ev of ['paste', 'drop'] as const) typed.addEventListener(ev, (e) => e.preventDefault());
    typed.addEventListener('beforeinput', (e: InputEvent) => {
      if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop' || e.inputType === 'insertFromYank') e.preventDefault();
    });
    const reason = el('input', { type: 'text', placeholder: s.blockBypassReason!, maxlength: '500' });
    const cont = el('button', { class: 'primary' }, s.blockBypassContinue!);
    const cancel = el('button', {}, s.blockNotNow!);
    const hint = el('p', { class: 'msg', role: 'status' });
    cancel.addEventListener('click', bypassStart);
    cont.addEventListener('click', () => {
      if (phraseKey(typed.value) !== phraseKey(model.bypass.phrase)) {
        hint.textContent = s.blockBypassMismatch!;
        return;
      }
      if (reason.value.trim().length < 3) {
        hint.textContent = s.blockBypassReason!;
        reason.focus();
        return;
      }
      bypassConfirm(typed.value, reason.value);
    });
    bypassBox.replaceChildren(
      el('p', {}, fill(s.blockBypassIntro, { m: model.bypass.minutes })),
      el('blockquote', { class: 'phrase' }, model.bypass.phrase),
      typed, reason, hint,
      el('div', { class: 'row end' }, cancel, cont),
    );
    typed.focus();
  }
  function bypassConfirm(phrase: string, reason: string): void {
    const yes = el('button', { class: 'primary' }, fill(s.blockBypassYes, { m: model.bypass.minutes }));
    const no = el('button', {}, s.blockNotNow!);
    yes.disabled = true;
    setTimeout(() => { yes.disabled = false; }, CONFIRM_DELAY_MS);
    no.addEventListener('click', bypassStart);
    const hint = el('p', { class: 'msg', role: 'status' });
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        const r = await act('bypass', { phrase, reason });
        if (r.ok) return;
        hint.textContent = r.error === 'phrase' ? s.blockBypassMismatch! : s.blockFailed!;
      } catch {
        hint.textContent = s.blockFailed!;
      }
      yes.disabled = false;
    });
    bypassBox.replaceChildren(el('div', { class: 'confirm' }, el('p', {}, fill(s.blockBypassConfirm, { m: model.bypass.minutes })), hint, el('div', { class: 'row end' }, no, yes)));
  }

  function renderMain(): void {
    const park = parkPanel(s, model.feedbackChoices, { title: s.blockPark!, draft: model.draft });
    renderTokens();
    bypassStart();
    document.body.replaceChildren(el('main', { class: 'card block' },
      ...head(),
      el('div', { class: 'block-grid' },
        park.root,
        el('section', { class: 'more' }, el('h2', {}, s.blockMoreTitle!), el('p', { class: 'muted' }, s.blockMoreHint!), tokensBox, msg, bypassBox),
      ),
    ));
  }

  showNumbers();
  if (!isPrimary) {
    document.body.replaceChildren(el('main', { class: 'card block' }, ...head(), el('p', { class: 'muted' }, s.blockOtherScreen!)));
  } else if (model.zeroLimit) {
    const ok = el('button', { class: 'primary' }, s.blockZeroContinue!);
    ok.addEventListener('click', renderMain);
    document.body.replaceChildren(el('main', { class: 'card block' },
      el('h1', {}, s.blockZeroTitle!),
      el('p', {}, s.blockZeroBody!),
      el('div', { class: 'block-stats' }, numbers, strip),
      el('div', { class: 'row end' }, ok),
    ));
  } else {
    renderMain();
  }

  // Numbers and token counts from the daemon every 5 s (typed text is never re-rendered away).
  setInterval(() => {
    void api<{ model: Model | null }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`).then((r) => {
      if (!r.model) return;
      model = r.model;
      showNumbers();
      renderTokens();
    }).catch(() => {});
  }, 5000);
});
