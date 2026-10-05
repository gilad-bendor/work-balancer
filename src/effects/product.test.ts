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
import { gateClosedPolicy } from '../testing/config.ts';
import { createEffectsManager } from './manager.ts';
import { DEFAULT_QUIET } from './reconcile.ts';
import type { ActualUi, UiCommand } from '../core/effects.ts';

type Cmd = UiCommand & Record<string, any>;

async function setup(start: number, opts: { env?: 'dev' | 'live'; dir?: string; seed?: (store: Store, clock: ReturnType<typeof fixedClock>) => void } = {}) {
  const tmp = opts.dir ? { dir: opts.dir, cleanup() {} } : makeTmpDir('product');
  const clock = fixedClock(start);
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  opts.seed?.(store, clock);
  clock.set(start);
  // Live-env tests are about the closed gate: the owner's policy with liveEffects false (whatever his file says).
  const configPath = opts.env === 'live' ? gateClosedPolicy(tmp.dir) : join(REPO_ROOT, 'config', 'policy.ts');
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

test('menu windows: a request opens a floating, focused, non-intrusive window — live gate or not; again = focus', async (t) => {
  const s = await setup(local(2026, 10, 5, 11, 0), { env: 'live' }); // live: liveEffects false
  t.after(s.cleanup);
  assert.deepEqual(s.beat(), []);
  assert.equal(s.request('quick').json.ok, true);
  assert.equal(s.request('review').status, 404, 'system effects cannot be requested');
  assert.equal(s.request('nope').status, 404);
  const [open] = s.beat();
  assert.equal(open!.op, 'window.open');
  assert.equal(open!.window.id, 'quick');
  assert.equal(open!.window.mode, 'floating');
  assert.equal(open!.window.focus, true);
  assert.equal(open!.window.intrusive, false);
  assert.equal(open!.window.closable, true);
  const shown = { quick: open!.window.rev };
  assert.deepEqual(s.beat({ windows: shown }), []);
  s.request('quick');
  const again = s.beat({ windows: shown });
  assert.deepEqual(again.map((c) => [c.op, c.windowId]), [['window.focus', 'quick']]);
  assert.deepEqual(s.beat({ windows: shown }), [], 'focus once');
  // The owner closes it (later than the 2 s reopen window): forgotten, audited.
  s.clock.advance(5000);
  assert.deepEqual(s.beat({ closed: [{ id: 'quick', by: 'user', at: 1 }] }), []);
  const day = s.store.readDay('2026-10-05').filter((r) => r.type.startsWith('effect.'));
  assert.deepEqual(day.map((r) => [r.type, r.windowId, r.by]), [['effect.shown', 'quick', undefined], ['effect.closed', 'quick', 'user']]);
  // Every menu item has a window.
  for (const id of ['summary', 'notes', 'quit']) {
    s.request(id);
    assert.ok(s.beat().some((c) => c.op === 'window.open' && c.window.id === id), id);
  }
});

test('quick note: context + feedback → two notes (source quick); saved parts reported; empty refused', async (t) => {
  const s = await setup(local(2026, 10, 8, 18, 0)); // Thursday
  t.after(s.cleanup);
  s.request('quick');
  s.beat();
  assert.deepEqual(s.model('quick').feedbackChoices.slice(0, 2), ['Too much work', 'Feeling tired']);
  assert.deepEqual(s.action('quick', 'submit', { context: '  ', feedback: { choices: [], text: '', energy: null } }), { ok: false, error: 'empty', context: 'none', feedback: 'none' });
  const r = s.action('quick', 'submit', { context: 'Sunday: retry logic first', feedback: { choices: ['Feeling tired', 'Made up'], text: 'long day', energy: 2 } });
  assert.deepEqual(r, { ok: true, context: 'saved', feedback: 'saved', closing: true });
  assert.deepEqual(s.action('quick', 'submit', { feedback: { choices: ['Productive'] } }), { ok: true, context: 'none', feedback: 'saved', closing: true });
  const notes = s.store.readDay('2026-10-08').filter((x) => x.type === 'note.created');
  assert.deepEqual(notes.map((n) => [n.kind, n.source]), [['context', 'quick'], ['feedback', 'quick'], ['feedback', 'quick']]);
  assert.deepEqual(notes[1]!.choices, ['Feeling tired']);
  assert.equal(notes[1]!.energy, 2);
  assert.deepEqual(s.action('quick', 'close'), { ok: true, close: true });
  assert.deepEqual(s.beat({ windows: { quick: 'r' } }).map((c) => [c.op, c.windowId]), [['window.close', 'quick']]);
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
  assert.deepEqual(s.action('notes', 'edit', { id: 'n-x', text: 'y' }), { ok: false, error: 'unknown' });
  assert.equal(s.model('notes').notes.length, 2);
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
    store.append({ type: 'note.created', noteId: 'n-1', kind: 'context', text: 'Sunday: retry logic', source: 'quick' });
    store.append({ type: 'note.created', noteId: 'n-2', kind: 'note', text: 'done already', source: 'manager' });
    store.append({ type: 'note.dismissed', noteId: 'n-2' });
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
  assert.deepEqual(s.model('review').notes.map((n: any) => n.id), ['n-1'], 'only waiting notes');
  assert.equal(s.action('review', 'edit', { id: 'n-1', text: 'Sunday: retry logic, then tests' }).ok, true);
  // A Hammerspoon reload (not a dismissal) brings it back.
  s.beat({ windows: { review: open!.window.rev } });
  assert.equal(s.beat({ windows: {} })[0]?.window?.id, 'review');
  s.beat({ windows: { review: open!.window.rev } });
  // Closed by the owner: done for today, also for a restarted daemon.
  assert.deepEqual(s.beat({ closed: [{ id: 'review', by: 'user', at: 2 }] }), []);
  const again = await setup(sun + 3600_000, { dir: dir.dir });
  again.tracker.tick(again.clock.now());
  assert.deepEqual(again.beat(), []);
  // Monday (no review day) and a live instance with the gate closed: nothing.
  const mon = await setup(local(2026, 10, 12, 9, 0), { dir: dir.dir });
  mon.tracker.tick(mon.clock.now());
  assert.equal(mon.store.readDay('2026-10-12').find((r) => r.type === 'day.rollover')!.review, false);
  assert.deepEqual(mon.beat(), []);
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

test('summary model: today, the week per day vs budgets, 4 weeks, recent feedback', async (t) => {
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
      store.append({ type: 'note.created', noteId: 'n-f', kind: 'feedback', text: 'ok', choices: ['Productive'], energy: 3, source: 'quick' });
    },
  });
  t.after(s.cleanup);
  const m = s.model('summary');
  assert.equal(m.today.day, '2026-10-13');
  assert.equal(m.today.limitSeconds, 9 * 3600 - 0, 'Tuesday budget (only 1 h 4 min worked this week)');
  assert.equal(m.week.days.length, 7);
  assert.deepEqual(m.week.days.map((d: any) => d.weekday), ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  assert.equal(m.week.days[0].workedSeconds, 64 * 60, '60 inputs, 1/min, + 5 min grace − 1 = 64 min');
  assert.equal(m.week.days[0].budgetSeconds, 9 * 3600);
  assert.equal(m.week.days[1].referenceSeconds, 9 * 3600);
  assert.equal(m.week.days[3].workedSeconds, null, 'future day');
  assert.equal(m.week.budgetSeconds, 44 * 3600);
  assert.deepEqual(m.weeks.map((w: any) => [w.start, w.workedSeconds, w.current]), [
    ['2026-09-20', 0, false], ['2026-09-27', 0, false], ['2026-10-04', 64 * 60, false], ['2026-10-11', 64 * 60, true],
  ]);
  assert.deepEqual(m.feedback.map((f: any) => [f.id, f.choices, f.energy]), [['n-f', ['Productive'], 3]]);
});

test('review M8#2: a window closed before Lua ever reported it shown is still audited (review done survives a restart)', async (t) => {
  const dir = makeTmpDir('product-review-fast');
  t.after(dir.cleanup);
  const sun = local(2026, 10, 11, 9, 0);
  const seed = (store: Store, clock: ReturnType<typeof fixedClock>) => {
    clock.set(local(2026, 10, 8, 20, 0));
    store.append({ type: 'note.created', noteId: 'n-1', kind: 'context', text: 'x', source: 'quick' });
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
  s.request('quick');
  const rev = s.beat()[0]!.window.rev;
  s.beat({ windows: { quick: rev } });
  // Saved → the page shows "Saved." and closes itself; the owner clicks "Quick note…" meanwhile.
  assert.equal(s.action('quick', 'submit', { context: 'x' }).ok, true);
  s.request('quick');
  s.action('quick', 'close');
  let r = s.beat({ closed: [{ id: 'quick', by: 'page', at: 1 }] });
  assert.ok(r.some((c) => c.op === 'window.open' && c.window.id === 'quick'), 'reopened after Saved');
  s.beat({ windows: { quick: rev } });
  // A click between the page's close and Lua's report also reopens.
  s.action('quick', 'close');
  s.request('quick');
  r = s.beat({ closed: [{ id: 'quick', by: 'page', at: 2 }] });
  assert.ok(r.some((c) => c.op === 'window.open'), 'reopened after a late click');
  s.beat({ windows: { quick: rev } });
  // Raise an open window, then close it on purpose at once: it stays closed.
  s.request('quick');
  s.beat({ windows: { quick: rev } });
  assert.deepEqual(s.beat({ closed: [{ id: 'quick', by: 'user', at: 3 }] }), []);
  assert.deepEqual(s.beat(), []);
});
