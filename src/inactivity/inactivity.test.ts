process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createTracker } from '../daemon/tracker.ts';
import { createStore } from '../store/store.ts';
import { createPolicyLoader } from '../policy/config.ts';
import { fixedClock } from '../core/clock.ts';
import { REPO_ROOT } from '../core/env.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';
import { createEffectsManager } from '../effects/manager.ts';
import { DEFAULT_QUIET } from '../effects/reconcile.ts';
import type { SensorSamples } from '../bridge/protocol.ts';
import { creditedMinutesFor, creditOf, PREWARN_WAIT_MS } from './inactivity.ts';
import { testPolicy } from '../testing/config.ts';

const S = 1000;
const MIN = 60_000;

async function setup(start: number, opts: { env?: 'dev' | 'live'; dir?: string } = {}) {
  const tmp = opts.dir ? { dir: opts.dir, cleanup() {} } : makeTmpDir('inactivity');
  const clock = fixedClock(start);
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  const policy = createPolicyLoader({ path: testPolicy(tmp.dir), snapshotPath: join(tmp.dir, 'snap.json'), log: silentLogger });
  await policy.refresh();
  const env = opts.env ?? 'dev';
  const effects = createEffectsManager({
    env, store, log: silentLogger, now: () => clock.now(), gateOpen: () => env === 'dev', lastInputAt: () => null, quiet: () => DEFAULT_QUIET,
  });
  const tracker = await createTracker({ store, clock, log: silentLogger, policy, startedAt: start, copilotHome: join(tmp.dir, 'none'), effects });
  let since = start;
  const feed = (o: Partial<SensorSamples>) => {
    tracker.ingest({ inputs: [], apps: [], system: [], locked: false, since, ...o }, clock.now());
    since = clock.now();
  };
  /** Advance the clock in 5 s heartbeat steps, ticking; `inputs` are instants delivered when their time has come. */
  const run = (until: number, inputs: number[] = []) => {
    const pending = [...inputs].sort((a, b) => a - b);
    while (clock.now() < until) {
      clock.set(Math.min(until, clock.now() + 5 * S));
      const due: number[] = [];
      while (pending.length && pending[0]! <= clock.now()) due.push(pending.shift()!);
      feed({ inputs: due });
      tracker.tick(clock.now());
    }
  };
  const desired = () => effects.desired(clock.now());
  const action = (act: string, payload?: unknown) =>
    effects.routes().find((r) => r.path === '/api/ui/action')!.handle({ body: { win: 'inactivity', action: act, payload }, query: new URLSearchParams(), path: '' }) as { json: any };
  const model = () => (effects.routes().find((r) => r.path === '/api/ui/model')!.handle({ body: null, query: new URLSearchParams('win=inactivity'), path: '' }) as { json: any }).json.model;
  const records = (type: string) => store.readDays('2026-10-01', '2026-10-31').filter((r) => r.type === type);
  return { ...tmp, clock, store, tracker, effects, feed, run, desired, action, model, records };
}

test('credit arithmetic: whole = the gap, some = N min from its start (clamped), back/expired = nothing', () => {
  assert.equal(creditedMinutesFor('whole', 0, 30 * MIN), 30);
  assert.equal(creditedMinutesFor('some', 0, 30 * MIN, 12.4), 12);
  assert.equal(creditedMinutesFor('some', 0, 30 * MIN, 99), 30);
  assert.equal(creditedMinutesFor('some', 0, 30 * MIN, -3), 0);
  assert.equal(creditedMinutesFor('some', 0, 30 * MIN, 'x'), 0);
  assert.equal(creditedMinutesFor('back', 0, 30 * MIN), 0);
  assert.deepEqual(creditOf({ from: 100, to: 100 + 30 * MIN, creditedMinutes: 12 }), [100, 100 + 12 * MIN]);
  assert.equal(creditOf({ from: 100, to: 200, creditedMinutes: 0 }), null);
  assert.deepEqual(creditOf({ from: 0, to: 10 * MIN, creditedMinutes: 20 }), [0, 10 * MIN], 'never beyond the gap');
});

