process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createTracker } from '../daemon/tracker.ts';
import { createStore, type Store } from '../store/store.ts';
import { createPolicyLoader } from '../policy/config.ts';
import { fixedClock } from '../core/clock.ts';
import { REPO_ROOT } from '../core/env.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';
import { testPolicy } from '../testing/config.ts';
import { createEffectsManager } from './manager.ts';
import { DEFAULT_QUIET } from './reconcile.ts';
import type { ActualUi, UiCommand } from '../core/effects.ts';

type Cmd = UiCommand & Record<string, any>;

async function setup(start: number, opts: { env?: 'dev' | 'live'; dir?: string; reportsStart?: string; seed?: (store: Store, clock: ReturnType<typeof fixedClock>) => void } = {}) {
  const tmp = opts.dir ? { dir: opts.dir, cleanup() {} } : makeTmpDir('product');
  const clock = fixedClock(start);
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  opts.seed?.(store, clock);
  clock.set(start);
  // Live-env tests are about the closed gate: the owner's policy with liveEffects false (whatever his file says).
  const configPath = testPolicy(tmp.dir, { reportsStartDay: opts.reportsStart ?? null, ...(opts.env === 'live' ? { liveEffects: false } : {}) });
  const policy = createPolicyLoader({ path: configPath, snapshotPath: join(tmp.dir, 'snap.json'), log: silentLogger });
  await policy.refresh();
  const env = opts.env ?? 'dev';
  const effects = createEffectsManager({
    env, store, log: silentLogger, now: () => clock.now(),
    gateOpen: () => env === 'dev' || policy.state().config?.liveEffects === true,
    lastInputAt: () => null, quiet: () => DEFAULT_QUIET,
  });
  const tracker = await createTracker({ store, clock, log: silentLogger, policy, startedAt: start, copilotHome: join(tmp.dir, 'empty-home'), effects });
  const routes = effects.routes();
  const call = (method: 'GET' | 'POST', path: string, body: unknown = null, query = '') =>
    routes.find((r) => r.method === method && r.path === path)!.handle({ body, query: new URLSearchParams(query), path }) as { status?: number; json: any };
  const request = (open: string) => call('POST', '/bridge/ui-request', { open });
  const action = (win: string, act: string, payload?: unknown) => call('POST', '/api/ui/action', { win, action: act, payload }).json;
  const model = (win: string) => call('GET', '/api/ui/model', null, `win=${win}`).json.model;
  const beat = (actual: Partial<ActualUi> = {}, acks: string[] = []): Cmd[] =>
    effects.heartbeat({ actual: { windows: {}, dimmed: false, closed: [], ...actual }, acks, panic: false, now: clock.now() }) as Cmd[];
  return { ...tmp, clock, store, tracker, effects, request, action, model, beat };
}

const types = (store: Store, day: string) => store.readDay(day).map((r) => r.type);
const report = (timestamp: string, energy: number) => ({ type: 'report.created', reportId: Date.parse(`${timestamp.replace(' ', 'T')}:00+03:00`), timestamp, stage: 'evening', feedback: '', status: [], energy, source: 'manager' });

