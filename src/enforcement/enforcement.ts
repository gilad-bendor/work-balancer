// Enforcement (ledger M10): the warn dialog + dim pulse (R-UI-WARN), the countdown (R-UI-COUNTDOWN), the full-screen
// block with tokens and the emergency bypass (R-UI-BLOCK, R-POL-3/3a/4, Q-3's zero-limit explanation), and the break
// nudge (R-POL-5). Every decision is a function of the policy state (recomputed from data each tick — restarts and
// reloads can neither escape nor lose a block) and of today's records (`policy.transition` = a level entry,
// `effect.shown`/`effect.closed` = what the owner already saw or dismissed). All four are intrusive: the live gate,
// R-UI-QUIET and the panic latch apply (manager / Lua). Saturday and the non-enforcing days get nothing (evaluator).
import type { ActionResult, DimSpec, Effect, WindowInput } from '../core/effects.ts';
import type { Logger } from '../core/log.ts';
import { dayEnd, dayKey, type DayKey, type Weekday } from '../core/time.ts';
import type { PolicyConfig } from '../policy/config.ts';
import { canBypass, canUseToken, grantUntil, type Level, type PolicyState } from '../policy/evaluate.ts';
import type { AnyRecord } from '../store/records.ts';
import type { Store } from '../store/store.ts';
import type { Notes, NoteSource } from '../notes/notes.ts';
import { cleanText } from '../notes/notes.ts';
import { submitContextAndFeedback } from '../effects/product.ts';

/** The warn dim pulse (R-UI-WARN): a few seconds, gentle; Lua caps and always restores. */
export const WARN_DIM: Omit<DimSpec, 'pulseId'> = { level: 0.6, seconds: 3 };
export const MIN_REASON = 3;
export const MAX_REASON = 500;

export interface WeekDayInfo {
  day: DayKey;
  weekday: Weekday;
  workedSeconds: number;
  budgetSeconds: number | null;
  isToday: boolean;
}

export interface WeekInfo {
  workedSeconds: number;
  budgetSeconds: number | null;
  /** This week's days up to today. */
  days: WeekDayInfo[];
}

export interface EnforcementDeps {
  store: Store;
  log: Logger;
  now: () => number;
  notes: Notes;
  config: () => PolicyConfig | null;
  /** The policy state at `now`; null without a valid config (tracking only — nothing is enforced). */
  state: (now: number) => PolicyState | null;
  week: (now: number) => WeekInfo;
  currentStretch: () => { from: number; seconds: number } | null;
}

/** The bypass phrase is retyped (R-POL-4): the friction is the typing, not the punctuation — case, spacing and
 * punctuation are ignored. */
export const phraseKey = (s: unknown): string => (typeof s === 'string' ? s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') : '');
export const phraseMatches = (typed: unknown, phrase: string): boolean => phraseKey(phrase).length > 0 && phraseKey(typed) === phraseKey(phrase);

/** Remaining tokens grouped by size, largest first: `[10, 5, 5]` → `[{10, 1}, {5, 2}]`. */
export function tokenGroups(tokensLeft: readonly number[]): { minutes: number; left: number }[] {
  const m = new Map<number, number>();
  for (const t of tokensLeft) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => b[0] - a[0]).map(([minutes, left]) => ({ minutes, left }));
}

const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {});

/** Latest `policy.transition` into `level` today (= the current entry of that level). */
function entryOf(records: readonly AnyRecord[], level: Level): number | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.type === 'policy.transition' && r.to === level) return r.ts;
  }
  return null;
}

const audited = (records: readonly AnyRecord[], type: 'effect.shown' | 'effect.closed', windowId: string, since: number, byUser = false): AnyRecord | undefined =>
  records.findLast((r) => r.type === type && r.windowId === windowId && r.ts >= since && (!byUser || r.by === 'user' || r.by === 'page'));

