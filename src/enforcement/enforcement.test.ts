process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createTracker } from '../daemon/tracker.ts';
import { createStore, type Store } from '../store/store.ts';
import { createPolicyLoader } from '../policy/config.ts';
import { fixedClock } from '../core/clock.ts';
import { REPO_ROOT } from '../core/env.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';
import { gateClosedPolicy, testPolicy } from '../testing/config.ts';
import { createEffectsManager } from '../effects/manager.ts';
import { DEFAULT_QUIET } from '../effects/reconcile.ts';
import { createTestEffect } from '../effects/test-effect.ts';
import type { ActualUi, UiCommand } from '../core/effects.ts';
import { phraseKey, phraseMatches, tokenGroups } from './enforcement.ts';

const S = 1000;
const MIN = 60_000;
const PHRASE = 'I am choosing to borrow this time from my Friday and my family. I accept the cost, and I will stop as soon as I can.';
type Cmd = UiCommand & Record<string, any>;

/** One input instant per minute in [from, to) — continuous work (grace 5 min). */
function seedWork(store: Store, from: number, to: number): void {
  for (let m = from; m < to; m += MIN) store.append({ type: 'minute', provider: 'interactive', minute: m, data: { inputs: [[0, 0]], activeSeconds: 1, lastInputAt: m } });
}

async function setup(start: number, opts: { env?: 'dev' | 'live'; dir?: string; seed?: (store: Store) => void; quietInput?: boolean; writeError?: () => string | null; configPath?: string } = {}) {
  const tmp = opts.dir ? { dir: opts.dir, cleanup() {} } : makeTmpDir('enforcement');
  const clock = fixedClock(start);
  const real = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  opts.seed?.(real);
  const store: Store = { ...real, health: () => (opts.writeError?.() ? { ...real.health(), writeError: opts.writeError() } : real.health()) };
  clock.set(start);
  // Live-env tests are about the closed gate: the owner's policy with liveEffects false (whatever his file says).
  const configPath = opts.configPath ?? (opts.env === 'live' ? gateClosedPolicy(tmp.dir) : testPolicy(tmp.dir));
  const policy = createPolicyLoader({ path: configPath, snapshotPath: join(tmp.dir, 'snap.json'), log: silentLogger });
  await policy.refresh();
  const env = opts.env ?? 'dev';
  const effects = createEffectsManager({
    env, store, log: silentLogger, now: () => clock.now(),
    gateOpen: () => env === 'dev' || policy.state().config?.liveEffects === true,
    // `quietInput`: the owner is typing right now (R-UI-QUIET would defer anything new).
    lastInputAt: () => (opts.quietInput ? clock.now() : null), quiet: () => DEFAULT_QUIET,
  });
  const testEffect = createTestEffect({ env, now: () => clock.now(), config: () => policy.state().config });
  effects.register(testEffect.effect);
  const tracker = await createTracker({ store, clock, log: silentLogger, policy, startedAt: start, copilotHome: join(tmp.dir, 'none'), effects });
  const routes = [...effects.routes(), ...testEffect.routes];
  const call = (method: 'GET' | 'POST', path: string, body: unknown = null, query = '') =>
    routes.find((r) => r.method === method && r.path === path)!.handle({ body, query: new URLSearchParams(query), path }) as { status?: number; json: any };
  const action = (win: string, act: string, payload?: unknown) => call('POST', '/api/ui/action', { win, action: act, payload }).json;
  const model = (win: string) => call('GET', '/api/ui/model', null, `win=${win}`).json.model;
  const beat = (actual: Partial<ActualUi> = {}): Cmd[] =>
    effects.heartbeat({ actual: { windows: {}, dimmed: false, closed: [], ...actual }, acks: [], panic: false, now: clock.now() }) as Cmd[];
  let since = start;
  /** Advance in 30 s steps with an input every step (the owner keeps working), ticking like the daemon. */
  const work = (until: number, opts2: { idle?: boolean } = {}) => {
    while (clock.now() < until) {
      clock.set(Math.min(until, clock.now() + 30 * S));
      tracker.ingest({ inputs: opts2.idle ? [] : [clock.now()], apps: [], system: [], locked: false, since }, clock.now());
      since = clock.now();
      tracker.tick(clock.now());
    }
  };
  const ids = () => effects.desired(clock.now()).windows.map((w) => w.id).sort();
  const win = (id: string) => effects.desired(clock.now()).windows.find((w) => w.id === id);
  const records = (type: string) => real.readDays('2026-10-01', '2026-10-31').filter((r) => r.type === type);
  return { ...tmp, clock, store: real, tracker, effects, call, action, model, beat, work, ids, win, records };
}