test('menu windows: a request opens a floating, focused, non-intrusive window — live gate or not; again = focus', async (t) => {
  const s = await setup(local(2026, 10, 5, 11, 0), { env: 'live' }); // live: liveEffects false
  t.after(s.cleanup);
  assert.deepEqual(s.beat(), []);
  assert.equal(s.request('reports').json.ok, true);
  assert.equal(s.request('review').status, 404, 'system effects cannot be requested');
  assert.equal(s.request('quick').status, 404, 'no quick note any more');
  assert.equal(s.request('nope').status, 404);
  const [open] = s.beat();
  assert.equal(open!.op, 'window.open');
  assert.equal(open!.window.id, 'reports');
  assert.equal(open!.window.mode, 'floating');
  assert.equal(open!.window.focus, true);
  assert.equal(open!.window.intrusive, false);
  assert.equal(open!.window.closable, true);
  const shown = { reports: open!.window.rev };
  assert.deepEqual(s.beat({ windows: shown }), []);
  s.request('reports');
  const again = s.beat({ windows: shown });
  assert.deepEqual(again.map((c) => [c.op, c.windowId]), [['window.focus', 'reports']]);
  assert.deepEqual(s.beat({ windows: shown }), [], 'focus once');
  // The owner closes it (later than the 2 s reopen window): forgotten, audited.
  s.clock.advance(5000);
  assert.deepEqual(s.beat({ closed: [{ id: 'reports', by: 'user', at: 1 }] }), []);
  const day = s.store.readDay('2026-10-05').filter((r) => r.type.startsWith('effect.'));
  assert.deepEqual(day.map((r) => [r.type, r.windowId, r.by]), [['effect.shown', 'reports', undefined], ['effect.closed', 'reports', 'user']]);
  // Every menu item has a window.
  for (const id of ['summary', 'notes', 'quit']) {
    s.request(id);
    assert.ok(s.beat().some((c) => c.op === 'window.open' && c.window.id === id), id);
  }
});

test('reports: Thursday to Sunday; fresh welcome is firm, Manage Reports has every missing day, form input is not work', async (t) => {
  const sun = local(2026, 10, 11, 9, 0);
  const s = await setup(sun, { reportsStart: '2026-10-08' });
  t.after(s.cleanup);
  s.tracker.tick(sun);
  assert.deepEqual(s.beat(), [], 'no automatic overlay while the owner is absent');
  s.tracker.ingest({ since: sun - 5000, inputs: [sun], apps: [], system: [], locked: false }, sun);
  const open = s.beat().find((c) => c.op === 'window.open' && c.window.id === 'review:fresh')!;
  assert.ok(open);
  assert.equal(open.window.closable, false);
  assert.equal(open.window.perScreen, true);
  assert.equal(open.window.mode, 'overlay');
  assert.equal(s.model('review:fresh').welcome.day, '2026-10-10');
  assert.deepEqual(s.model('review:fresh').welcome.reports, []);
  assert.equal(s.action('review:fresh', 'close').error, 'report-required');
  assert.equal(s.action('review:fresh', 'report-add', { day: '2026-10-08', stage: 'evening', energy: 2 }).error, 'day');
  assert.equal(s.action('review:fresh', 'report-new', { energy: 2 }).ok, false, 'the welcome reports on yesterday only');
  s.beat({ windows: { 'review:fresh': open.window.rev } });
  s.clock.advance(60_000);
  s.tracker.ingest({ since: sun, inputs: [sun + 30_000], apps: [], system: [], locked: false }, s.clock.now());
  assert.equal((s.tracker.status(s.clock.now()) as { workedSeconds: number }).workedSeconds, 0, 'welcome input cannot consume budget');
  assert.equal(s.action('review:fresh', 'report-add', { day: '2026-10-10', stage: 'end-of-workday', energy: 4 }).ok, true);
  assert.equal(s.model('review:fresh').welcome.reports[0].timestamp, '2026-10-10 23:59');
  // Answered, then dismissed in Manage Reports: a stub, never a second welcome today.
  const answered = s.model('review:fresh').welcome.reports[0].id;
  assert.equal(s.action('reports', 'report-dismiss', { id: answered }).ok, true);
  assert.ok(s.tracker.menubar(s.clock.now()).menu!.some((m) => m.id === 'quit'), 'not required again (Quit is back)');
  assert.equal(s.action('reports', 'report-undismiss', { id: answered }).ok, true);
  assert.ok(s.effects.desired(s.clock.now()).windows.some((w) => w.id === 'review:fresh'), 'Continue is still available after recording');
  assert.equal(s.action('review:fresh', 'close').close, true);
  s.beat({ closed: [{ id: 'review:fresh', by: 'page', at: s.clock.now() }] });
  assert.ok(!s.effects.desired(s.clock.now()).windows.some((w) => w.id === 'reports'), 'no follow-up popup after the firm welcome');
  assert.equal(s.request('reports').json.ok, true);
  const menu = s.beat().find((c) => c.op === 'window.open' && c.window.id === 'reports')!;
  assert.equal(menu.window.intrusive, false);
  assert.equal(menu.window.closable, true);
  assert.equal(s.model('reports').preferredDay, null);
  assert.deepEqual(s.model('reports').stubs.map((r: { day: string }) => r.day), ['2026-10-11', '2026-10-09', '2026-10-08']);
  assert.equal(s.action('reports', 'report-new', { energy: 3 }).ok, true, 'today can be reported before leaving a short day');
  assert.match(s.tracker.menubar(s.clock.now()).menu!.find((m) => m.id === 'reports')!.title, /^Manage Reports \(2 days without a report\)$/);
  assert.deepEqual(s.model('summary').reports.map((r: { day: string; energy: number }) => [r.day, r.energy]), [['2026-10-11', 3], ['2026-10-10', 4]]);
  s.action('reports', 'close');
  s.request('reports');
  const reopened = s.beat({ closed: [{ id: 'reports', by: 'page', at: s.clock.now() }] }).find((c) => c.window?.id === 'reports')!;
  assert.equal(reopened.window.intrusive, false, 'a menu click while closing stays manual');
  const restartAt = s.clock.now() + 60_000;
  const again = await setup(restartAt, { reportsStart: '2026-10-08', dir: s.dir });
  again.tracker.tick(restartAt);
  again.tracker.ingest({ since: restartAt - 5000, inputs: [restartAt], apps: [], system: [], locked: false }, restartAt);
  assert.ok(!again.effects.desired(restartAt).windows.some((w) => w.id === 'review:fresh' || w.id === 'reports'), 'completed welcome and catch-up suppression survive restart');
});

