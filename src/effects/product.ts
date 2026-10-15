// The product windows: the menu's Manage Reports / Manage Notes / activity summary / quit (user-initiated), and the
// morning review + welcome (system-initiated, R-UI-REVIEW, R-UI-REPORT). Wording lives in src/ui/strings.ts; pages in
// src/ui/pages/.
import type { ActionResult, Effect } from '../core/effects.ts';
import { addDays, dayKey, weekday, type DayKey } from '../core/time.ts';
import type { PolicyConfig } from '../policy/config.ts';
import type { Store } from '../store/store.ts';
import type { Note, NoteResult, Notes, NoteSource } from '../notes/notes.ts';
import { windowRev, type EffectsManager } from './manager.ts';
import { userWindowEffect } from './user-window.ts';
import { REPORT_STAGES, reportView, type Reports, type ReportSource } from '../reports/reports.ts';

export interface ProductDeps {
  effects: EffectsManager;
  notes: Notes;
  reports: Reports;
  store: Store;
  now: () => number;
  config: () => PolicyConfig | null;
  summary: (now: number) => unknown;
  /** Quit is refused while enforcement is due (countdown / blocked — also during a token): otherwise one cheap token
   * would open the way to stopping the whole day (review M10#5). Default: allowed. */
  quitAllowed?: (now: number) => boolean;
  welcomeAllowed?: (now: number) => boolean;
  /** Yesterday has no report and the welcome should ask for it (default: `reports.freshDue`, Sun–Thu). */
  welcomeDue?: (now: number) => boolean;
  /** Yesterday had no work: the welcome asks about today (default: about yesterday). */
  welcomeAsksToday?: (now: number) => boolean;
}

/** A note as pages see it. */
export interface NoteView {
  id: number;
  text: string;
  day: DayKey;
  createdAt: number;
  dismissed: boolean;
}

export const noteView = (n: Note): NoteView => ({ id: n.id, text: n.text, day: n.day, createdAt: n.createdAt, dismissed: n.dismissedAt !== null });

const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {});

const answer = (r: NoteResult, extra: () => Record<string, unknown>): ActionResult =>
  r.ok ? { ok: true, ...extra() } : { ok: false, error: r.error };

type Part = 'saved' | 'failed' | 'none';

/** Countdown and block: one note and/or one end-of-workday report from `{ note, report: { feedback, status, energy } }`.
 * Each part reports saved/failed/none, so the page clears what was saved and keeps (for a retry) only what failed —
 * never a duplicate. */
export function saveNoteAndReport(notes: Notes, reports: Reports, source: NoteSource & ReportSource, p: unknown, now: number): ActionResult & { note: Part; report: Part } {
  const b = obj(p);
  const note: Part = typeof b.note === 'string' && b.note.trim() ? (notes.create({ text: b.note, source }).ok ? 'saved' : 'failed') : 'none';
  const r = reports.createEndOfWorkday(b.report, source, now);
  const report: Part = r.ok ? 'saved' : r.error === 'empty' ? 'none' : 'failed';
  if (note === 'none' && report === 'none') return { ok: false, error: 'empty', note, report };
  if (note === 'failed' || report === 'failed') return { ok: false, error: 'write', note, report };
  return { ok: true, note, report };
}

/** edit / dismiss / undismiss / add — shared by Manage Notes and the morning review. */
function noteActions(notes: Notes, source: NoteSource, view: () => Record<string, unknown>) {
  return {
    add: (p: unknown) => answer(notes.create({ text: obj(p).text, source }), view),
    edit: (p: unknown) => answer(notes.edit(obj(p).id, obj(p).text), view),
    dismiss: (p: unknown) => answer(notes.dismiss(obj(p).id), view),
    undismiss: (p: unknown) => answer(notes.undismiss(obj(p).id), view),
  };
}

const REPORT_ACTIONS = ['report-new', 'report-add', 'report-arm-skip', 'report-skip', 'report-edit', 'report-dismiss', 'report-undismiss'];

/** A morning-review day per the policy: the day's first window is the morning review (or the welcome), whatever
 * yesterday left behind (D-75). */
const reviewDay = (config: PolicyConfig | null, day: DayKey): boolean => config?.days[weekday(day)].morningReview === true;