test('pre-warning dim at 5 min idle; input during it cancels (no gap); otherwise a gap and the corner window', async (t) => {
  const T = local(2026, 10, 6, 10, 0); // Tuesday
  const s = await setup(T);
  t.after(s.cleanup);
  s.run(T + 10 * S, [T + 5 * S]);
  s.run(T + 5 * S + 5 * MIN + 2 * S);
  const dims = s.desired().dims;
  assert.equal(dims.length, 1);
  assert.equal(dims[0]!.pulseId, `inact-${T + 5 * S}`);
  assert.equal(dims[0]!.cancelOnInput, true);
  assert.equal(dims[0]!.seconds, 10);
  // The owner was reading: he moves the mouse during the dim.
  s.run(T + 5 * S + 5 * MIN + 12 * S, [T + 5 * S + 5 * MIN + 8 * S]);
  s.run(T + 5 * S + 5 * MIN + 60 * S);
  assert.equal(s.records('inactivity.detected').length, 0);
  assert.deepEqual(s.desired().windows, []);
  // Now really away: no input after the next pre-warning.
  const last = T + 5 * S + 5 * MIN + 8 * S;
  s.run(last + 5 * MIN + PREWARN_WAIT_MS + 10 * S);
  assert.deepEqual(s.records('inactivity.detected').map((r) => [r.gapId, r.lastInputAt]), [[`g-${last}`, last]]);
  const w = s.desired().windows[0]!;
  assert.equal(w.id, 'inactivity');
  assert.equal(w.mode, 'overlay', 'full screen, un-escapable (D-56)');
  assert.equal(w.placement, 'full');
  assert.equal(w.perScreen, true);
  assert.equal(w.closable, false);
  assert.equal(w.intrusive, true);
  assert.equal(s.desired().dims.length, 0);
  const m = s.model();
  assert.equal(m.gaps.length, 1);
  assert.equal(m.gaps[0].to, null, 'still away');
});

test('late detection (after a sleep / restart): no pre-warning, the gap is recorded at once', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.run(T + 10 * S, [T + 5 * S]);
  s.clock.set(T + 40 * MIN); // the Mac slept; Lua's wake heartbeat, then the first tick 40 min later
  s.feed({ system: [{ event: 'sleep', at: T + 10 * MIN }, { event: 'wake', at: T + 40 * MIN }] });
  s.tracker.tick(s.clock.now());
  assert.equal(s.records('inactivity.detected').length, 1);
  assert.equal(s.desired().dims.length, 0);
});

test('resolutions: whole credits the gap incl. locked time; some N; back nothing; no close action; later replaces earlier', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  const day = '2026-10-06';
  s.run(T + 10 * S, [T + 5 * S]);
  s.feed({ system: [{ event: 'lock', at: T + 6 * MIN }] });
  s.run(T + 30 * MIN);
  s.feed({ system: [{ event: 'unlock', at: T + 30 * MIN }] });
  s.run(T + 31 * MIN, [T + 30 * MIN + 10 * S]);
  const before = s.tracker.status(s.clock.now()) as any;
  const gap = s.model().gaps[0];
  assert.equal(gap.to, T + 30 * MIN + 10 * S, 'gap ends at the first input after it');
  assert.equal(gap.maxMinutes, 30);
  const r = s.action('resolve', { gapId: gap.gapId, choice: 'whole' }).json;
  assert.deepEqual(r, { ok: true, close: true, left: 0 });
  const after = s.tracker.status(s.clock.now()) as any;
  // Default: [T+5s, T+5min+5s) busy, locked from T+6min; whole: the full gap counts, including the locked 24 min.
  assert.equal(Math.round(after.workedSeconds - before.workedSeconds), Math.round((T + 30 * MIN + 10 * S - (T + 5 * S + 5 * MIN)) / S));
  const res = s.records('inactivity.resolved');
  assert.deepEqual(res.map((x) => [x.choice, x.from, x.to]), [['whole', T + 5 * S, T + 30 * MIN + 10 * S]]);
  assert.equal(s.store.filePath(day).endsWith(`${day}.jsonl`), true);
  // A later resolution of the same gap (another record) replaces the earlier one.
  s.store.append({ type: 'inactivity.resolved', gapId: gap.gapId, from: res[0]!.from, to: res[0]!.to, choice: 'some', creditedMinutes: 10 });
  s.tracker.flush(s.clock.now()); // a graceful restart writes the current minutes
  const again = await setup(s.clock.now(), { dir: s.dir });
  const replaced = again.tracker.status(again.clock.now()) as any;
  assert.equal(Math.round(replaced.workedSeconds), Math.round(before.workedSeconds + (10 * MIN - 5 * MIN) / S), 'some 10 min: 5 more than the default 5');
  // A second gap, answered with Esc (= back) and a bogus action.
  again.run(again.clock.now() + 7 * MIN);
  again.run(again.clock.now() + PREWARN_WAIT_MS + 10 * S);
  assert.equal(again.model().gaps.length, 1);
  assert.equal(again.action('resolve', { gapId: 'g-0', choice: 'whole' }).json.error, 'unknown');
  assert.equal(again.action('resolve', { gapId: again.model().gaps[0].gapId, choice: 'expired' }).json.error, 'invalid');
  assert.equal(again.action('close').json.ok, false, 'no way out but answering (D-56)');
  assert.equal(again.action('resolve', { gapId: again.model().gaps[0].gapId, choice: 'back' }).json.close, true);
  assert.equal(again.records('inactivity.resolved').at(-1)!.choice, 'back');
  assert.deepEqual(again.desired().windows, []);
});