test('fresh welcome survives restart and changes its revision at 04:00 without resolving missed dates', async (t) => {
  const start = local(2026, 10, 12, 3, 59);
  const s = await setup(start, { reportsStart: '2026-10-08' });
  t.after(s.cleanup);
  s.tracker.tick(start);
  s.tracker.ingest({ since: start - 5000, inputs: [start], apps: [], system: [], locked: false }, start);
  const open = s.beat().find((c) => c.window?.id === 'review:fresh')!;
  s.beat({ windows: { 'review:fresh': open.window.rev } });
  const next = start + 10_000;
  const again = await setup(next, { reportsStart: '2026-10-08', dir: s.dir });
  again.tracker.tick(next);
  again.tracker.ingest({ since: start, inputs: [next], apps: [], system: [], locked: false }, next);
  assert.equal(again.action('review:fresh', 'close').error, 'report-required');
  const before = again.effects.desired(next).windows.find((w) => w.id === 'review:fresh')!;
  again.clock.set(local(2026, 10, 12, 4, 0, 5));
  again.tracker.tick(again.clock.now());
  again.tracker.ingest({ since: next, inputs: [again.clock.now()], apps: [], system: [], locked: false }, again.clock.now());
  const after = again.effects.desired(again.clock.now()).windows.find((w) => w.id === 'review:fresh')!;
  assert.notEqual(before.path, after.path, 'new target date rebuilds the page rather than leaving yesterday’s form');
  assert.equal(again.model('review:fresh').welcome.day, '2026-10-11');
  assert.ok(again.model('reports').stubs.some((r: { day: string }) => r.day === '2026-10-10'));
});

test('the welcome is decided at the rollover: dismissing yesterday\'s report later leaves a stub, not a full-screen welcome', async (t) => {
  const sun = local(2026, 10, 11, 9, 0);
  const s = await setup(sun, { reportsStart: '2026-10-08', seed: (store) => store.append(report('2026-10-10 21:00', 4)) });
  t.after(s.cleanup);
  s.tracker.tick(sun);
  assert.equal(s.store.readDay('2026-10-11').find((r) => r.type === 'day.rollover')!.reportMissing, false);
  s.tracker.ingest({ since: sun - 5000, inputs: [sun], apps: [], system: [], locked: false }, sun);
  const id = s.model('reports').reports[0].id;
  assert.equal(s.action('reports', 'report-dismiss', { id }).ok, true);
  assert.ok(!s.effects.desired(sun).windows.some((w) => w.id === 'review:fresh'));
  assert.ok(s.model('reports').stubs.some((x: { day: string }) => x.day === '2026-10-10'));
});