export function registerProductEffects(d: ProductDeps): void {
  const reports = d.reports;
  const welcomeDue = (now: number): boolean => d.welcomeDue?.(now) ?? (reports.freshDue(now) && !['fri', 'sat'].includes(weekday(dayKey(now))));
  const notesView = () => ({ notes: d.notes.list().map(noteView) });
  d.effects.register(userWindowEffect({
    name: 'notes',
    look: { path: '/ui/notes.html', title: 'work-balancer — manage notes', w: 0.9, h: 0.9 },
    model: notesView,
    actions: noteActions(d.notes, 'manager', notesView),
  }));

  d.effects.register(userWindowEffect({
    name: 'summary',
    look: { path: '/ui/summary.html', title: 'work-balancer — activity summary', w: 0.9, h: 0.9 },
    model: (now) => d.summary(now),
  }));

  d.effects.register(userWindowEffect({
    name: 'quit',
    look: { path: '/ui/quit.html', title: 'work-balancer — quit', w: 760, h: 420 },
    model: (now) => ({ allowed: d.quitAllowed?.(now) ?? true }),
    // The page then tells Lua to quit (R-UI-MENU-3); the daemon logs `app.quit` when Lua's shutdown request arrives.
    actions: { confirm: (_p, now) => ((d.quitAllowed?.(now) ?? true) ? { ok: true, quit: true } : { ok: false, error: 'enforcing' }) },
  }));

  // Manage Reports: from the menu, or once a day (Sun–Thu) as a gentle catch-up when older days have no report.
  const olderMissing = (now: number) => reports.missing(now).filter((s) => s.daysAgo >= 2);
  const window = userWindowEffect({
    name: 'reports',
    look: { path: '/ui/reports.html', title: 'work-balancer — manage reports', w: 0.9, h: 0.9 },
    model: (now) => {
      const c = d.config()?.reports;
      return {
        today: dayKey(now),
        reports: reports.list().slice(0, c?.listMax ?? 1000).map(reportView),
        stubs: reports.missing(now),
        statuses: c?.statuses ?? [],
        stages: REPORT_STAGES,
        preferredDay: manual ? null : olderMissing(now)[0]?.day ?? null,
      };
    },
    actions: Object.fromEntries(REPORT_ACTIONS.map((action) => [
      action, (p: unknown, now: number) => reports.action(action, p, now, { source: 'manager' }),
    ])),
  });
  let manual = false;
  let adoptedAutomatic = false;
  let consideredDay: DayKey | null = null;
  d.effects.register({
    ...window,
    request(now) { manual = true; window.request?.(now); },
    adopt(ids, now, revisions) {
      window.adopt?.(ids, now);
      const spec = window.desired(now).windows[0];
      manual = !spec || revisions?.reports !== windowRev({ ...spec, focus: false, intrusive: true });
      adoptedAutomatic = !manual;
      consideredDay = dayKey(now);
    },
    desired(now) {
      const today = dayKey(now);
      const wd = weekday(today);
      if (welcomeDue(now)) consideredDay = today; // offer catch-up after the fresh checkpoint, not another popup
      if (!manual && wd !== 'fri' && wd !== 'sat' && d.welcomeAllowed?.(now) && !welcomeDue(now) && consideredDay !== today) {
        // On a morning-review day the review offers the catch-up itself: one morning window, never a queue of popups.
        const shown = reviewDay(d.config(), today) || d.store.readDay(today).some((r) =>
          r.type === 'effect.shown' && (r.windowId === 'reports' || r.windowId === 'review:fresh'));
        if (shown) consideredDay = today;
        else if (olderMissing(now).length) {
          consideredDay = today;
          window.request?.(now);
        }
      }
      const result = window.desired(now);
      if (!manual && (wd === 'fri' || wd === 'sat' || (!adoptedAutomatic && !d.welcomeAllowed?.(now)) || welcomeDue(now))) return { windows: [], dims: [] };
      return manual ? result : { ...result, windows: result.windows.map((w) => ({ ...w, focus: false, intrusive: true })) };
    },
    closed(id, by, now) { window.closed?.(id, by, now); manual = manual && window.isOpen(); adoptedAutomatic = adoptedAutomatic && window.isOpen(); },
  });
  d.effects.register(createReviewEffect(d));
}

/**
 * Morning review (R-UI-REVIEW, D-75): on every morning-review day, from the day's `day.rollover` record on (its first
 * tick: 04:00, a wake, a start), until the owner closes it — "done for today" = an `effect.closed` for `review` /
 * `review:fresh` by `user`/`page` in today's file. It does not depend on how yesterday ended (notes waiting or not).
 * Involuntary losses (reload, fail-open) bring it back. Intrusive: live gate, R-UI-QUIET and panic apply. Yesterday
 * without a report turns it into the full-screen welcome (`review:fresh`); after a day without work it asks about today
 * and only notes yesterday (which can also be reported there).
 */
