import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInfoRepository, type PerMinuteInfoProvider } from './registry.ts';
import { fixedClock } from './clock.ts';
import { silentLogger } from './log.ts';
import type { Store } from '../store/store.ts';

declare module './registry.ts' {
  interface ProviderTypeMap {
    'test-raw': { minute: { n: number }; range: { total: number } };
    'test-digest': { minute: { double: number }; range: never };
  }
}

function provider<M>(name: string, dependsOn: string[], started: string[], get: (m: number) => M | null): PerMinuteInfoProvider<M> {
  return { name, dependsOn, start: () => { started.push(name); }, getMinuteInfo: get };
}

const ctx = { clock: fixedClock(0), log: silentLogger, store: {} as Store };

test('providers start after their dependencies and are typed by name', async () => {
  const started: string[] = [];
  const repo = createInfoRepository();
  repo.register('test-digest', {
    perMinute: provider('test-digest', ['test-raw'], started, (m) => {
      const raw = repo.get('test-raw').perMinute.getMinuteInfo(m);
      return raw ? { double: raw.n * 2 } : null;
    }),
  });
  repo.register('test-raw', {
    perMinute: provider('test-raw', [], started, (m) => (m === 60_000 ? { n: 21 } : null)),
    timeRange: { name: 'test-raw', getRangeInfo: () => ({ total: 21 }) },
  });
  await repo.startAll(ctx);
  assert.deepEqual(started, ['test-raw', 'test-digest']);
  assert.deepEqual(repo.get('test-digest').perMinute.getMinuteInfo(60_000), { double: 42 });
  assert.equal(repo.get('test-digest').perMinute.getMinuteInfo(0), null);
});

test('missing dependency and duplicate registration are errors', async () => {
  const repo = createInfoRepository();
  repo.register('test-digest', { perMinute: provider<{ double: number }>('test-digest', ['test-raw'], [], () => null) });
  await assert.rejects(repo.startAll(ctx), /unknown provider test-raw/);
  assert.throws(() => repo.register('test-digest', { perMinute: provider<{ double: number }>('test-digest', [], [], () => null) }), /twice/);
});