test('rapid welcome completion before first shown heartbeat does not spend the work budget', async (t) => {
  const start = local(2026, 10, 11, 9, 0);
  const s = await setup(start, { reportsStart: '2026-10-08' });
  t.after(s.cleanup);
  s.tracker.tick(start);
  s.tracker.ingest({ since: start - 5000, inputs: [start], apps: [], system: [], locked: false }, start);
  assert.ok(s.beat().some((c) => c.window?.id === 'review:fresh'));
  s.clock.advance(3500);
  assert.equal(s.action('review:fresh', 'report-add', { day: '2026-10-10', stage: 'evening', energy: 3 }).ok, true);
  s.action('review:fresh', 'close');
  s.clock.set(start + 5000);
  s.tracker.ingest({ since: start, inputs: [start + 1000, start + 2000, start + 3000], apps: [], system: [], locked: false }, s.clock.now());
  s.beat({ closed: [{ id: 'review:fresh', by: 'page', at: start + 3500, openedAt: start }] });
  assert.equal((s.tracker.status(s.clock.now()) as { workedSeconds: number }).workedSeconds, 0);
  s.clock.advance(300_000);
  assert.equal((s.tracker.status(s.clock.now()) as { workedSeconds: number }).workedSeconds, 0, 'no five-minute grace from report-only clicks');
});

test('automatic catch-up adoption keeps the same revision so drafts survive daemon restart', async (t) => {
  const start = local(2026, 10, 11, 9, 0);
  const seed = (store: Store) => store.append(report('2026-10-10 21:00', 4));
  const s = await setup(start, { reportsStart: '2026-10-08', seed });
  t.after(s.cleanup);
  s.tracker.ingest({ since: start - 5000, inputs: [start], apps: [], system: [], locked: false }, start);
  const open = s.beat().find((c) => c.window?.id === 'reports')!;
  s.beat({ windows: { reports: open.window.rev } });
  const next = start + 5000;
  const again = await setup(next, { reportsStart: '2026-10-08', dir: s.dir });
  again.tracker.ingest({ since: start, inputs: [], apps: [], system: [], locked: false }, next);
  assert.deepEqual(again.beat({ windows: { reports: open.window.rev } }), [], 'no replacement command destroying the existing webview');
  assert.equal(again.effects.desired(next).windows.find((w) => w.id === 'reports')!.rev, open.window.rev);
});

test('reports: Friday/Saturday quiet; Monday/Wednesday fresh; live gate and panic; older catch-up once', async (t) => {
  for (const date of [9, 10, 12, 14]) {
    const now = local(2026, 10, date, 9, 0);
    const s = await setup(now, { reportsStart: '2026-10-08' });
    t.after(s.cleanup);
    s.tracker.tick(now);
    s.tracker.ingest({ since: now - 5000, inputs: [now], apps: [], system: [], locked: false }, now);
    assert.equal(s.effects.desired(now).windows.some((w) => w.id === 'review:fresh'), date === 12 || date === 14);
    if (date === 9 || date === 10) assert.deepEqual(s.beat(), []);
    assert.deepEqual(s.effects.heartbeat({ actual: { windows: {}, dimmed: false, closed: [] }, acks: [], panic: true, now }), [], 'panic suppresses automatic effects');
  }
  const sun = local(2026, 10, 11, 9, 0);
  const live = await setup(sun, { reportsStart: '2026-10-08', env: 'live' });
  t.after(live.cleanup);
  live.tracker.ingest({ since: sun - 5000, inputs: [sun], apps: [], system: [], locked: false }, sun);
  assert.deepEqual(live.beat(), [], 'live gate suppresses fresh report');
  assert.equal(live.request('reports').json.ok, true);
  assert.ok(live.beat().some((c) => c.window?.id === 'reports'), 'manual reports work with the gate closed');
  const old = await setup(sun, { reportsStart: '2026-10-08', seed: (store) => {
    store.append(report('2026-10-10 21:00', 4));
  } });
  t.after(old.cleanup);
  old.tracker.ingest({ since: sun - 5000, inputs: [sun], apps: [], system: [], locked: false }, sun);
  const open = old.beat().find((c) => c.window?.id === 'reports')!;
  assert.ok(open);
  assert.equal(open.window.mode, 'floating');
  assert.equal(open.window.focus, false);
  assert.equal(old.model('reports').preferredDay, '2026-10-09', 'automatic catch-up points at an older missing date, not today');
  old.beat({ windows: { reports: open.window.rev } });
  old.beat({ closed: [{ id: 'reports', by: 'user', at: sun }] });
  assert.deepEqual(old.beat(), [], 'Not now silences catch-up for this day');
});

