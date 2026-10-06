// The M8 product windows: the menu's quick note / status notes / activity summary / quit (user-initiated), and the
// morning review (system-initiated, R-UI-REVIEW). Wording lives in src/ui/strings.ts; pages in src/ui/pages/.
import type { ActionResult, Effect } from '../core/effects.ts';
import { addDays, dayKey, weekday, type DayKey } from '../core/time.ts';
import type { PolicyConfig } from '../policy/config.ts';
import type { Store } from '../store/store.ts';
import type { Note, NoteResult, Notes, NoteSource } from '../notes/notes.ts';
import { windowRev, type EffectsManager } from './manager.ts';
import { userWindowEffect } from './user-window.ts';
import type { Reports } from '../reports/reports.ts';

export interface ProductDeps {
  effects: EffectsManager;
  notes: Notes;
  store: Store;
  now: () => number;
  config: () => PolicyConfig | null;
  summary: (now: number) => unknown;
  /** Quit is refused while enforcement is due (countdown / blocked — also during a token): otherwise one cheap token
   * would open the way to stopping the whole day (review M10#5). Default: allowed. */
  quitAllowed?: (now: number) => boolean;
  reports?: Reports;
  welcomeAllowed?: (now: number) => boolean;
}

/** A note as pages see it. */
export interface NoteView {
  id: string;
  kind: Note['kind'];
  text: string;
  choices: string[];
  energy: number | null;
  day: DayKey;
  createdAt: number;
  dismissed: boolean;
}

export const noteView = (n: Note): NoteView => ({
  id: n.id, kind: n.kind, text: n.text, choices: n.choices, energy: n.energy, day: n.day, createdAt: n.createdAt, dismissed: n.dismissedAt !== null,
});

const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {});

const answer = (r: NoteResult, extra: () => Record<string, unknown>): ActionResult =>
  r.ok ? { ok: true, ...extra() } : { ok: false, error: r.error };

type Part = 'saved' | 'failed' | 'none';

/** R-UI-CTX + R-UI-FB (quick note, countdown, block): one `context` note and/or one `feedback` note from
 * `{ context, feedback: { text, choices, energy } }`. Each part reports saved/failed/none, so the page clears what was
 * saved and keeps (for a retry) only what failed — never a duplicate. */
export function submitContextAndFeedback(notes: Notes, source: NoteSource, p: unknown): ActionResult & { context: Part; feedback: Part } {
  const b = obj(p);
  const fb = obj(b.feedback);
  const part = (r: NoteResult): Part => (r.ok ? 'saved' : r.error === 'empty' ? 'none' : 'failed');
  const context: Part = typeof b.context === 'string' && b.context.trim() ? part(notes.create({ kind: 'context', text: b.context, source })) : 'none';
  const feedback = part(notes.create({ kind: 'feedback', text: fb.text, choices: fb.choices, energy: fb.energy, source }));
  if (context === 'none' && feedback === 'none') return { ok: false, error: 'empty', context, feedback };
  if (context === 'failed' || feedback === 'failed') return { ok: false, error: 'write', context, feedback };
  return { ok: true, context, feedback };
}

/** edit / dismiss / undismiss / add — shared by the notes manager and the morning review. */
function noteActions(notes: Notes, source: NoteSource, view: () => Record<string, unknown>) {
  return {
    add: (p: unknown) => answer(notes.create({ kind: 'note', text: obj(p).text, source }), view),
    edit: (p: unknown) => answer(notes.edit(obj(p).id, obj(p).text), view),
    dismiss: (p: unknown) => answer(notes.dismiss(obj(p).id), view),
    undismiss: (p: unknown) => answer(notes.undismiss(obj(p).id), view),
  };
}

