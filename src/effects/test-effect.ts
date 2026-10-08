// Test windows and dim pulses (M7): explicitly requested, time-limited fixtures that exercise every window mode.
// Dev: free to use. Live: only with `live: true` in the request — reserved for tests the owner consented to in the
// session (instructions §10); they bypass the live gate but not panic or R-UI-QUIET, and are never logged to data/.
import type { ActionResult, DimSpec, Effect, Placement, WindowInput, WindowMode } from '../core/effects.ts';
import type { Route } from '../bridge/server.ts';
import type { PolicyConfig } from '../policy/config.ts';
import { dayKey, dayKeysBetween, weekday, weekStartKey } from '../core/time.ts';
import { blockModel, MIN_REASON, phraseMatches, WINDOWS, type WeekInfo } from '../enforcement/enforcement.ts';

const MODES: readonly WindowMode[] = ['normal', 'floating', 'overlay'];
const PLACEMENTS: readonly Placement[] = ['center', 'top-right', 'bottom-right', 'full'];
const MAX_TTL_S = 120;
const MAX_WINDOWS = 4;
/** Product pages the owner can try over synthetic numbers (`page` in `POST /api/test/window`). */
export const TRIAL_PAGES = ['inactivity', 'block', 'countdown', 'warn', 'nudge'] as const;
type TrialPage = (typeof TRIAL_PAGES)[number];

interface Trial {
  page: TrialPage;
  gapFrom: number;
  zeroLimit: boolean;
}

/** A plausible week for the block trial: earlier days a bit under 9 h (zero limit: the weekly budget used up),
 * today as worked. */
function trialWeek(c: PolicyConfig, now: number, todayWorked: number, zeroLimit: boolean): WeekInfo {
  const today = dayKey(now);
  const keys = dayKeysBetween(weekStartKey(today), today);
  const earlier = Math.max(1, keys.length - 1);
  const days = keys.map((k, i) => {
    const dp = c.days[weekday(k)];
    const isToday = k === today;
    const past = zeroLimit ? Math.ceil((c.weeklyBudgetMin * 60 + 600) / earlier) : (8 * 60 + 10 + 7 * i) * 60;
    return { day: k, weekday: weekday(k), workedSeconds: isToday ? todayWorked : past, budgetSeconds: dp.dailyBudgetMin !== null ? dp.dailyBudgetMin * 60 : null, isToday };
  });
  return { workedSeconds: days.reduce((x, d) => x + d.workedSeconds, 0), budgetSeconds: c.weeklyBudgetMin * 60, days };
}