test('phrase comparison ignores case, spacing and punctuation; token groups', () => {
  assert.equal(phraseMatches('i am choosing to borrow this time from my friday and my family i accept the cost and i will stop as soon as i can', PHRASE), true);
  assert.equal(phraseMatches('  I AM choosing… to borrow this time from my Friday & my family. I accept the cost, and I will stop as soon as I can!!', PHRASE), false, '& is not "and"');
  assert.equal(phraseMatches('I am choosing to borrow', PHRASE), false);
  assert.equal(phraseMatches('', ''), false, 'an empty phrase never matches');
  assert.equal(phraseKey(42), '');
  assert.deepEqual(tokenGroups([5, 10, 5]), [{ minutes: 10, left: 1 }, { minutes: 5, left: 2 }]);
});

test('daily report in block: today only, required energy, independent token/bypass exits, block retains priority', async (t) => {
  const dir = makeTmpDir('block-report');
  t.after(dir.cleanup);
  const now = local(2026, 10, 6, 17, 1);
  const s = await setup(now, {
    dir: dir.dir, configPath: testPolicy(dir.dir, { dailyReportsStartDay: '2026-10-05' }),
    seed: (store) => seedWork(store, local(2026, 10, 6, 8, 0), now),
  });
  s.tracker.tick(now);
  s.tracker.ingest({ since: now - 5000, inputs: [now], apps: [], system: [], locked: false }, now);
  assert.deepEqual(s.ids(), ['block'], 'work-budget block has priority over yesterday’s pending report');
  assert.equal(s.model('block').report.day, '2026-10-06');
  assert.equal(s.action('block', 'report-submit', { day: '2026-10-05', energy: 2 }).error, 'day');
  assert.equal(s.action('block', 'report-submit', { day: '2026-10-06' }).error, 'energy');
  assert.equal(s.action('block', 'token', { minutes: 10 }).close, true, 'pending report never prevents a token');
  s.clock.advance(11 * MIN);
  s.tracker.tick(s.clock.now());
  assert.ok(s.ids().includes('block'));
  assert.equal(s.action('block', 'report-submit', { day: '2026-10-06', energy: 3 }).ok, true);
  assert.ok(s.ids().includes('block'), 'answering does not release the budget block');
  assert.equal(s.model('block').report.status, 'answered');
  assert.equal(s.action('block', 'bypass', { phrase: PHRASE, reason: 'synthetic reason' }).close, true);
});