test('Manage Reports: new / edit / dismiss / bring back; newest first; dismissed ones leave the model', async (t) => {
  const T = local(2026, 10, 8, 18, 0); // Thursday evening
  const s = await setup(T, { reportsStart: '2026-10-07' });
  t.after(s.cleanup);
  s.request('reports');
  s.beat();
  const m = s.model('reports');
  assert.deepEqual(m.statuses, ['Too much work', 'Feeling tired', 'Anxious', 'Stuck / frustrated', 'Productive', 'Good day']);
  assert.deepEqual(m.stages, ['morning', 'afternoon', 'evening', 'end-of-workday']);
  assert.deepEqual(m.stubs.map((x: any) => [x.day, x.daysAgo]), [['2026-10-08', 0], ['2026-10-07', 1]]);
  assert.deepEqual(s.action('reports', 'report-new', { status: [], feedback: ' ', energy: null }), { ok: false, error: 'empty' });
  const a = s.action('reports', 'report-new', { status: ['Feeling tired', 'Other'], feedback: 'long day', energy: 2 });
  assert.deepEqual(a, { ok: true, id: T });
  s.clock.advance(1000);
  const b = s.action('reports', 'report-add', { day: '2026-10-07', stage: 'afternoon', status: ['Productive'] });
  assert.equal(b.ok, true);
  const list = s.model('reports').reports;
  assert.deepEqual(list.map((r: any) => [r.timestamp, r.stage, r.status, r.source]), [
    ['2026-10-08 18:00', 'evening', ['Feeling tired'], 'manager'], ['2026-10-07 12:30', 'afternoon', ['Productive'], 'manager'],
  ]);
  assert.deepEqual(s.model('reports').stubs, []);
  assert.equal(s.action('reports', 'report-edit', { id: T, status: ['Feeling tired'], feedback: 'long day, then fine', energy: 3 }).ok, true);
  assert.equal(s.model('reports').reports[0].energy, 3);
  assert.equal(s.action('reports', 'report-dismiss', { id: b.id }).ok, true);
  assert.deepEqual(s.model('reports').reports.map((r: any) => r.id), [T]);
  assert.deepEqual(s.model('reports').stubs.map((x: any) => x.day), ['2026-10-07'], 'a dismissed report leaves its day without one');
  assert.equal(s.action('reports', 'report-undismiss', { id: b.id }).ok, true);
  assert.equal(s.model('reports').reports.length, 2);
  assert.deepEqual(types(s.store, '2026-10-08').filter((x) => x.startsWith('report.')),
    ['report.created', 'report.created', 'report.edited', 'report.dismissed', 'report.undismissed']);
  assert.equal(s.store.readDay('2026-10-08').some((r) => r.type.startsWith('note.')), false, 'reports are never notes');
});

