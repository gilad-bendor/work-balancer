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
import type { Notes } from '../notes/notes.ts';
import { cleanText } from '../notes/notes.ts';
import { saveNoteAndReport } from '../effects/product.ts';
import { reportView, type Reports, type ReportView } from '../reports/reports.ts';

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
  reports: Reports;
  freshReviewDue?: (now: number) => boolean;
  store: Store;
  log: Logger;
  now: () => number;
  notes: Notes;
  config: () => PolicyConfig | null;
  /** The policy state at `now`; null without a valid config (tracking only — nothing is enforced). */
  state: (now: number) => PolicyState | null;
  week: (now: number) => WeekInfo;
  currentStretch: () => { from: number; seconds: number } | null;
  /** Early End-Of-Day may open (live gate open, no panic, data writable). Default: yes. */
  earlyAllowed?: () => boolean;
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
  reportStatuses: string[];
  draft: string;
  reportDraft: ReportDraft | null;
  /** Today's end-of-workday reports already recorded (the page offers "add another" instead of a second form). */
  recorded: ReportView[];
}

/** The unsaved report fields (status, feedback, energy) of the countdown / block, kept like the note draft. */
export interface ReportDraft {
  status: string[];
  feedback: string;
  energy: number | null;
}

export function cleanReportDraft(x: unknown): ReportDraft | null {
  const f = obj(x);
  const status = Array.isArray(f.status) ? f.status.filter((c): c is string => typeof c === 'string').slice(0, 50).map((c) => c.slice(0, 200)) : [];
  const feedback = typeof f.feedback === 'string' ? f.feedback.slice(0, 4000) : '';
  const energy = typeof f.energy === 'number' && Number.isInteger(f.energy) && f.energy >= 1 && f.energy <= 5 ? f.energy : null;
  return status.length || feedback || energy !== null ? { status, feedback, energy } : null;
}

