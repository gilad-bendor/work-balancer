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