test('menu: Manage Reports, Manage Notes, summary, Early End-Of-Day (enforcing day before the countdown), Quit', async (t) => {
  const s = await setup(local(2026, 10, 8, 10, 0)); // Thursday, enforcing
  t.after(s.cleanup);
  s.tracker.ingest({ since: s.clock.now() - 5000, inputs: [s.clock.now()], apps: [], system: [], locked: false }, s.clock.now());
  const menu = s.tracker.menubar(s.clock.now()).menu!;
  assert.deepEqual(menu.map((m) => [m.id, m.title]), [
    ['reports', 'Manage Reports'], ['notes', 'Manage Notes'], ['summary', 'Show activity summary'], ['countdown', 'Early End-Of-Day…'],
    ['-', ''], ['quit', 'Quit work-balancer…'],
  ]);
  const fri = await setup(local(2026, 10, 9, 10, 0));
  t.after(fri.cleanup);
  assert.ok(!fri.tracker.menubar(fri.clock.now()).menu!.some((m) => m.id === 'countdown'), 'no budget on Friday: nothing to end early');
});

test('notes manager: add / edit / dismiss / bring back; model = waiting first, then dismissed', async (t) => {
  const s = await setup(local(2026, 10, 8, 18, 0));
  t.after(s.cleanup);
  const a = s.action('notes', 'add', { text: 'first' });
  assert.equal(a.ok, true);
  s.clock.advance(1000);
  const b = s.action('notes', 'add', { text: 'second' });
  const [first, second] = b.notes;
  assert.deepEqual(b.notes.map((n: any) => n.text), ['first', 'second']);
  assert.equal(first.day, '2026-10-08');
  assert.equal(s.action('notes', 'dismiss', { id: first.id }).notes.map((n: any) => `${n.text}:${n.dismissed}`).join(','), 'second:false,first:true');
  assert.equal(s.action('notes', 'edit', { id: second.id, text: 'second, edited' }).notes[0].text, 'second, edited');
  assert.equal(s.action('notes', 'undismiss', { id: first.id }).notes.map((n: any) => n.text).join(','), 'first,second, edited');
  assert.deepEqual(s.action('notes', 'add', { text: ' ' }), { ok: false, error: 'empty' });
  assert.deepEqual(s.action('notes', 'edit', { id: 1, text: 'y' }), { ok: false, error: 'unknown' });
  assert.equal(s.model('notes').notes.length, 2);
  assert.deepEqual(Object.keys(s.model('notes').notes[0]).sort(), ['createdAt', 'day', 'dismissed', 'id', 'text']);
  const sources = s.store.readDay('2026-10-08').filter((r) => r.type === 'note.created').map((r) => r.source);
  assert.deepEqual(sources, ['manager', 'manager']);
});

test('a restarted daemon adopts open menu windows; a Hammerspoon reload ends them (not reopened)', async (t) => {
  const dir = makeTmpDir('product-restart');
  t.after(dir.cleanup);
  const T = local(2026, 10, 8, 18, 0);
  const first = await setup(T, { dir: dir.dir });
  first.request('notes');
  const rev = first.beat()[0]!.window.rev;
  first.beat({ windows: { notes: rev } });
  // New daemon, Lua still shows the window (the owner may be typing in it): no close.
  const second = await setup(T + 60_000, { dir: dir.dir });
  assert.deepEqual(second.beat({ windows: { notes: rev } }), []);
  assert.deepEqual(second.beat({ windows: { notes: rev } }), []);
  // Lua reloaded: the window vanished without a report → closed by reload, and stays closed.
  assert.deepEqual(second.beat({ windows: {} }), []);
  assert.deepEqual(second.beat({ windows: {} }), []);
  const audit = second.store.readDay('2026-10-08').filter((r) => r.type.startsWith('effect.')).map((r) => `${r.type}:${r.by ?? ''}`);
  assert.deepEqual(audit, ['effect.shown:', 'effect.closed:reload']);
});