test('the full ladder on a Tuesday: nudge → warn + dim → countdown (pill, park) → block → token → bypass → restart → 04:00', async (t) => {
  const day = local(2026, 10, 6, 8, 30); // Tuesday, 8.5 h budget: orange 6:22:30, warn 8:00, countdown 8:20, block 8:30
  const s = await setup(local(2026, 10, 6, 16, 20), { seed: (st) => seedWork(st, day, local(2026, 10, 6, 16, 20)) });
  t.after(s.cleanup);

  // 7:50 worked: orange; a long stretch → the break nudge (and nothing else).
  s.work(local(2026, 10, 6, 16, 20, 30));
  assert.deepEqual(s.records('policy.transition').map((r) => r.to), ['orange']);
  assert.deepEqual(s.ids(), ['nudge']);
  assert.ok(s.model('nudge').stretchSeconds > 7.5 * 3600);
  assert.equal(s.action('nudge', 'snooze').close, true);
  s.beat({ closed: [{ id: 'nudge', by: 'page', at: s.clock.now() }] });
  assert.deepEqual(s.ids(), [], 'snoozed');

  // 8:00 → warn: the dialog + one dim pulse until the dialog is reported on screen.
  s.work(local(2026, 10, 6, 16, 30, 30));
  assert.deepEqual(s.records('policy.transition').map((r) => r.to), ['orange', 'warn']);
  const warnDims = s.effects.desired(s.clock.now()).dims;
  assert.equal(warnDims.length, 1);
  assert.match(warnDims[0]!.pulseId, /^warn-/);
  const w = s.win('warn')!;
  assert.equal(w.mode, 'floating');
  assert.equal(w.focus, false, 'never steals keystrokes');
  assert.equal(w.intrusive, true);
  assert.ok(Math.abs(s.model('warn').remainingSeconds - 29.5 * 60) <= 60);
  s.beat({ windows: { warn: w.rev } });
  assert.equal(s.effects.desired(s.clock.now()).dims.length, 0, 'one pulse per level entry');
  assert.equal(s.action('warn', 'close').close, true);
  s.beat({ closed: [{ id: 'warn', by: 'page', at: s.clock.now() }] });
  assert.equal(s.win('warn'), undefined, 'dismissed for this entry');
  s.work(local(2026, 10, 6, 16, 36));
  assert.deepEqual(s.ids(), ['nudge'], 'the snooze is over; the warn stays dismissed');

  // 8:20 → countdown: not dismissible; the pill; park the thought; the nudge is quiet now.
  s.work(local(2026, 10, 6, 16, 50, 30));
  assert.deepEqual(s.ids(), ['countdown']);
  const c = s.win('countdown')!;
  assert.equal(c.closable, false);
  assert.equal(c.focus, false);
  assert.equal(s.action('countdown', 'close').ok, false, 'no close');
  assert.ok(s.model('countdown').remainingSeconds <= 10 * 60);
  assert.equal(s.action('countdown', 'collapse').ok, true);
  assert.equal(s.win('countdown')!.path, '/ui/countdown.html?pill=1');
  assert.equal(s.win('countdown')!.placement, 'top-right');
  s.action('countdown', 'expand');
  assert.equal(s.win('countdown')!.path, '/ui/countdown.html');
  // An empty (or stray) Save forfeits nothing.
  assert.equal(s.action('countdown', 'save', { context: '  ', feedback: {} }).error, 'empty');
  assert.deepEqual(s.ids(), ['countdown']);
  // Save = done for today (owner, D-60): the rest of the budget is given up and the block follows at once.
  s.action('countdown', 'draft', { text: 'then fix the flaky test' });
  const saved = s.action('countdown', 'save', { context: '', feedback: { choices: ['Feeling tired'], text: '', energy: 2 } });
  assert.deepEqual([saved.ok, saved.context, saved.feedback, saved.forfeited], [true, 'none', 'saved', true]);
  assert.deepEqual(s.records('note.created').map((r) => [r.kind, r.source]), [['feedback', 'countdown']]);
  const forfeit = s.records('budget.forfeited');
  assert.equal(forfeit.length, 1);
  const rem = forfeit[0]!.remainingSeconds as number;
  assert.ok(rem > 8 * 60 && rem <= 10 * 60);
  assert.deepEqual(s.ids(), ['block'], 'blocked right after the save');
  s.work(local(2026, 10, 6, 16, 51));
  assert.equal(s.records('policy.transition').at(-1)!.to, 'blocked');
  s.work(local(2026, 10, 6, 17, 0, 30));
  assert.deepEqual(s.ids(), ['block']);
  const b = s.win('block')!;
  assert.deepEqual([b.mode, b.placement, b.perScreen, b.focus, b.closable, b.intrusive], ['overlay', 'full', true, true, false, true]);
  const m = s.model('block');
  assert.equal(m.draft, 'then fix the flaky test');
  assert.deepEqual(m.tokens, [{ minutes: 10, left: 1 }, { minutes: 5, left: 2 }]);
  assert.equal(m.bypass.phrase, PHRASE);
  assert.equal(m.limitSeconds, 8.5 * 3600);
  assert.equal(m.liftsAt, local(2026, 10, 7, 4, 0));
  assert.deepEqual(m.week.days.map((d: any) => d.weekday), ['sun', 'mon', 'tue']);
  assert.equal(s.action('block', 'close').ok, false, 'not dismissible');

  // A token: two-step on the page; here the action. Wrong sizes / used tokens are refused.
  assert.equal(s.action('block', 'token', { minutes: 7 }).error, 'unavailable');
  const tk = s.action('block', 'token', { minutes: 10 });
  assert.equal(tk.ok, true);
  assert.equal(tk.close, true);
  assert.equal(tk.until, s.clock.now() + 10 * MIN);
  assert.deepEqual(s.ids(), [], 'lifted for 10 min');
  assert.match(s.tracker.menubar(s.clock.now()).title, /⏳10m$/);
  assert.match(s.tracker.menubar(s.clock.now()).tooltip, /Borrowed time until/);
  assert.equal(s.action('block', 'token', { minutes: 10 }).error, 'unavailable', 'used');
  s.work(tk.until - 30 * S);
  assert.deepEqual(s.ids(), []);
  s.work(tk.until + 30 * S);
  assert.deepEqual(s.ids(), ['block'], 'back when the grant ends — no re-warning');
  assert.deepEqual(s.model('block').tokens, [{ minutes: 5, left: 2 }]);

  // The emergency bypass: the sentence (case/punctuation free) and a reason.
  assert.equal(s.action('block', 'bypass', { phrase: 'I am choosing', reason: 'prod is down' }).error, 'phrase');
  assert.equal(s.action('block', 'bypass', { phrase: PHRASE.toLowerCase(), reason: ' x ' }).error, 'reason');
  const bp = s.action('block', 'bypass', { phrase: PHRASE.toLowerCase().replace(/[.,]/g, ''), reason: 'prod is down' });
  assert.equal(bp.ok, true);
  assert.equal(bp.until, s.clock.now() + 30 * MIN);
  assert.deepEqual(s.records('bypass.used').map((r) => [r.minutes, r.reason]), [[30, 'prod is down']]);
  assert.deepEqual(s.records('token.used').map((r) => r.minutes), [10]);
  assert.equal(s.model('block').bypass.usedToday, 1);
  s.work(bp.until + 30 * S);
  assert.deepEqual(s.ids(), ['block']);
  // The block was on screen (Lua reported it); a daemon restart — the owner typing — re-shows it without deferral.
  s.beat({ windows: { block: s.win('block')!.rev } });

  const r = await setup(s.clock.now(), { dir: s.dir, quietInput: true });
  assert.deepEqual(r.ids(), ['block'], 'recomputed from data');
  const cmds = r.beat({ closed: [{ id: 'block', by: 'failopen', at: r.clock.now() - 2 * S }] });
  assert.deepEqual(cmds.map((x) => [x.op, x.window?.id]), [['window.open', 'block']], 'not deferred by R-UI-QUIET after a restart');
  assert.equal(r.model('block').tokens.length, 1);

  // 04:00: Wednesday's home budget is fresh; yesterday's saved feedback appears in review.
  r.work(local(2026, 10, 7, 4, 0, 30), { idle: true });
  assert.deepEqual(r.ids(), ['review']);
});