test('a gap is clipped to its day and expires at 04:00 (default rule); detection survives a restart', async (t) => {
  const thu = local(2026, 10, 9, 2, 0); // Friday 02:00 = Thursday's day (enforcing, dialog on)
  const s = await setup(thu);
  t.after(s.cleanup);
  s.run(thu + 10 * S, [thu + 5 * S]);
  s.run(thu + 6 * MIN + PREWARN_WAIT_MS);
  assert.equal(s.records('inactivity.detected').length, 1);
  const restarted = await setup(s.clock.now() + MIN, { dir: s.dir });
  assert.equal(restarted.desired().windows[0]?.id, 'inactivity', 'restored from the records');
  restarted.clock.set(local(2026, 10, 9, 4, 0, 5)); // Friday's day: no dialog
  restarted.tracker.tick(restarted.clock.now());
  const res = restarted.records('inactivity.resolved');
  assert.deepEqual(res.map((r) => [r.choice, r.to, r.creditedMinutes]), [['expired', local(2026, 10, 9, 4, 0), 0]]);
  assert.ok(restarted.store.readDay('2026-10-08').some((r) => r.type === 'inactivity.resolved'), 'filed under the gap\'s day');
  assert.deepEqual(restarted.desired().windows, []);
});

test('only Sun/Tue/Thu (D-35), never Saturday, never with the live gate closed', async (t) => {
  for (const [start, env] of [[local(2026, 10, 5, 10, 0), 'dev'], [local(2026, 10, 10, 10, 0), 'dev'], [local(2026, 10, 6, 10, 0), 'live']] as const) {
    const s = await setup(start, { env });
    t.after(s.cleanup);
    s.run(start + 10 * S, [start + 5 * S]);
    s.run(start + 20 * MIN);
    assert.equal(s.records('inactivity.detected').length, 0, `${new Date(start).toDateString()} ${env}`);
    assert.deepEqual(s.desired(), { windows: [], dims: [] });
  }
});

