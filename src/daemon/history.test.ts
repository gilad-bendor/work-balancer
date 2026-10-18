process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHistory } from './history.ts';
import { createStore } from '../store/store.ts';
import { fixedClock } from '../core/clock.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';

test('historical welcome exclusion ends at lost sensor coverage, not a delayed reload close', (t) => {
  const tmp = makeTmpDir('report-history');
  t.after(tmp.cleanup);
  const start = local(2026, 10, 11, 9, 0);
  const clock = fixedClock(start);
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  store.append({ type: 'effect.shown', windowId: 'review:fresh', at: start });
  store.append({ type: 'minute', provider: 'interactive', minute: start, data: {} });
  const prompt = local(2026, 10, 11, 11, 0);
  store.append({ type: 'minute', provider: 'prompt-history', minute: prompt, data: { prompts: 1, at: [0] } });
  clock.set(local(2026, 10, 11, 12, 0));
  store.append({ type: 'monitor.gap', from: start + 60_000, to: clock.now(), cause: 'hs-down' });
  store.append({ type: 'effect.closed', windowId: 'review:fresh', by: 'reload' });
  const history = createHistory({ store, log: silentLogger, now: clock.now, graceMs: () => 300_000 });
  assert.equal(history.daySeconds('2026-10-11', '2026-10-11').get('2026-10-11'), 300, 'the human prompt made while the overlay was absent still counts');
});

test('days(): worked intervals, blocked time (minus a token) and app categories of past days', (t) => {
  const tmp = makeTmpDir('history-days');
  t.after(tmp.cleanup);
  const clock = fixedClock(local(2026, 10, 11, 9, 0));
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  for (let i = 0; i < 10; i++) {
    const m = local(2026, 10, 11, 10, i);
    clock.set(m + 60_000);
    store.append({ type: 'minute', provider: 'interactive', minute: m, data: { inputs: [[0, 0]], activeSeconds: 1, lastInputAt: m, categories: i < 2 ? { WhatsApp: 60 } : { Work: 60 } } });
  }
  const b = local(2026, 10, 11, 18, 0);
  clock.set(b);
  store.append({ type: 'policy.transition', from: 'countdown', to: 'blocked' });
  clock.set(b + 60 * 60_000);
  store.append({ type: 'token.used', minutes: 10, until: b + 70 * 60_000 });
  clock.set(local(2026, 10, 14, 12, 0));
  const history = createHistory({ store, log: silentLogger, now: clock.now, graceMs: () => 300_000 });
  const d = history.days('2026-10-10', '2026-10-11');
  assert.deepEqual(d.get('2026-10-10'), { seconds: 0, busy: [], blocked: [], categories: [] });
  const sun = d.get('2026-10-11')!;
  assert.equal(sun.seconds, 14 * 60);
  assert.deepEqual(sun.busy, [[local(2026, 10, 11, 10, 0), local(2026, 10, 11, 10, 14)]]);
  assert.deepEqual(sun.blocked, [[b, b + 60 * 60_000], [b + 70 * 60_000, local(2026, 10, 12, 4, 0)]]);
  assert.deepEqual(sun.categories, [{ state: 'WhatsApp', intervals: [[local(2026, 10, 11, 10, 0), local(2026, 10, 11, 10, 2)]] }]);
  assert.equal(history.daySeconds('2026-10-11', '2026-10-11').get('2026-10-11'), 14 * 60, 'cached, same answer');
});