test('zero limit (week used up): blocked at the first worked second only, with the explanation flag', async (t) => {
  const s = await setup(local(2026, 10, 8, 9, 0), {
    seed: (st) => {
      for (const d of [4, 5, 6, 7]) seedWork(st, local(2026, 10, d, 8, 0), local(2026, 10, d, 19, 5)); // 4 × 11:05 > 44 h
    },
  });
  t.after(s.cleanup);
  s.work(local(2026, 10, 8, 9, 10), { idle: true });
  assert.deepEqual(s.ids(), [], 'nobody is blocked while asleep');
  s.work(local(2026, 10, 8, 9, 10, 30));
  assert.deepEqual(s.ids(), [], 'an input at this very instant has not worked a second yet');
  s.work(local(2026, 10, 8, 9, 11));
  assert.deepEqual(s.ids(), ['block'], 'the first worked second');
  const m = s.model('block');
  assert.equal(m.zeroLimit, true);
  assert.equal(m.limitSeconds, 0);
  assert.deepEqual(m.tokens, [{ minutes: 10, left: 1 }, { minutes: 5, left: 2 }]);
});

test('nothing on the live instance with the gate closed, on Saturday, or while data cannot be written', async (t) => {
  const seed = (st: Store) => seedWork(st, local(2026, 10, 6, 7, 0), local(2026, 10, 6, 16, 10));
  const live = await setup(local(2026, 10, 6, 16, 10), { env: 'live', seed });
  t.after(live.cleanup);
  live.work(local(2026, 10, 6, 16, 11));
  assert.equal(live.records('policy.transition').at(-1)!.to, 'blocked', 'the ladder runs (and is logged) …');
  assert.deepEqual(live.ids(), [], '… but nothing is shown live until liveEffects');
  assert.match(live.tracker.menubar(live.clock.now()).tooltip, /Observe mode/);

  let err: string | null = null;
  const broken = await setup(local(2026, 10, 6, 16, 10), { seed, writeError: () => err });
  t.after(broken.cleanup);
  broken.work(local(2026, 10, 6, 16, 11));
  assert.deepEqual(broken.ids(), ['block']);
  err = 'EACCES';
  assert.deepEqual(broken.ids(), [], 'fail open');
  err = null;

  const sat = await setup(local(2026, 10, 10, 18, 0), { seed: (st) => seedWork(st, local(2026, 10, 10, 6, 0), local(2026, 10, 10, 18, 0)) });
  t.after(sat.cleanup);
  sat.work(local(2026, 10, 10, 18, 5));
  assert.deepEqual(sat.ids(), [], 'Shabbat: no nudge, nothing');
});