test('morning review: decided by day.rollover (review day + notes waiting), shown until closed, done survives a restart', async (t) => {
  const dir = makeTmpDir('product-review');
  t.after(dir.cleanup);
  const thu = local(2026, 10, 8, 20, 0);
  const sun = local(2026, 10, 11, 4, 0, 30);
  const seed = (store: Store, clock: ReturnType<typeof fixedClock>) => {
    clock.set(thu);
    store.append({ type: 'note.created', noteId: 1, text: 'Sunday: retry logic', source: 'block' });
    store.append({ type: 'note.created', noteId: 2, text: 'done already', source: 'manager' });
    store.append({ type: 'note.dismissed', noteId: 2 });
  };
  const s = await setup(sun, { dir: dir.dir, seed });
  s.tracker.tick(s.clock.now());
  const roll = s.store.readDay('2026-10-11').filter((r) => r.type === 'day.rollover');
  assert.deepEqual(roll.map((r) => [r.fromDay, r.toDay, r.review]), [['2026-10-10', '2026-10-11', true]]);
  s.tracker.tick(s.clock.now());
  assert.equal(types(s.store, '2026-10-11').filter((x) => x === 'day.rollover').length, 1, 'once per day');
  const [open] = s.beat();
  assert.equal(open!.window.id, 'review');
  assert.equal(open!.window.intrusive, true);
  assert.equal(open!.window.focus, false, 'never steals focus');
  assert.deepEqual(s.model('review').notes.map((n: any) => n.id), [1], 'only waiting notes');
  assert.equal(s.action('review', 'edit', { id: 1, text: 'Sunday: retry logic, then tests' }).ok, true);
  // A Hammerspoon reload (not a dismissal) brings it back.
  s.beat({ windows: { review: open!.window.rev } });
  assert.equal(s.beat({ windows: {} })[0]?.window?.id, 'review');
  s.beat({ windows: { review: open!.window.rev } });
  // Closed by the owner: done for today, also for a restarted daemon.
  assert.deepEqual(s.beat({ closed: [{ id: 'review', by: 'user', at: 2 }] }), []);
  const again = await setup(sun + 3600_000, { dir: dir.dir });
  again.tracker.tick(again.clock.now());
  assert.deepEqual(again.beat(), []);
  // Home days now also review notes; the live gate still suppresses the window.
  const mon = await setup(local(2026, 10, 12, 9, 0), { dir: dir.dir });
  mon.tracker.tick(mon.clock.now());
  assert.equal(mon.store.readDay('2026-10-12').find((r) => r.type === 'day.rollover')!.review, true);
  assert.equal(mon.beat()[0]?.window?.id, 'review');
  const tue = await setup(local(2026, 10, 13, 9, 0), { dir: dir.dir, env: 'live' });
  tue.tracker.tick(tue.clock.now());
  assert.equal(tue.store.readDay('2026-10-13').find((r) => r.type === 'day.rollover')!.review, true);
  assert.deepEqual(tue.beat(), [], 'live gate closed');
});

test('morning review: no notes waiting → no review; the rollover is written on the first tick after 04:00', async (t) => {
  const s = await setup(local(2026, 10, 10, 23, 0)); // Saturday night
  t.after(s.cleanup);
  s.tracker.tick(s.clock.now());
  s.clock.set(local(2026, 10, 11, 4, 0, 5)); // Sunday
  s.tracker.tick(s.clock.now());
  const roll = s.store.readDay('2026-10-11').find((r) => r.type === 'day.rollover')!;
  assert.deepEqual([roll.fromDay, roll.toDay, roll.review], ['2026-10-10', '2026-10-11', false]);
  assert.deepEqual(s.beat(), []);
});