/** The block page's model (also used by the trial mode with a synthetic state). */
export function blockModel(c: PolicyConfig, st: Pick<PolicyState, 'zeroLimit' | 'workedSeconds' | 'limitSeconds' | 'tokensLeft' | 'bypassesUsed' | 'day'>, week: WeekInfo, now: number, draft: string, reportDraft: ReportDraft | null = null, recorded: ReportView[] = []): BlockModel {
  return {
    now, zeroLimit: st.zeroLimit, workedSeconds: st.workedSeconds, limitSeconds: st.limitSeconds ?? 0, week,
    liftsAt: dayEnd(st.day), tokens: tokenGroups(st.tokensLeft),
    bypass: { minutes: c.bypass.minutes, phrase: c.bypass.phrase, usedToday: st.bypassesUsed },
    reportStatuses: c.reports.statuses, draft, reportDraft, recorded,
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
  /** Early End-Of-Day (menu): the same dialog, opened by the owner — so focused, closable and never intrusive. */
  countdownEarly: (): WindowInput => ({
    id: 'countdown', path: '/ui/countdown.html?early=1', title: 'work-balancer — end the day early', mode: 'floating', placement: 'center', w: 960, h: 820,
    focus: true, closable: true, intrusive: false,
  }),
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

/** Early End-Of-Day is offered on an enforcing day before the countdown (afterwards the countdown / block is there). */
export const canEndEarly = (st: PolicyState | null): boolean => st?.enforcing === true && st.level !== 'countdown' && st.level !== 'blocked';

export function createEnforcement(d: EnforcementDeps): Enforcement {
  /** Note text and report fields typed in the countdown, kept across its pill ⇄ full rebuilds and carried
   * into the block (today only, in memory). */
  let draft: { day: DayKey; text: string; report: ReportDraft | null } | null = null;
  /** The owner opened the countdown early (menu "Early End-Of-Day") on this day; in memory, adopted after a restart. */
  let early: DayKey | null = null;
  let raiseEarly = false;
  const mayEndEarly = (st: PolicyState | null): boolean => canEndEarly(st) && (d.earlyAllowed?.() ?? true);
  /** Countdown collapsed to the pill, until the level leaves `countdown` (in memory: a restart opens it expanded). Not
   * keyed on a record — a failed `policy.transition` write must not make it impossible to shrink (review M10#4). */
  let collapsed = false;
  /** Dismissals also kept in memory: while the store cannot write, the `effect.closed` record is missing and the
   * window would come back every beat (review M10#3). */
  let warnDismissedAt: number | null = null;
  let nudgeDismissedAt: number | null = null;
  /** Latest "Taking a break now" (also in memory: its `nudge.break` record may fail to write). */
  let breakAt: number | null = null;

  const today = (now: number): AnyRecord[] => d.store.readDay(dayKey(now));
  const todaysDraft = (now: number) => (draft && draft.day === dayKey(now) ? draft : null);
  const draftText = (now: number): string => todaysDraft(now)?.text ?? '';
  const reportDraft = (now: number): ReportDraft | null => todaysDraft(now)?.report ?? null;
  const recorded = (now: number): ReportView[] => d.reports.ofDay(dayKey(now)).filter((r) => r.stage === 'end-of-workday').map(reportView);
  const none = { windows: [], dims: [] };
  const save = (source: 'countdown' | 'block', p: unknown, now: number): ActionResult => {
    const r = saveNoteAndReport(d.notes, d.reports, source, p, now);
    const current = todaysDraft(now);
    if (current) {
      // Only what was written is forgotten; a part that failed stays for a retry.
      draft = { ...current, text: r.note === 'saved' ? '' : current.text, report: r.report === 'saved' ? null : current.report };
    }
    return r;
  };
  /** Updates only the parts present in the payload (`text`, `report`). */
  const setDraft = (p: unknown, now: number): ActionResult => {
    const b = obj(p);
    const current = todaysDraft(now) ?? { day: dayKey(now), text: '', report: null };
    draft = {
      day: current.day,
      text: 'text' in b ? (typeof b.text === 'string' ? b.text.slice(0, 4000) : '') : current.text,
      report: 'report' in b ? cleanReportDraft(b.report) : current.report,
    };
    return { ok: true };
  };

  const warn: Effect = {
    name: 'warn',
    audit: true,
    desired(now) {
      if (d.freshReviewDue?.(now)) return none;
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
      if (d.freshReviewDue?.(now)) return none;
      const st = d.state(now);
      if (st?.enforcing && st.level === 'countdown') return { windows: [WINDOWS.countdown(collapsed)], dims: [] };
      collapsed = false;
      if (early === dayKey(now) && mayEndEarly(st)) return { windows: [WINDOWS.countdownEarly()], dims: [] };
      early = null;
      return none;
    },
    request(now) {
      if (!mayEndEarly(d.state(now))) return;
      if (early === dayKey(now)) raiseEarly = true;
      early = dayKey(now);
    },
    adopt(ids, now) {
      // Only a window shown today: an early dialog left open across 04:00 must not end the new day.
      const shownToday = today(now).some((r) => r.type === 'effect.shown' && r.windowId === 'countdown');
      if (ids.includes('countdown') && shownToday && mayEndEarly(d.state(now))) early = dayKey(now);
    },
    focusRequests() {
      if (!raiseEarly) return [];
      raiseEarly = false;
      return ['countdown'];
    },
    closed() {
      early = null;
    },
    model(_id, now) {
      const st = d.state(now);
      if (!st) return null;
      return {
        now, remainingSeconds: st.remainingSeconds, workedSeconds: st.workedSeconds, limitSeconds: st.limitSeconds,
        early: st.level !== 'countdown', collapsed, reportStatuses: d.config()?.reports.statuses ?? [], draft: draftText(now),
        reportDraft: reportDraft(now), recorded: recorded(now),
      };
    },
    action(_id, action, payload, now) {
      const st = d.state(now);
      const isEarly = early === dayKey(now) && mayEndEarly(st);
      if (action === 'collapse' || action === 'expand') {
        collapsed = action === 'collapse';
        return { ok: true };
      }
      if (action === 'draft') return setDraft(payload, now);
      if (action === 'close' && isEarly) {
        early = null;
        return { ok: true, close: true };
      }
      if (action === 'save') {
        // Owner (2026-10-05, D-60): saving in the countdown = done for today — the remaining minutes are given up and
        // the block follows (tokens and the bypass still work). Only a save that kept something: an empty or stray
        // click forfeits nothing. Early End-Of-Day is the same dialog, opened sooner.
        const r = save('countdown', payload, now);
        if (!r.ok || !st?.enforcing || (st.level !== 'countdown' && !isEarly)) return r;
        const remainingSeconds = Math.round(st.remainingSeconds ?? 0);
        const by = st.level === 'countdown' ? 'countdown' : 'early';
        if (!d.store.append({ type: 'budget.forfeited', remainingSeconds, by })) return { ...r, forfeited: false };
        d.log.info('budget forfeited', { by, remainingSeconds });
        early = null;
        return { ...r, forfeited: true };
      }
      // Not dismissible (R-UI-COUNTDOWN): no close — except when the owner opened it early himself.
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
      return { ...blockModel(c, st, d.week(now), now, draftText(now), reportDraft(now), recorded(now)), blockActive: st.blockActive };
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
   * `effect.closed` record, so a restart keeps the snooze); "taking a break" restarts the count from that moment
   * (owner, D-73). */
  const nudgeStretch = (now: number): { from: number; seconds: number } | null => {
    const s = d.currentStretch();
    if (!s) return null;
    // A click "in the future" (the clock stepped back) must not silence the nudge.
    const clicks = today(now).filter((r) => r.type === 'nudge.break' && r.ts <= now).map((r) => r.ts);
    const from = Math.max(s.from, breakAt !== null && breakAt <= now ? breakAt : -Infinity, ...clicks);
    return { from, seconds: Math.max(0, now - from) / 1000 };
  };
  const nudge: Effect = {
    name: 'nudge',
    audit: true,
    desired(now) {
      if (d.freshReviewDue?.(now)) return none;
      const c = d.config();
      const st = d.state(now);
      if (!c || !st?.dayPolicy?.breakNudge || st.weekday === 'sat') return none;
      if (st.level === 'countdown' || st.level === 'blocked') return none; // the countdown / block speak already
      const stretch = nudgeStretch(now);
      if (!stretch || stretch.seconds < c.breakNudge.afterMin * 60) return none;
      const lastDismiss = Math.max(audited(today(now), 'effect.closed', 'nudge', stretch.from, true)?.ts ?? -Infinity, nudgeDismissedAt !== null && nudgeDismissedAt >= stretch.from ? nudgeDismissedAt : -Infinity);
      if (now < lastDismiss + c.breakNudge.snoozeMin * 60_000) return none;
      return { windows: [WINDOWS.nudge()], dims: [] };
    },
    model(_id, now) {
      const s = nudgeStretch(now);
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
        breakAt = now;
        if (!d.store.append({ type: 'nudge.break' })) d.log.warn('nudge.break not written (kept in memory)');
        return { ok: true, close: true };
      }
      return { ok: false, error: `unknown action ${action}` };
    },
  };

  return { effects: [warn, countdown, block, nudge] };
}
