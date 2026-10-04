process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInteractiveProvider, decodeMinute, type InteractiveMinute } from './index.ts';
import { createStore } from '../../store/store.ts';
import { fixedClock } from '../../core/clock.ts';
import { silentLogger } from '../../core/log.ts';
import { lastWinsByMinute } from '../../store/records.ts';
import type { SensorSamples } from '../../bridge/protocol.ts';
import { local, makeTmpDir } from '../../testing/tmp.ts';

const S = 1000;
const MIN = 60_000;
const T = local(2026, 10, 4, 10, 0);

function setup() {
  const tmp = makeTmpDir('interactive');
  const clock = fixedClock(T);
  const store = createStore({ dataDir: tmp.dir, clock, log: silentLogger });
  const p = createInteractiveProvider({ store, log: silentLogger, now: () => clock.now() });
  const samples = (o: Partial<SensorSamples>): SensorSamples => ({ inputs: [], apps: [], system: [], locked: false, since: null, ...o });
  const minutes = () => lastWinsByMinute<Record<string, unknown>>(store.readDay('2026-10-04'), 'interactive');
  const lines = () => store.readDay('2026-10-04').filter((r) => r.type === 'minute').length;
  return { ...tmp, clock, store, p, samples, minutes, lines };
}

test('every monitored minute gets one record; inputs, apps (≥ 5 s, top 3), lock seconds', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.clock.set(T + 3 * MIN);
  s.p.ingest(
    s.samples({
      inputs: [T + 1 * S, T + 2 * S, T + 3 * S, T + 10 * S, T + 70 * S],
      apps: [
        { id: 'com.microsoft.VSCode', name: 'Code', from: T - MIN, to: T + 40 * S },
        { id: 'com.google.Chrome', name: 'Chrome', from: T + 40 * S, to: T + 44 * S },
        { id: 'com.apple.Terminal', name: 'Terminal', from: T + 44 * S, to: T + 3 * MIN },
      ],
      system: [{ event: 'lock', at: T + 150 * S }],
      locked: true,
    }),
    { since: T, until: T + 3 * MIN },
    T + 3 * MIN,
  );
  s.clock.set(T + 3 * MIN + 70 * S);
  assert.equal(s.p.flushMinutes(s.clock.now()), 3);
  const m = s.minutes();
  assert.deepEqual([...m.keys()], [T, T + MIN, T + 2 * MIN]);
  const m0 = decodeMinute(m.get(T)!.data);
  assert.deepEqual(m0.inputs, [[1 * S, 3 * S], [10 * S, 10 * S]]);
  assert.equal(m0.activeSeconds, 4);
  assert.equal(m0.lastInputAt, T + 10 * S);
  assert.deepEqual(m0.topApps.map((a) => [a.name, a.s]), [['Code', 40], ['Terminal', 16]]); // Chrome 4 s < 5 s
  const m2 = decodeMinute(m.get(T + 2 * MIN)!.data);
  assert.equal(m2.lockedSeconds, 30);
  assert.deepEqual(m2.topApps.map((a) => [a.name, a.s]), [['Terminal', 30]], 'locked time is not app time');
  assert.equal(m.get(T + 2 * MIN)!.data.inputs, undefined, 'empty fields are omitted on disk');
  // The lock was persisted as a system record with its own time.
  assert.deepEqual(s.store.readDay('2026-10-04').filter((r) => r.type === 'system').map((r) => [r.event, r.ts]), [['lock', T + 150 * S]]);
});

test('re-sent samples are idempotent; late samples re-emit the full minute (last wins)', (t) => {
  const s = setup();
  t.after(s.cleanup);
  const batch = s.samples({ inputs: [T + 5 * S] });
  s.p.ingest(batch, { since: T, until: T + MIN }, T + MIN);
  s.clock.set(T + 2 * MIN + 15 * S);
  s.p.flushMinutes(s.clock.now());
  const before = s.lines();
  s.p.ingest(batch, { since: T, until: T + MIN }, s.clock.now());
  s.p.flushMinutes(s.clock.now());
  assert.equal(s.lines(), before, 'a duplicate batch writes nothing');
  s.p.ingest(s.samples({ inputs: [T + 50 * S] }), { since: T + MIN, until: T + 2 * MIN }, s.clock.now());
  s.clock.advance(5 * S);
  s.p.flushMinutes(s.clock.now());
  assert.deepEqual(decodeMinute(s.minutes().get(T)!.data).inputs, [[5 * S, 5 * S], [50 * S, 50 * S]]);
});