export function createReviewEffect(d: Pick<ProductDeps, 'notes' | 'reports' | 'store' | 'now' | 'config' | 'welcomeAllowed' | 'welcomeDue' | 'welcomeAsksToday'>): Effect {
  let day: DayKey | null = null;
  let started = false; // today's rollover record exists
  let done = false;
  let freshSession = false;
  const required = (now: number): boolean => d.welcomeDue?.(now) ?? (d.reports.freshDue(now) && !['fri', 'sat'].includes(weekday(dayKey(now))));
  const yesterday = (now: number): DayKey => addDays(dayKey(now), -1);
  const askToday = (now: number): boolean => d.welcomeAsksToday?.(now) === true;
  // Only after a workday: Friday/Saturday never have an end-of-workday (no countdown, no block).
  const endOfDayAsked = (y: DayKey): boolean => {
    const c = d.config();
    return c?.days[weekday(y)].enforce === true && !!c.reports.startDay && y >= c.reports.startDay;
  };
  const reviewView = () => {
    const now = d.now();
    const y = yesterday(now);
    const t = dayKey(now);
    const welcome = required(now) || freshSession;
    return {
      notes: d.notes.active().map(noteView),
      welcome: welcome ? {
        day: y, weekday: weekday(y), daysAgo: 1, reports: d.reports.ofDay(y).map(reportView),
        today: askToday(now) ? { day: t, weekday: weekday(t), daysAgo: 0, reports: d.reports.ofDay(t).map(reportView) } : null,
      } : null,
      // Yesterday ended without an end-of-workday report (e.g. an early end): an optional one, timed at its end.
      endOfDay: !welcome && endOfDayAsked(y) ? {
        day: y, weekday: weekday(y), daysAgo: 1, missing: !d.reports.hasEndOfDay(y),
        reports: d.reports.ofDay(y).filter((r) => r.stage === 'end-of-workday').map(reportView),
      } : null,
      statuses: d.config()?.reports.statuses ?? [],
      stages: REPORT_STAGES,
      olderCount: d.reports.missing(now).filter((s) => s.daysAgo >= 2).length,
    };
  };

  function sync(now: number): void {
    const today = dayKey(now);
    if (day !== today) {
      day = today;
      started = false;
      done = false;
      freshSession = false;
    }
    if (started) return;
    const records = d.store.readDay(today);
    if (!records.some((r) => r.type === 'day.rollover')) return;
    started = true;
    done = records.some((r) => r.type === 'effect.closed' && (r.windowId === 'review' || r.windowId === 'review:fresh') && (r.by === 'user' || r.by === 'page'));
    const freshAudit = records.filter((r) => r.windowId === 'review:fresh' && (r.type === 'effect.shown' || r.type === 'effect.closed')).at(-1);
    freshSession = freshAudit?.type === 'effect.shown';
  }

  const actions = noteActions(d.notes, 'review', reviewView);
  return {
    name: 'review',
    audit: true,
    desired(now) {
      sync(now);
      if (required(now) || (freshSession && !done)) {
        if (!d.welcomeAllowed?.(now) || d.store.health().writeError) return { windows: [], dims: [] };
        freshSession = true;
        return {
          windows: [{
            id: 'review:fresh', path: `/ui/review.html?day=${yesterday(now)}`, title: 'work-balancer — welcome to a new day',
            mode: 'overlay', placement: 'full', perScreen: true, focus: true, closable: false, intrusive: true,
          }], dims: [],
        };
      }
      if (!started || done || !reviewDay(d.config(), dayKey(now))) return { windows: [], dims: [] };
      if (d.store.health().writeError) return { windows: [], dims: [] };
      return {
        windows: [{
          id: 'review', path: '/ui/review.html', title: 'work-balancer — good morning', mode: 'floating', placement: 'center',
          w: 1000, h: 860, focus: false, closable: true, intrusive: true,
        }],
        dims: [],
      };
    },
    closed(_id, by, now) {
      sync(now);
      if (!required(now) && (by === 'user' || by === 'page')) { done = true; freshSession = false; }
    },
    model: () => reviewView(),
    action(_id, action, payload, now) {
      if (action.startsWith('report-')) {
        const y = yesterday(now);
        const t = dayKey(now);
        const today = askToday(now) && (required(now) || freshSession);
        if (action === 'report-new') return today ? d.reports.action(action, payload, now, { source: 'review' }) : { ok: false, error: 'day' };
        if (!['report-add', 'report-arm-skip', 'report-skip', 'report-edit', 'report-end-of-day'].includes(action)) return { ok: false, error: `unknown action ${action}` };
        const editDay = action === 'report-edit' ? d.reports.get(obj(payload).id as number)?.day : null;
        if (action === 'report-edit' && editDay !== y && !(today && editDay === t)) return { ok: false, error: 'day' };
        if (action === 'report-end-of-day' && !endOfDayAsked(y)) return { ok: false, error: 'day' };
        return d.reports.action(action, payload, now, { source: 'review', days: (x) => x === y });
      }
      if (action === 'close') {
        if (required(now) && !d.store.health().writeError) return { ok: false, error: 'report-required' };
        sync(now);
        done = true;
        freshSession = false;
        return { ok: true, close: true };
      }
      const fn = (actions as Record<string, (p: unknown) => ActionResult>)[action];
      return fn ? fn(payload) : { ok: false, error: `unknown action ${action}` };
    },
  };
}