test('break nudge: 90 min of continuous work; "taking a break" = quiet for the stretch; a real break starts over', async (t) => {
  const T = local(2026, 10, 6, 9, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.work(T + 89 * MIN);
  assert.deepEqual(s.ids(), []);
  s.work(T + 91 * MIN);
  assert.deepEqual(s.ids(), ['nudge']);
  assert.equal(s.action('nudge', 'break').close, true);
  s.beat({ closed: [{ id: 'nudge', by: 'page', at: s.clock.now() }] });
  s.work(T + 130 * MIN);
  assert.deepEqual(s.ids(), [], 'quiet for this stretch (he kept working — his call)');
  s.work(T + 145 * MIN, { idle: true }); // a real break (> 5 min without input) — the inactivity dialog asks about it
  assert.deepEqual(s.ids(), ['inactivity']);
  const gapId = s.model('inactivity').gaps[0].gapId;
  assert.equal(s.action('inactivity', 'resolve', { gapId, choice: 'back' }).ok, true);
  s.work(T + 145 * MIN + 91 * MIN);
  assert.deepEqual(s.ids(), ['nudge'], 'a new stretch');
  // Dismissed with ✕ (by user) = snooze: back after 15 min.
  s.beat({ closed: [{ id: 'nudge', by: 'user', at: s.clock.now() }] });
  s.work(s.clock.now() + 14 * MIN);
  assert.deepEqual(s.ids(), []);
  s.work(s.clock.now() + 2 * MIN);
  assert.deepEqual(s.ids(), ['nudge']);
});

test('trial pages: the real block over synthetic numbers; nothing reaches data/; live needs consent', async (t) => {
  const s = await setup(local(2026, 10, 5, 11, 0));
  t.after(s.cleanup);
  const before = s.store.readDay('2026-10-05').length;
  const open = s.call('POST', '/api/test/window', { page: 'block' }).json;
  assert.equal(open.ok, true);
  const w = s.effects.desired(s.clock.now()).windows.find((x) => x.id === open.id)!;
  assert.deepEqual([w.path, w.mode, w.perScreen], ['/ui/block.html', 'overlay', true]);
  const m = s.model(open.id);
  assert.deepEqual(m.tokens, [{ minutes: 10, left: 1 }, { minutes: 5, left: 2 }]);
  assert.equal(m.bypass.phrase, PHRASE);
  assert.equal(s.action(open.id, 'save', { context: 'trial text', feedback: {} }).context, 'saved');
  assert.equal(s.action(open.id, 'bypass', { phrase: 'nope', reason: 'abc' }).error, 'phrase');
  assert.equal(s.action(open.id, 'token', { minutes: 10 }).close, true);
  const z = s.call('POST', '/api/test/window', { page: 'block', zeroLimit: true }).json;
  assert.equal(s.model(z.id).zeroLimit, true);
  const cd = s.call('POST', '/api/test/window', { page: 'countdown' }).json;
  s.action(cd.id, 'collapse');
  assert.equal(s.effects.desired(s.clock.now()).windows.find((x) => x.id === cd.id)!.path, '/ui/countdown.html?pill=1');
  assert.equal(s.call('POST', '/api/test/window', { page: 'nope' }).status, 400);
  assert.equal(s.store.readDay('2026-10-05').length, before, 'nothing recorded');
  assert.equal(s.records('note.created').length, 0);

  const live = await setup(local(2026, 10, 5, 11, 0), { env: 'live' });
  t.after(live.cleanup);
  assert.equal(live.call('POST', '/api/test/window', { page: 'block' }).status, 403);
  assert.equal(live.call('POST', '/api/test/window', { page: 'block', live: true }).json.ok, true);
});

test('review M10: block back at once after a grant (no R-UI-QUIET); dismissals kept in memory; no Quit while blocked', async (t) => {
  const T = local(2026, 10, 6, 17, 30);
  const s = await setup(T, {
    quietInput: true, // the owner is typing all the time
    seed: (st) => {
      seedWork(st, local(2026, 10, 6, 7, 0), local(2026, 10, 6, 16, 10));
      st.append({ type: 'token.used', minutes: 5, until: local(2026, 10, 6, 17, 20) }); // an expired grant (ts = seeding clock 17:30)
    },
  });
  t.after(s.cleanup);
  s.work(T + 30 * S);
  assert.equal(s.win('block')?.immediate, true);
  assert.deepEqual(s.beat().map((c) => [c.op, c.window?.id]), [['window.open', 'block']], 'not deferred while typing');
  // No Quit at countdown/blocked (also during a grant, when the menubar is reachable).
  assert.ok(!s.tracker.menubar(s.clock.now()).menu?.some((m) => m.id === 'quit'));
  assert.equal(s.model('quit').allowed, false);
  assert.equal(s.action('quit', 'confirm').error, 'enforcing');

  const w = await setup(local(2026, 10, 6, 16, 31), { seed: (st) => seedWork(st, local(2026, 10, 6, 8, 30), local(2026, 10, 6, 16, 31)) });
  t.after(w.cleanup);
  w.work(local(2026, 10, 6, 16, 31, 30));
  assert.ok(w.win('warn'));
  assert.ok(w.tracker.menubar(w.clock.now()).menu?.some((m) => m.id === 'quit'), 'Quit stays at warn');
  w.action('warn', 'close');
  assert.equal(w.win('warn'), undefined, 'dismissed even before (or without) the effect.closed record');
});

test('M11: the Mac sleeps through 04:00 while blocked — on wake a new day: no block, one rollover, no monitor gap', async (t) => {
  const s = await setup(local(2026, 10, 6, 17, 0), { seed: (st) => seedWork(st, local(2026, 10, 6, 8, 0), local(2026, 10, 6, 17, 0)) });
  t.after(s.cleanup);
  s.work(local(2026, 10, 6, 17, 1));
  assert.deepEqual(s.ids(), ['block']);
  // Asleep 23:00 → Wed 08:00 (Lua's wake heartbeat carries both events, then normal beats resume).
  s.tracker.ingest({ inputs: [], apps: [], system: [{ event: 'sleep', at: local(2026, 10, 6, 23, 0) }], locked: false, since: s.clock.now() }, local(2026, 10, 6, 23, 0));
  s.clock.set(local(2026, 10, 7, 8, 0));
  s.tracker.ingest({ inputs: [], apps: [], system: [{ event: 'wake', at: local(2026, 10, 7, 8, 0) }], locked: false, since: local(2026, 10, 6, 23, 0) }, s.clock.now());
  s.tracker.tick(s.clock.now());
  assert.deepEqual(s.ids(), [], 'Wednesday: nothing');
  assert.equal(s.store.readDay('2026-10-07').filter((r) => r.type === 'day.rollover').length, 1);
  assert.equal(s.records('monitor.gap').length, 0, 'a sleep is not a gap');
});

test('M11: DST spring-forward Thursday (a 23 h day) — blocked until the real 04:00, a token is clipped to it', async (t) => {
  // 2026-03-27 02:00 → 03:00 (Friday morning): day 2026-03-26 ends at Fri 04:00, 23 h after it began.
  const s = await setup(local(2026, 3, 26, 17, 5), { seed: (st) => seedWork(st, local(2026, 3, 26, 8, 0), local(2026, 3, 26, 17, 5)) });
  t.after(s.cleanup);
  s.work(local(2026, 3, 26, 17, 6));
  assert.deepEqual(s.ids(), ['block']);
  s.clock.set(local(2026, 3, 27, 3, 55));
  s.tracker.tick(s.clock.now());
  assert.deepEqual(s.ids(), ['block'], 'after the jump, still the same day');
  assert.equal(s.model('block').liftsAt, local(2026, 3, 27, 4, 0));
  const tk = s.action('block', 'token', { minutes: 10 });
  assert.equal(tk.until, local(2026, 3, 27, 4, 0), 'clipped to the day end (unclipped: 04:05)');
  s.clock.set(local(2026, 3, 27, 4, 0, 30));
  s.tracker.tick(s.clock.now());
  assert.deepEqual(s.ids(), [], 'Friday: nothing');
});

test('M11: cold start with a broken policy and no snapshot — tracking only: nothing enforced, the menubar says so', async (t) => {
  const tmp = makeTmpDir('enforcement-cfg');
  t.after(tmp.cleanup);
  const bad = join(tmp.dir, 'policy.ts');
  writeFileSync(bad, 'export default { this is not valid');
  const s = await setup(local(2026, 10, 6, 17, 5), { configPath: bad, seed: (st) => seedWork(st, local(2026, 10, 6, 7, 0), local(2026, 10, 6, 17, 5)) });
  t.after(s.cleanup);
  s.work(local(2026, 10, 6, 17, 6));
  assert.deepEqual(s.ids(), []);
  assert.match(s.tracker.menubar(s.clock.now()).tooltip, /tracking only/);
  assert.equal(s.records('policy.transition').length, 0);
  assert.equal(s.model('quit').allowed, true, 'Quit stays possible');
});