test('summary model: today, the week per day vs budgets, 4 weeks, recent reports', async (t) => {
  const T = local(2026, 10, 13, 12, 0); // Tuesday
  const s = await setup(T, {
    seed: (store, clock) => {
      // One hour of input on Sunday 4 Oct (two weeks back: history) and on Sunday 11 Oct (this week).
      for (const d of [4, 11]) {
        for (let i = 0; i < 60; i++) {
          const m = local(2026, 10, d, 10, i);
          clock.set(m + 60_000);
          store.append({ type: 'minute', provider: 'interactive', minute: m, data: { inputs: [[0, 0]], activeSeconds: 1, lastInputAt: m } });
        }
      }
      clock.set(local(2026, 10, 12, 9, 0));
      store.append({ ...report('2026-10-12 09:00', 3), stage: 'morning', status: ['Productive'] });
      store.append(report('2026-09-01 21:00', 2)); // older than 4 weeks: not in the summary
    },
  });
  t.after(s.cleanup);
  const m = s.model('summary');
  assert.equal(m.today.day, '2026-10-13');
  assert.equal(m.today.limitSeconds, 8.5 * 3600, 'Tuesday budget (only 1 h 4 min worked this week)');
  assert.equal(m.week.days.length, 7);
  assert.deepEqual(m.week.days.map((d: any) => d.weekday), ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  assert.equal(m.week.days[0].workedSeconds, 64 * 60, '60 inputs, 1/min, + 5 min grace − 1 = 64 min');
  assert.equal(m.week.days[0].budgetSeconds, 8.5 * 3600);
  assert.equal(m.week.days[1].budgetSeconds, 8 * 3600);
  assert.equal(m.week.days[1].referenceSeconds, null);
  assert.equal(m.week.days[3].workedSeconds, null, 'future day');
  assert.equal(m.week.budgetSeconds, 44 * 3600);
  assert.deepEqual(m.weeks.map((w: any) => [w.start, w.workedSeconds, w.current]), [
    ['2026-09-20', 0, false], ['2026-09-27', 0, false], ['2026-10-04', 64 * 60, false], ['2026-10-11', 64 * 60, true],
  ]);
  assert.deepEqual(m.reports.map((f: any) => [f.timestamp, f.stage, f.status, f.energy]), [['2026-10-12 09:00', 'morning', ['Productive'], 3]]);
});

test('review M8#2: a window closed before Lua ever reported it shown is still audited (review done survives a restart)', async (t) => {
  const dir = makeTmpDir('product-review-fast');
  t.after(dir.cleanup);
  const sun = local(2026, 10, 11, 9, 0);
  const seed = (store: Store, clock: ReturnType<typeof fixedClock>) => {
    clock.set(local(2026, 10, 8, 20, 0));
    store.append({ type: 'note.created', noteId: 1, text: 'x', source: 'block' });
  };
  const s = await setup(sun, { dir: dir.dir, seed });
  s.tracker.tick(s.clock.now());
  assert.equal(s.beat()[0]!.window.id, 'review');
  // Closed within the same beat: Lua's first report is the close.
  assert.deepEqual(s.beat({ closed: [{ id: 'review', by: 'page', at: 5 }] }), []);
  const audit = s.store.readDay('2026-10-11').filter((r) => r.type.startsWith('effect.')).map((r) => `${r.type}:${r.by ?? ''}`);
  assert.deepEqual(audit, ['effect.shown:', 'effect.closed:page']);
  const again = await setup(sun + 60_000, { dir: dir.dir });
  again.tracker.tick(again.clock.now());
  assert.deepEqual(again.beat(), []);
});

test('review M8#5: a menu click while the window is closing reopens it (by order); raise-then-close stays closed', async (t) => {
  const s = await setup(local(2026, 10, 8, 18, 0));
  t.after(s.cleanup);
  s.request('notes');
  const rev = s.beat()[0]!.window.rev;
  s.beat({ windows: { notes: rev } });
  // A click between the page's close and Lua's report reopens.
  s.action('notes', 'close');
  s.request('notes');
  const r = s.beat({ closed: [{ id: 'notes', by: 'page', at: 2 }] });
  assert.ok(r.some((c) => c.op === 'window.open'), 'reopened after a late click');
  s.beat({ windows: { notes: rev } });
  // Raise an open window, then close it on purpose at once: it stays closed.
  s.request('notes');
  s.beat({ windows: { notes: rev } });
  assert.deepEqual(s.beat({ closed: [{ id: 'notes', by: 'user', at: 3 }] }), []);
  assert.deepEqual(s.beat(), []);
});
