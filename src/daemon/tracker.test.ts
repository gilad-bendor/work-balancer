process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createTracker } from './tracker.ts';
import { createStore } from '../store/store.ts';
import { createPolicyLoader } from '../policy/config.ts';
import { fixedClock } from '../core/clock.ts';
import { REPO_ROOT } from '../core/env.ts';
import { silentLogger } from '../core/log.ts';
import type { SensorSamples } from '../bridge/protocol.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';

const S = 1000;
const MIN = 60_000;

async function setup(start: number, seed?: (store: ReturnType<typeof createStore>) => void) {
  const tmp = makeTmpDir('tracker');
  const clock = fixedClock(start);
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  seed?.(store);
  const policy = createPolicyLoader({ path: join(REPO_ROOT, 'config', 'policy.ts'), snapshotPath: join(tmp.dir, 'snap.json'), log: silentLogger });
  await policy.refresh();
  const tracker = await createTracker({ store, clock, log: silentLogger, policy, startedAt: start });
  const samples = (o: Partial<SensorSamples>): SensorSamples => ({ inputs: [], apps: [], system: [], locked: false, since: null, ...o });
  return { ...tmp, clock, store, tracker, samples };
}

test('menubar: worked / limit with colour on an enforcing day (observe mode)', async (t) => {
  const T = local(2026, 10, 4, 10, 0); // Sunday
  const s = await setup(T);
  t.after(s.cleanup);
  const inputs = Array.from({ length: 60 }, (_, i) => T + i * MIN); // an input every minute for an hour
  s.clock.set(T + 60 * MIN);
  s.tracker.ingest(s.samples({ inputs, since: T }), s.clock.now());
  const mb = s.tracker.menubar(s.clock.now());
  assert.equal(mb.title, '⏱ 1:00 / 9:00');
  assert.equal(mb.colour, 'green');
  assert.match(mb.tooltip, /Today: 1:00 of 9:00 — 8:00 left\./);
  assert.match(mb.tooltip, /This week: 1:00 of 44:00\./);
  assert.match(mb.tooltip, /Current stretch: 1:00\./);
});

test('Saturday: grey, no limit; Friday: no colour', async (t) => {
  const sat = await setup(local(2026, 10, 10, 12, 0));
  t.after(sat.cleanup);
  const mb = sat.tracker.menubar(sat.clock.now());
  assert.equal(mb.colour, 'grey');
  assert.equal(mb.title, '⏱ 0:00');
  assert.match(mb.tooltip, /Shabbat/);
  const fri = await setup(local(2026, 10, 9, 12, 0));
  t.after(fri.cleanup);
  assert.equal(fri.tracker.menubar(fri.clock.now()).colour, 'none');
});

test('worked time earlier in the week (from disk) shortens the effective limit', async (t) => {
  const thu = local(2026, 10, 8, 10, 0);
  const s = await setup(thu, (store) => {
    // Sun–Wed: 10 h each, as persisted interactive minutes with one input per minute.
    for (const d of [4, 5, 6, 7]) {
      const from = local(2026, 10, d, 8, 0);
      for (let i = 0; i < 600; i++) store.append({ type: 'minute', provider: 'interactive', minute: from + i * MIN, data: { inputs: [[0, 0]], activeSeconds: 1, lastInputAt: from + i * MIN } });
    }
  });
  t.after(s.cleanup);
  const st = s.tracker.status(s.clock.now()) as { workedEarlierThisWeekSeconds: number; limit: { limitSeconds: number } };
  assert.equal(st.workedEarlierThisWeekSeconds, 4 * (10 * 3600 + 4 * 60)); // each day's last grace window adds 4 min
  assert.equal(st.limit.limitSeconds, 44 * 3600 - st.workedEarlierThisWeekSeconds);
  assert.match(s.tracker.menubar(s.clock.now()).title, /^⏱ 0:00 \/ 3:44$/);
});

test('monitor gaps: a Hammerspoon outage is recorded, a sleep is not, gaps split at 04:00', async (t) => {
  const T = local(2026, 10, 4, 10, 0);
  const s = await setup(T);
  t.after(s.cleanup);
  s.tracker.ingest(s.samples({ since: T }), T + MIN);
  // Lua reloaded after a 10-minute outage → since jumps.
  s.tracker.ingest(s.samples({ since: T + 11 * MIN }), T + 12 * MIN);
  // A sleep explains the next hole.
  s.tracker.ingest(s.samples({ since: T + 12 * MIN, system: [{ event: 'sleep', at: T + 12 * MIN }] }), T + 12 * MIN + S);
  s.tracker.ingest(s.samples({ since: T + 40 * MIN, system: [{ event: 'wake', at: T + 40 * MIN }] }), T + 41 * MIN);
  const gaps = s.store.readDay('2026-10-04').filter((r) => r.type === 'monitor.gap');
  assert.deepEqual(gaps.map((g) => [g.from, g.to, g.cause]), [[T + MIN, T + 11 * MIN, 'hs-down']]);

  const night = await setup(local(2026, 10, 5, 3, 0));
  t.after(night.cleanup);
  night.tracker.ingest(night.samples({ since: local(2026, 10, 5, 3, 0) }), local(2026, 10, 5, 3, 1));
  night.tracker.ingest(night.samples({ since: local(2026, 10, 5, 5, 0) }), local(2026, 10, 5, 5, 1));
  assert.deepEqual(night.store.readDay('2026-10-04').filter((r) => r.type === 'monitor.gap').map((g) => g.to), [local(2026, 10, 5, 4, 0)]);
  assert.deepEqual(night.store.readDay('2026-10-05').filter((r) => r.type === 'monitor.gap').map((g) => g.from), [local(2026, 10, 5, 4, 0)]);
});

test('daemon restart: the hole since the last persisted minute is a daemon-down gap', async (t) => {
  const T = local(2026, 10, 4, 10, 0);
  const s = await setup(T + 30 * MIN, (store) => {
    store.append({ type: 'minute', provider: 'interactive', minute: T, data: {} });
    store.append({ type: 'daemon.started', pid: 1, version: 'x', env: 'test', reason: 'start' });
  });
  t.after(s.cleanup);
  s.tracker.ingest(s.samples({ since: T + 30 * MIN }), T + 30 * MIN + 5 * S);
  const gaps = s.store.readDay('2026-10-04').filter((r) => r.type === 'monitor.gap');
  assert.deepEqual(gaps.map((g) => [g.from, g.to, g.cause]), [[T + MIN, T + 30 * MIN, 'daemon-down']]);
});

test('Q-11: a restart after a long lock is not a gap (skipped locked minutes are explained by the lock)', async (t) => {
  const T = local(2026, 10, 4, 12, 0);
  const s = await setup(T + 60 * MIN, (store) => {
    store.append({ type: 'minute', provider: 'interactive', minute: T, data: { inputs: [[0, 0]] } });
    store.append({ type: 'system', ts: T + 30 * 1000, event: 'lock' });
    store.append({ type: 'daemon.started', pid: 1, version: 'x', env: 'test', reason: 'start' });
  });
  t.after(s.cleanup);
  s.tracker.ingest(s.samples({ since: T + 60 * MIN, locked: true }), T + 60 * MIN + 5 * S);
  assert.deepEqual(s.store.readDay('2026-10-04').filter((r) => r.type === 'monitor.gap'), []);
});