export function registerProductEffects(d: ProductDeps): void {
  const feedbackChoices = (): string[] => d.config()?.feedbackChoices ?? [];

  d.effects.register(userWindowEffect({
    name: 'quick',
    look: { path: '/ui/quick.html', title: 'work-balancer — quick note', w: 900, h: 860 },
    model: () => ({ feedbackChoices: feedbackChoices() }),
    actions: {
      // R-UI-CTX + R-UI-FB: one `context` note and/or one `feedback` note. Each part reports saved/failed/none, so
      // the page clears what was saved and keeps (for a retry) only what failed — never a duplicate.
      submit(p) {
        const r = submitContextAndFeedback(d.notes, 'quick', p);
        return r.ok ? { ...r, closing: true } : r; // the page shows "Saved." and closes itself
      },
    },
  }));

  const notesView = () => ({ notes: d.notes.list().map(noteView) });
  d.effects.register(userWindowEffect({
    name: 'notes',
    look: { path: '/ui/notes.html', title: 'work-balancer — status notes', w: 0.9, h: 0.9 },
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

  if (d.reports) {
    const reports = d.reports;
    const window = userWindowEffect({
      name: 'reports',
      look: { path: '/ui/reports.html', title: 'work-balancer — daily energy reports', w: 0.9, h: 0.9 },
      model: (now) => {
        const dates = reports.list(now);
        return {
          today: dayKey(now), reports: dates, feedbackChoices: feedbackChoices(),
          preferredDay: manual ? null : dates.find((r) => r.daysAgo >= 2 && r.status === 'pending')?.day ?? null,
        };
      },
      actions: Object.fromEntries(['report-submit', 'report-arm-skip', 'report-skip'].map((action) => [
        action, (p: unknown, now: number) => reports.action(action, p, now),
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
        if (reports.freshDue(now)) consideredDay = today; // offer catch-up after the fresh checkpoint, not another popup
        if (!manual && wd !== 'fri' && wd !== 'sat' && d.welcomeAllowed?.(now) && !reports.freshDue(now) && consideredDay !== today) {
          const shown = d.store.readDay(today).some((r) =>
            (r.type === 'effect.shown' && (r.windowId === 'reports' || r.windowId === 'review:fresh'))
            || (r.type === 'day.rollover' && r.review === true));
          if (shown) consideredDay = today;
          else if (reports.list(now).some((r) => r.daysAgo >= 2 && r.status === 'pending')) {
            consideredDay = today;
            window.request?.(now);
          }
        }
        const result = window.desired(now);
        if (!manual && (wd === 'fri' || wd === 'sat' || (!adoptedAutomatic && !d.welcomeAllowed?.(now)) || reports.freshDue(now))) return { windows: [], dims: [] };
        return manual ? result : { ...result, windows: result.windows.map((w) => ({ ...w, focus: false, intrusive: true })) };
      },
      closed(id, by, now) { window.closed?.(id, by, now); manual = manual && window.isOpen(); adoptedAutomatic = adoptedAutomatic && window.isOpen(); },
    });
  }
  d.effects.register(createReviewEffect(d));
}

/**
 * Morning review (R-UI-REVIEW, D-35): decided once per day by the `day.rollover` record (`review: true` on a review
 * day with notes waiting), then shown until the owner closes it — "done for today" = an `effect.closed` for `review`
 * by `user`/`page` in today's file. Involuntary losses (reload, fail-open) bring it back. Intrusive: live gate,
 * R-UI-QUIET and panic apply.
 */
export function createReviewEffect(d: Pick<ProductDeps, 'notes' | 'store' | 'now' | 'config' | 'reports' | 'welcomeAllowed'>): Effect {
  let day: DayKey | null = null;
  let decided: boolean | null = null; // null until today's rollover record exists
  let done = false;
  let freshSession = false;
  const required = (now: number): boolean => d.reports?.freshDue(now) === true && !['fri', 'sat'].includes(weekday(dayKey(now)));
  const reviewView = () => ({
    notes: d.notes.active().map(noteView),
    report: (required(d.now()) || freshSession) ? d.reports?.get(addDays(dayKey(d.now()), -1), d.now()) : null,
    feedbackChoices: d.config()?.feedbackChoices ?? [],
    olderCount: d.reports?.list(d.now()).filter((r) => r.daysAgo >= 2 && r.status === 'pending').length ?? 0,
  });

  function sync(now: number): void {
    const today = dayKey(now);
    if (day !== today) {
      day = today;
      decided = null;
      done = false;
      freshSession = false;
    }
    if (decided !== null) return;
    const records = d.store.readDay(today);
    const rollover = records.find((r) => r.type === 'day.rollover');
    if (!rollover) return;
    decided = rollover.review === true && d.config()?.days[weekday(today)].morningReview === true;
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
            id: 'review:fresh', path: `/ui/review.html?day=${addDays(dayKey(now), -1)}`, title: 'work-balancer — welcome to a new day',
            mode: 'overlay', placement: 'full', perScreen: true, focus: true, closable: false, intrusive: true,
          }], dims: [],
        };
      }
      if (!decided || done) return { windows: [], dims: [] };
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
        if (obj(payload).day !== addDays(dayKey(now), -1)) return { ok: false, error: 'day' };
        return d.reports?.action(action, payload, now) ?? { ok: false, error: 'unavailable' };
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