export interface BlockModel {
  now: number;
  zeroLimit: boolean;
  workedSeconds: number;
  limitSeconds: number;
  week: WeekInfo;
  liftsAt: number;
  tokens: { minutes: number; left: number }[];
  bypass: { minutes: number; phrase: string; usedToday: number };
  feedbackChoices: string[];
  draft: string;
}

/** The block page's model (also used by the trial mode with a synthetic state). */
export function blockModel(c: PolicyConfig, st: Pick<PolicyState, 'zeroLimit' | 'workedSeconds' | 'limitSeconds' | 'tokensLeft' | 'bypassesUsed' | 'day'>, week: WeekInfo, now: number, draft: string): BlockModel {
  return {
    now, zeroLimit: st.zeroLimit, workedSeconds: st.workedSeconds, limitSeconds: st.limitSeconds ?? 0, week,
    liftsAt: dayEnd(st.day), tokens: tokenGroups(st.tokensLeft),
    bypass: { minutes: c.bypass.minutes, phrase: c.bypass.phrase, usedToday: st.bypassesUsed },
    feedbackChoices: c.feedbackChoices, draft,
  };
}

export const WINDOWS = {
  warn: (): WindowInput => ({
    id: 'warn', path: '/ui/warn.html', title: 'work-balancer — heads-up', mode: 'floating', placement: 'center', w: 860, h: 400,
    focus: false, closable: true, intrusive: true,
  }),
  countdown: (collapsed: boolean): WindowInput => collapsed
    ? { id: 'countdown', path: '/ui/countdown.html?pill=1', title: 'work-balancer', mode: 'floating', placement: 'top-right', w: 420, h: 150, focus: false, closable: false, intrusive: true }
    : { id: 'countdown', path: '/ui/countdown.html', title: 'work-balancer — last few minutes', mode: 'floating', placement: 'center', w: 960, h: 820, focus: false, closable: false, intrusive: true },
  /** `immediate`: a token or the bypass was used today — the block returns the moment the grant ends (R-POL-3a),
   * not after an R-UI-QUIET deferral of up to 2 min (review M10#2). */
  block: (immediate = false): WindowInput => ({
    id: 'block', path: '/ui/block.html', title: 'work-balancer — that is today', mode: 'overlay', placement: 'full', perScreen: true,
    focus: true, closable: false, intrusive: true, ...(immediate ? { immediate: true } : {}),
  }),
  nudge: (): WindowInput => ({
    id: 'nudge', path: '/ui/nudge.html', title: 'work-balancer — a short break?', mode: 'floating', placement: 'top-right', w: 640, h: 330,
    focus: false, closable: true, intrusive: true,
  }),
};

export interface Enforcement {
  effects: Effect[];
}