test('D-56: with the dialog on screen, input does not end the gap; it ends at Submit; dialog fiddling is not work; one gap only', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.run(T + 10 * S, [T + 5 * S]);
  s.run(T + 6 * MIN + PREWARN_WAIT_MS);
  const w = s.desired().windows[0]!;
  // Lua shows it (audit: effect.shown), then the owner comes back and moves the mouse over the dialog for 3 minutes.
  s.effects.heartbeat({ actual: { windows: { inactivity: w.rev }, dimmed: false, closed: [] }, acks: [], panic: false, now: s.clock.now() });
  const shownAt = s.clock.now();
  const fiddle = Array.from({ length: 36 }, (_, i) => shownAt + 30 * S + i * 5 * S);
  s.run(shownAt + 4 * MIN, fiddle);
  const m = s.model();
  assert.equal(m.gaps.length, 1);
  assert.equal(m.gaps[0].to, null, 'still growing: input over the dialog is ignored');
  assert.equal(s.records('inactivity.detected').length, 1, 'no second gap while one is open');
  const before = (s.tracker.status(s.clock.now()) as any).workedSeconds;
  assert.equal(Math.round(before), 5 * 60, 'only the default 5 min after the last input: the fiddling is not work');
  const r = s.action('resolve', { gapId: m.gaps[0].gapId, choice: 'some', minutes: 7 }).json;
  assert.equal(r.ok, true);
  const res = s.records('inactivity.resolved').at(-1)!;
  assert.equal(res.to, s.clock.now(), 'the gap ends at Submit');
  assert.equal(res.creditedMinutes, 7);
  assert.equal(Math.round((s.tracker.status(s.clock.now()) as any).workedSeconds), 7 * 60);
  // Back to normal afterwards: input counts again, and a later absence is a new gap.
  s.effects.heartbeat({ actual: { windows: {}, dimmed: false, closed: [{ id: 'inactivity', by: 'system', at: s.clock.now() }] }, acks: [], panic: false, now: s.clock.now() });
  const back = s.clock.now() + 10 * S;
  s.run(back + 20 * S, [back]);
  assert.ok((s.tracker.status(s.clock.now()) as any).workedSeconds > 7 * 60);
  s.run(back + 6 * MIN + PREWARN_WAIT_MS);
  assert.equal(s.records('inactivity.detected').length, 2);
});

test('the dialog suppressed (panic): the next input ends the gap as before', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.run(T + 10 * S, [T + 5 * S]);
  s.run(T + 6 * MIN + PREWARN_WAIT_MS);
  const w = s.desired().windows[0]!;
  s.effects.heartbeat({ actual: { windows: { inactivity: w.rev }, dimmed: false, closed: [] }, acks: [], panic: false, now: s.clock.now() });
  s.run(s.clock.now() + MIN);
  s.effects.heartbeat({ actual: { windows: {}, dimmed: false, closed: [{ id: 'inactivity', by: 'panic', at: s.clock.now() }] }, acks: [], panic: true, now: s.clock.now() });
  const input = s.clock.now() + 30 * S;
  s.run(input + 10 * S, [input]);
  assert.equal(s.model().gaps[0].to, input);
});

test('review M9#1: Hammerspoon silent → no detection; a dialog period ends where the sensors stopped', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.run(T + 10 * S, [T + 5 * S]);
  // A: no heartbeats for 20 min (ejected): nothing detected.
  s.clock.set(T + 20 * MIN);
  s.tracker.tick(s.clock.now());
  assert.equal(s.records('inactivity.detected').length, 0);
  // B: the dialog is up, then Lua is ejected (no close record); later Lua is back and the owner works.
  s.feed({});
  s.run(s.clock.now() + PREWARN_WAIT_MS + 10 * S);
  assert.equal(s.records('inactivity.detected').length, 1);
  const w = s.desired().windows[0]!;
  s.effects.heartbeat({ actual: { windows: { inactivity: w.rev }, dimmed: false, closed: [] }, acks: [], panic: false, now: s.clock.now() });
  s.run(s.clock.now() + 10 * S);
  const ejectedAt = s.clock.now();
  s.clock.set(ejectedAt + 30 * MIN); // Hammerspoon relaunched 30 min later (coverage restarts here); he types at once
  s.feed({ since: s.clock.now() });
  const back = s.clock.now() + 2 * S;
  s.run(back + 10 * S, [back]);
  assert.equal(s.model().gaps[0].to, back, 'his first input after the silence ends the gap');
});