test('a heartbeat carrying the sleep event does not fake a wake; fully asleep minutes are not written', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.p.ingest(s.samples({ inputs: [T + S], system: [{ event: 'sleep', at: T + 30 * S }] }), { since: T, until: T + 31 * S }, T + 31 * S);
  assert.deepEqual(s.p.blocked(T, T + 10 * MIN), [[T + 30 * S, T + 10 * MIN]]);
  s.p.ingest(s.samples({ system: [{ event: 'wake', at: T + 5 * MIN + 10 * S }] }), { since: T + 31 * S, until: T + 5 * MIN + 12 * S }, T + 5 * MIN + 12 * S);
  s.clock.set(T + 8 * MIN);
  s.p.flushMinutes(s.clock.now());
  const keys = [...s.minutes().keys()];
  assert.deepEqual(keys, [T, T + 5 * MIN], 'minutes 1–4 were fully asleep');
  assert.equal(decodeMinute(s.minutes().get(T)!.data).asleepSeconds, 30);
});

test("the heartbeat's locked flag repairs a missed unlock", (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.p.ingest(s.samples({ system: [{ event: 'lock', at: T }], locked: true }), { since: T - MIN, until: T + S }, T + S);
  s.p.ingest(s.samples({ locked: false }), { since: T + S, until: T + 2 * MIN }, T + 2 * MIN);
  assert.deepEqual(s.p.workSource.blocked!(T - MIN, T + 10 * MIN), [[T, T + 2 * MIN]]);
});

test('restart: loading persisted records restores runs, lock state and records (no rewrite of unchanged minutes)', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.p.ingest(
    s.samples({ inputs: [T + 5 * S, T + 6 * S], apps: [{ id: 'a', name: 'A', from: T, to: T + 2 * MIN }], system: [{ event: 'lock', at: T + 90 * S }], locked: true }),
    { since: T, until: T + 2 * MIN },
    T + 2 * MIN,
  );
  s.clock.set(T + 5 * MIN);
  s.p.flushMinutes(s.clock.now(), { all: true });
  const lines = s.lines();
  const p2 = createInteractiveProvider({ store: s.store, log: silentLogger, now: () => s.clock.now() });
  p2.load(s.store.readDay('2026-10-04'));
  assert.deepEqual(p2.workSource.activity!(T, T + MIN), [[T + 5 * S, T + 6 * S]]);
  assert.deepEqual(p2.workSource.blocked!(T, T + 3 * MIN), [[T + 90 * S, T + 3 * MIN]]);
  assert.deepEqual((p2.getMinuteInfo(T) as InteractiveMinute).topApps.map((a) => a.id), ['a']);
  assert.equal(p2.coverageEnd(), T + 2 * MIN, 'coverage ended with the last heartbeat');
  // New daemon gets an overlapping re-send from Lua's outbox: unchanged minutes are not rewritten.
  p2.ingest(s.samples({ inputs: [T + 5 * S], locked: true }), { since: T + MIN, until: T + 6 * MIN }, T + 6 * MIN);
  s.clock.set(T + 8 * MIN);
  p2.flushMinutes(s.clock.now());
  const after = s.store.readDay('2026-10-04').filter((r) => r.type === 'minute').map((r) => r.minute);
  assert.ok(!after.slice(lines).includes(T), 'minute T was not re-emitted');
});

test('Q-11/D-31: no record for an idle minute that was entirely locked; partial or with input → record', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.p.ingest(
    s.samples({ inputs: [T + 5 * S, T + 2 * MIN + 30 * S], system: [{ event: 'lock', at: T + 30 * S }], locked: true }),
    { since: T, until: T + 4 * MIN },
    T + 4 * MIN,
  );
  s.clock.set(T + 6 * MIN);
  s.p.flushMinutes(s.clock.now());
  // T: partly locked; T+1: idle + fully locked → skipped; T+2: locked but typed (password) → kept; T+3: skipped.
  assert.deepEqual([...s.minutes().keys()], [T, T + 2 * MIN]);
  assert.equal(s.p.getMinuteInfo(T + MIN), null);
  const r = s.p.getRangeInfo(T, T + 4 * MIN)!;
  assert.equal(r.lockedSeconds, 3 * 60 + 30, 'locked totals come from the timeline, not from minute records');
  assert.equal(r.monitoredMinutes, 2);
});