export function createEnforcement(d: EnforcementDeps): Enforcement {
  /** Context-memory text typed in the countdown, carried into the block (today only). */
  let draft: { day: DayKey; text: string } | null = null;
  /** Countdown collapsed to the pill, until the level leaves `countdown` (in memory: a restart opens it expanded). Not
   * keyed on a record — a failed `policy.transition` write must not make it impossible to shrink (review M10#4). */
  let collapsed = false;
  /** Dismissals also kept in memory: while the store cannot write, the `effect.closed` record is missing and the
   * window would come back every beat (review M10#3). */
  let warnDismissedAt: number | null = null;
  let nudgeDismissedAt: number | null = null;
  /** "Taking a break now" silences the nudge for this stretch. */
  let quietStretchFrom: number | null = null;

  const today = (now: number): AnyRecord[] => d.store.readDay(dayKey(now));
  const draftText = (now: number): string => (draft && draft.day === dayKey(now) ? draft.text : '');
  const none = { windows: [], dims: [] };
  const save = (source: NoteSource, p: unknown, now: number): ActionResult => {
    const r = submitContextAndFeedback(d.notes, source, p);
    if (r.context === 'saved' && draft?.day === dayKey(now)) draft = null;
    return r;
  };
  const setDraft = (p: unknown, now: number): ActionResult => {
    const text = typeof obj(p).text === 'string' ? (obj(p).text as string).slice(0, 4000) : '';
    draft = { day: dayKey(now), text };
    return { ok: true };
  };

  const warn: Effect = {
    name: 'warn',
    audit: true,
    desired(now) {
      const st = d.state(now);
      if (!st?.enforcing || st.level !== 'warn') return none;
      const records = today(now);
      const entry = entryOf(records, 'warn');
      if (entry === null || audited(records, 'effect.closed', 'warn', entry, true) || (warnDismissedAt !== null && warnDismissedAt >= entry)) return none;
      // The dim accompanies the dialog's first appearance only (one pulse per level entry).
      const dims = audited(records, 'effect.shown', 'warn', entry) ? [] : [{ pulseId: `warn-${entry}`, ...WARN_DIM }];
      return { windows: [WINDOWS.warn()], dims };
    },
    model(_id, now) {
      const st = d.state(now);
      return st ? { now, workedSeconds: st.workedSeconds, limitSeconds: st.limitSeconds, remainingSeconds: st.remainingSeconds, countdownBeforeMin: d.config()?.ladder.countdownBeforeMin ?? null } : null;
    },
    closed(_id, by, now) {
      if (by === 'user' || by === 'page') warnDismissedAt = now;
    },
    action(_id, action, _p, now) {
      // Dismissed: the page tells Lua to close; the `effect.closed` record (by page) makes it final for this entry.
      if (action === 'close') {
        warnDismissedAt = now;
        return { ok: true, close: true };
      }
      return { ok: false, error: `unknown action ${action}` };
    },
  };

  const countdown: Effect = {
    name: 'countdown',
    audit: true,
    desired(now) {
      const st = d.state(now);
      if (!st?.enforcing || st.level !== 'countdown') {
        collapsed = false;
        return none;
      }
      return { windows: [WINDOWS.countdown(collapsed)], dims: [] };
    },
    model(_id, now) {
      const st = d.state(now);
      if (!st) return null;
      return {
        now, remainingSeconds: st.remainingSeconds, workedSeconds: st.workedSeconds, limitSeconds: st.limitSeconds,
        collapsed, feedbackChoices: d.config()?.feedbackChoices ?? [], draft: draftText(now),
      };
    },
    action(_id, action, payload, now) {
      if (action === 'collapse' || action === 'expand') {
        collapsed = action === 'collapse';
        return { ok: true };
      }
      if (action === 'draft') return setDraft(payload, now);
      if (action === 'save') {
        // Owner (2026-10-05, D-60): saving in the countdown = done for today — the remaining minutes are given up and
        // the block follows (tokens and the bypass still work). Only a save that kept something: an empty or stray
        // click forfeits nothing.
        const r = save('countdown', payload, now);
        const st = d.state(now);
        if (!r.ok || !st?.enforcing || st.level !== 'countdown') return r;
        const remainingSeconds = Math.round(st.remainingSeconds ?? 0);
        if (!d.store.append({ type: 'budget.forfeited', remainingSeconds, by: 'countdown' })) return { ...r, forfeited: false };
        d.log.info('budget forfeited (countdown save)', { remainingSeconds });
        return { ...r, forfeited: true };
      }
      // Not dismissible (R-UI-COUNTDOWN): no close.
      return { ok: false, error: `unknown action ${action}` };
    },
  };

  const block: Effect = {
    name: 'block',
    audit: true,
    desired(now) {
      const st = d.state(now);
      // Fail open: no block while data cannot be written — tokens, bypass and notes could not be kept (principle 5).
      if (!st?.blockActive || d.store.health().writeError) return none;
      return { windows: [WINDOWS.block(st.tokensUsed + st.bypassesUsed > 0)], dims: [] };
    },
    model(_id, now) {
      const c = d.config();
      const st = d.state(now);
      if (!c || !st?.enforcing) return null;
      return { ...blockModel(c, st, d.week(now), now, draftText(now)), blockActive: st.blockActive };
    },
    action(_id, action, payload, now) {
      const p = obj(payload);
      if (action === 'save') return save('block', payload, now);
      if (action === 'draft') return setDraft(payload, now);
      const c = d.config();
      const st = d.state(now);
      if (!c || !st) return { ok: false, error: 'unavailable' };
      if (action === 'token') {
        const minutes = typeof p.minutes === 'number' ? p.minutes : NaN;
        if (!canUseToken(st, minutes)) return { ok: false, error: 'unavailable' };
        const until = grantUntil(st.grant?.until ?? null, now, minutes);
        if (!d.store.append({ type: 'token.used', minutes, until })) return { ok: false, error: 'write' };
        d.log.info('token used', { minutes, until: new Date(until).toISOString() });
        return { ok: true, close: true, until };
      }
      if (action === 'bypass') {
        if (!canBypass(st)) return { ok: false, error: 'unavailable' };
        if (!phraseMatches(p.phrase, c.bypass.phrase)) return { ok: false, error: 'phrase' };
        const reason = cleanText(p.reason).slice(0, MAX_REASON);
        if (reason.length < MIN_REASON) return { ok: false, error: 'reason' };
        const until = grantUntil(st.grant?.until ?? null, now, c.bypass.minutes);
        if (!d.store.append({ type: 'bypass.used', minutes: c.bypass.minutes, until, reason })) return { ok: false, error: 'write' };
        d.log.info('emergency bypass used', { minutes: c.bypass.minutes, until: new Date(until).toISOString() });
        return { ok: true, close: true, until };
      }
      // Not dismissible (R-UI-BLOCK): no close — only a token, the bypass, 04:00 or the escape hatches end it.
      return { ok: false, error: `unknown action ${action}` };
    },
  };

  /** Break nudge (R-POL-5): after `afterMin` of continuous work; ✕ / Esc / "Snooze" = again in `snoozeMin` (from the
   * `effect.closed` record, so a restart keeps the snooze); "taking a break" = quiet for this stretch. */
  const nudge: Effect = {
    name: 'nudge',
    audit: true,
    desired(now) {
      const c = d.config();
      const st = d.state(now);
      if (!c || !st?.dayPolicy?.breakNudge || st.weekday === 'sat') return none;
      if (st.level === 'countdown' || st.level === 'blocked') return none; // the countdown / block speak already
      const stretch = d.currentStretch();
      if (!stretch || stretch.seconds < c.breakNudge.afterMin * 60 || quietStretchFrom === stretch.from) return none;
      const lastDismiss = Math.max(audited(today(now), 'effect.closed', 'nudge', stretch.from, true)?.ts ?? -Infinity, nudgeDismissedAt !== null && nudgeDismissedAt >= stretch.from ? nudgeDismissedAt : -Infinity);
      if (now < lastDismiss + c.breakNudge.snoozeMin * 60_000) return none;
      return { windows: [WINDOWS.nudge()], dims: [] };
    },
    model(_id, now) {
      const s = d.currentStretch();
      return { now, stretchSeconds: s?.seconds ?? 0, stretchFrom: s?.from ?? null, snoozeMin: d.config()?.breakNudge.snoozeMin ?? 15 };
    },
    closed(_id, by, now) {
      if (by === 'user' || by === 'page') nudgeDismissedAt = now;
    },
    action(_id, action, _p, now) {
      if (action === 'snooze' || action === 'close') {
        nudgeDismissedAt = now;
        return { ok: true, close: true };
      }
      if (action === 'break') {
        quietStretchFrom = d.currentStretch()?.from ?? null;
        return { ok: true, close: true };
      }
      return { ok: false, error: `unknown action ${action}` };
    },
  };

  return { effects: [warn, countdown, block, nudge] };
}