export function createTestEffect(deps: {
  env: 'live' | 'dev';
  now: () => number;
  log?: (msg: string, f: Record<string, unknown>) => void;
  /** The policy (trial pages show its tokens, bypass sentence and report statuses). */
  config?: () => PolicyConfig | null;
}): { effect: Effect; routes: Route[] } {
  /** `trial`: a product page shown over synthetic data (the owner tries the real thing; nothing reaches data/). */
  const windows = new Map<string, { input: WindowInput; until: number; trial?: Trial }>();
  const config = (): PolicyConfig | null => deps.config?.() ?? null;
  const trialModel = (t: Trial, now: number): unknown => {
    const c = config();
    if (t.page === 'inactivity') return { now, gaps: [{ gapId: 'trial', from: t.gapFrom, to: null, maxMinutes: Math.floor((now - t.gapFrom) / 60_000) }] };
    if (!c) return null;
    if (t.page === 'warn') return { now, remainingSeconds: c.ladder.warnBeforeMin * 60, countdownBeforeMin: c.ladder.countdownBeforeMin };
    if (t.page === 'countdown') return { now, remainingSeconds: 7 * 60, reportStatuses: c.reports.statuses, draft: '', recorded: [] };
    if (t.page === 'nudge') return { now, stretchSeconds: (c.breakNudge.afterMin + 2) * 60, snoozeMin: c.breakNudge.snoozeMin };
    const limit = t.zeroLimit ? 0 : 9 * 3600;
    const worked = t.zeroLimit ? 25 * 60 : limit;
    const day = dayKey(now);
    return blockModel(c, { zeroLimit: t.zeroLimit, workedSeconds: worked, limitSeconds: limit, tokensLeft: [...c.tokensMin], bypassesUsed: 0, day }, trialWeek(c, now, worked, t.zeroLimit), now, '');
  };
  /** Trial answers are logged (never their text) and never recorded. */
  const trialAction = (id: string, w: { input: WindowInput; trial?: Trial }, action: string, payload: unknown): ActionResult => {
    const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const done = (extra: Record<string, unknown> = {}): ActionResult => {
      deps.log?.('trial action (not recorded)', { id, page: w.trial?.page, action, ...extra });
      return { ok: true };
    };
    switch (action) {
      case 'save': return { ...done(), note: typeof p.note === 'string' && p.note.trim() ? 'saved' : 'none', report: 'saved' };
      case 'draft': return { ok: true };
      case 'collapse':
      case 'expand':
        w.input = { ...WINDOWS.countdown(action === 'collapse'), id, title: w.input.title };
        return done();
      case 'token':
        windows.delete(id);
        return { ...done({ minutes: p.minutes }), close: true };
      case 'bypass': {
        const c = config();
        if (!c || !phraseMatches(p.phrase, c.bypass.phrase)) return { ok: false, error: 'phrase' };
        if (typeof p.reason !== 'string' || p.reason.trim().length < MIN_REASON) return { ok: false, error: 'reason' };
        windows.delete(id);
        return { ...done(), close: true };
      }
      case 'resolve':
      case 'snooze':
      case 'break':
        windows.delete(id);
        return { ...done(), close: true };
      default:
        return { ok: false, error: `unknown action ${action}` };
    }
  };
  let dims: { spec: DimSpec; until: number }[] = [];
  let n = 0;

  const effect: Effect = {
    name: 'test',
    audit: false,
    gateExempt: true,
    desired(now) {
      for (const [id, w] of windows) if (w.until <= now) windows.delete(id);
      dims = dims.filter((d) => d.until > now);
      return { windows: [...windows.values()].map((w) => w.input), dims: dims.map((d) => d.spec) };
    },
    closed(id, by) {
      if (by === 'user' || by === 'page') windows.delete(id);
    },
    model(id, now) {
      const w = windows.get(id);
      if (!w) return null;
      if (w.trial) return trialModel(w.trial, now);
      return { mode: w.input.mode, perScreen: !!w.input.perScreen, focus: !!w.input.focus, secondsLeft: Math.max(0, Math.round((w.until - now) / 1000)) };
    },
    action(id, action, payload) {
      if (action === 'close') {
        windows.delete(id);
        return { ok: true, close: true };
      }
      const w = windows.get(id);
      if (w?.trial) return trialAction(id, w, action, payload);
      if (action === 'echo') {
        const text = payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string' ? (payload as { text: string }).text : '';
        return { ok: true, echo: text };
      }
      return { ok: false, error: `unknown action ${action}` };
    },
  };

  type Body = Record<string, unknown>;
  const asBody = (b: unknown): Body => (b && typeof b === 'object' ? (b as Body) : {});
  const liveRefused = (b: Body) => deps.env === 'live' && b.live !== true;
  const ttl = (b: Body): number => Math.min(MAX_TTL_S, Math.max(1, typeof b.ttlSeconds === 'number' ? b.ttlSeconds : 30)) * 1000;

  const routes: Route[] = [
    {
      method: 'POST', path: '/api/test/window', auth: true,
      handle: ({ body }) => {
        const b = asBody(body);
        if (liveRefused(b)) return { status: 403, json: { error: 'live test windows need "live": true (owner consent)' } };
        effect.desired(deps.now()); // drop expired ones before counting
        if (windows.size >= MAX_WINDOWS) return { status: 429, json: { error: `at most ${MAX_WINDOWS} test windows` } };
        const mode = MODES.includes(b.mode as WindowMode) ? (b.mode as WindowMode) : 'normal';
        const placement = PLACEMENTS.includes(b.placement as Placement) ? (b.placement as Placement) : mode === 'overlay' ? 'full' : 'center';
        const id = `test:${++n}`;
        if (b.page !== undefined) {
          // A real product page over synthetic numbers: `inactivity` (`gapMinutes`, default 12), `block` (`zeroLimit`),
          // `countdown`, `warn`, `nudge`. Same window shape as the real one.
          if (!TRIAL_PAGES.includes(b.page as TrialPage)) return { status: 400, json: { error: `page must be one of ${TRIAL_PAGES.join(', ')}` } };
          const page = b.page as TrialPage;
          if (page !== 'inactivity' && !config()) return { status: 409, json: { error: 'no valid policy' } };
          const gapMin = typeof b.gapMinutes === 'number' ? Math.min(240, Math.max(1, b.gapMinutes)) : 12;
          const base: WindowInput = page === 'inactivity'
            ? { id, path: '/ui/inactivity.html', mode: 'overlay', placement: 'full', perScreen: true, focus: true, closable: false, title: 'work-balancer — welcome back', intrusive: true }
            : page === 'countdown' ? WINDOWS.countdown(false) : WINDOWS[page]();
          const input: WindowInput = { ...base, id, title: `${base.title} (trial)` };
          windows.set(id, { input, until: deps.now() + ttl(b), trial: { page, gapFrom: deps.now() - gapMin * 60_000, zeroLimit: b.zeroLimit === true } });
          return { json: { ok: true, id } };
        }
        const input: WindowInput = {
          // `broken`: a page that never loads (HTTP 404) — exercises the readiness handshake / fail-open.
          id, path: b.broken === true ? '/ui/missing-page.html' : `/ui/fixture.html?mode=${mode}`, mode, placement, title: `work-balancer test (${mode})`,
          perScreen: b.perScreen === true, focus: b.focus === true, closable: mode !== 'overlay',
          // Screen-covering windows are always intrusive (the manager enforces it too).
          intrusive: b.intrusive !== false || mode === 'overlay' || placement === 'full',
          ...(typeof b.w === 'number' ? { w: b.w } : {}), ...(typeof b.h === 'number' ? { h: b.h } : {}),
        };
        windows.set(id, { input, until: deps.now() + ttl(b) });
        return { json: { ok: true, id } };
      },
    },
    {
      method: 'POST', path: '/api/test/dim', auth: true,
      handle: ({ body }) => {
        const b = asBody(body);
        if (liveRefused(b)) return { status: 403, json: { error: 'live test dims need "live": true (owner consent)' } };
        const spec: DimSpec = {
          pulseId: `test-${deps.now()}-${++n}`,
          level: typeof b.level === 'number' ? b.level : 0.6,
          seconds: typeof b.seconds === 'number' ? b.seconds : 3,
          cancelOnInput: b.cancelOnInput === true,
        };
        dims.push({ spec, until: deps.now() + ttl(b) });
        return { json: { ok: true, pulseId: spec.pulseId } };
      },
    },
    {
      method: 'POST', path: '/api/test/clear', auth: true,
      handle: () => {
        windows.clear();
        dims = [];
        return { json: { ok: true } };
      },
    },
  ];
  return { effect, routes };
}