test('review M9#2: a resolve that cannot be written still closes the dialog (in memory), and is retried', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.run(T + 10 * S, [T + 5 * S]);
  s.run(T + 6 * MIN + PREWARN_WAIT_MS);
  const gapId = s.model().gaps[0].gapId;
  const { chmodSync } = await import('node:fs');
  const file = s.store.filePath('2026-10-06');
  chmodSync(file, 0o444);
  try {
    const r = s.action('resolve', { gapId, choice: 'whole' }).json;
    assert.equal(r.ok, true);
    assert.equal(r.close, true);
    assert.deepEqual(s.desired().windows, [], 'fail open');
    assert.equal(s.records('inactivity.resolved').length, 0);
  } finally {
    chmodSync(file, 0o644);
  }
  s.tracker.tick(s.clock.now());
  assert.deepEqual(s.records('inactivity.resolved').map((r) => r.choice), ['whole'], 'retried once writable');
  s.tracker.tick(s.clock.now());
  assert.equal(s.records('inactivity.resolved').length, 1);
});

test('review M9#3: nothing is detected while panicking', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.effects.heartbeat({ actual: { windows: {}, dimmed: false, closed: [] }, acks: [], panic: true, now: s.clock.now() });
  s.run(T + 10 * S, [T + 5 * S]);
  s.run(T + 20 * MIN);
  assert.equal(s.records('inactivity.detected').length, 0);
  assert.deepEqual(s.desired().dims, []);
});

test('review M9b#1: lid closed for a meeting; the wake heartbeat already carries his key press → the gap is still asked about', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.run(T + 10 * S, [T + 5 * S]);
  // Sleep at 10:00:10; the daemon is suspended too. Wake at 10:40 by a key press, delivered in the wake push.
  const wake = T + 40 * MIN;
  s.clock.set(wake + 2 * S);
  s.feed({ inputs: [wake + 1 * S], system: [{ event: 'sleep', at: T + 10 * S }, { event: 'wake', at: wake }] });
  s.tracker.tick(s.clock.now());
  assert.deepEqual(s.records('inactivity.detected').map((r) => r.lastInputAt), [T + 5 * S]);
  assert.equal(s.model().gaps[0].to, wake + 1 * S, 'ended by his return');
  // A short absence (prewarn-cancel range) is not dug up; neither is one across a Hammerspoon outage.
  assert.equal(s.action('resolve', { gapId: s.model().gaps[0].gapId, choice: 'whole' }).json.ok, true);
  const t2 = s.clock.now();
  s.run(t2 + 5 * MIN + 20 * S, [t2 + 1 * S, t2 + 5 * MIN + 15 * S]);
  assert.equal(s.records('inactivity.detected').length, 1);
});

test('review M9c: no retro gap for a break behind the live gate / a block; a prompt inside the last run is not a second gap', async (t) => {
  const T = local(2026, 10, 6, 10, 0);
  // Gate closed during a lid-closed break, opened right after the return: nothing is dug up.
  let gate = false;
  const tmp = makeTmpDir('inactivity-gate');
  t.after(tmp.cleanup);
  const clock = fixedClock(T);
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  const policy = createPolicyLoader({ path: join(REPO_ROOT, 'config', 'policy.ts'), snapshotPath: join(tmp.dir, 'snap.json'), log: silentLogger });
  await policy.refresh();
  const effects = createEffectsManager({ env: 'live', store, log: silentLogger, now: () => clock.now(), gateOpen: () => gate, lastInputAt: () => null, quiet: () => DEFAULT_QUIET });
  const tracker = await createTracker({ store, clock, log: silentLogger, policy, startedAt: T, copilotHome: join(tmp.dir, 'none'), effects });
  tracker.ingest({ inputs: [T + 5 * S], apps: [], system: [], locked: false, since: T }, T + 10 * S);
  clock.set(T + 10 * S);
  tracker.tick(clock.now());
  const wake = T + 40 * MIN;
  clock.set(wake + 2 * S);
  tracker.ingest({ inputs: [wake + S], apps: [], system: [{ event: 'sleep', at: T + 15 * S }, { event: 'wake', at: wake }], locked: false, since: T + 10 * S }, clock.now());
  tracker.tick(clock.now());
  gate = true;
  clock.set(wake + 30 * S);
  tracker.ingest({ inputs: [], apps: [], system: [], locked: false, since: wake + 2 * S }, clock.now());
  tracker.tick(clock.now());
  assert.equal(store.readDay('2026-10-06').filter((r) => r.type === 'inactivity.detected').length, 0);
});
