import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { REPO_ROOT } from '../core/env.ts';
import { fixedClock } from '../core/clock.ts';
import { silentLogger } from '../core/log.ts';
import { createStore } from '../store/store.ts';
import { makeTmpDir } from '../testing/tmp.ts';
import { createEffectsManager } from './manager.ts';
import { DEFAULT_QUIET } from './reconcile.ts';
import { reportPeriods, reportWorkSource, withoutReportWork } from '../reports/work.ts';
import { createWorkProvider, type WorkSource } from '../providers/work/index.ts';
import { dayKey } from '../core/time.ts';
import { parseHeartbeat } from '../bridge/protocol.ts';

test('a lost open reply cannot backdate welcome accounting before its actual appearance', (t) => {
  const tmp = makeTmpDir('welcome-lifecycle');
  t.after(tmp.cleanup);
  const start = new Date('2026-10-11T09:00:00+03:00').getTime();
  const clock = fixedClock(start);
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  const manager = createEffectsManager({
    env: 'dev', store, log: silentLogger, now: clock.now, gateOpen: () => true,
    lastInputAt: () => null, quiet: () => DEFAULT_QUIET,
  });
  manager.register({
    name: 'review', audit: true,
    desired: () => ({ windows: [{
      id: 'review:fresh', path: '/ui/review.html', title: 'synthetic',
      mode: 'overlay', placement: 'full', perScreen: true, focus: true, closable: false, intrusive: true,
    }], dims: [] }),
  });
  const beat = (windows: Record<string, string> = {}, closed: { id: string; by: 'page'; at: number; openedAt: number }[] = []) =>
    manager.heartbeat({ actual: { windows, closed, dimmed: false }, acks: [], panic: false, now: clock.now() });
  assert.ok(beat().some((c) => c.op === 'window.open'), 'first reply is lost before Lua sees it');
  clock.advance(60_000);
  assert.ok(beat().some((c) => c.op === 'window.open'), 'retry actually reaches Lua');
  clock.advance(10_000);
  beat({}, [{ id: 'review:fresh', by: 'page', at: clock.now(), openedAt: start + 60_000 }]);
  const records = store.readDay(dayKey(start));
  assert.deepEqual(reportPeriods(records, clock.now(), () => clock.now()), [[start + 60_000, start + 70_000]]);
  const periods = () => reportPeriods(records, start + 330_000, () => start + 330_000);
  const prompt: WorkSource = { name: 'synthetic-prompt', version: () => 0, activity: () => [[start + 30_000, start + 30_000]] };
  const work = createWorkProvider({
    sources: () => [withoutReportWork(prompt, periods, () => 0), reportWorkSource(periods, () => 0)],
    now: () => start + 330_000, graceMs: () => 300_000,
  });
  assert.equal(work.getRangeInfo(start, start + 330_000)?.workedSeconds, 290, 'real work before the welcome is preserved');
});

test('heartbeat accepts actual opening times and drops invalid lifecycle metadata compatibly', () => {
  const heartbeat = parseHeartbeat({
    protocol: 1, loadId: 'synthetic', seq: 1, sentAt: 100,
    ui: {
      windows: { 'review:fresh': 'rev' }, windowOpenedAt: { 'review:fresh': 60, invalid: 'not-a-time' },
      closed: [
        { id: 'review:fresh', by: 'page', at: 90, openedAt: 60 },
        { id: 'legacy', by: 'page', at: 90 },
        { id: 'bad', by: 'page', at: 90, openedAt: 100 },
      ],
    },
  });

  assert.deepEqual(heartbeat.ui.windowOpenedAt, { 'review:fresh': 60 });
  assert.equal(heartbeat.ui.closed[0]!.openedAt, 60);
  assert.equal(heartbeat.ui.closed[1]!.openedAt, undefined);
  assert.equal(heartbeat.ui.closed[2]!.openedAt, undefined);
});

test('Lua stamps initial window appearance before focus, and carries it even on a quick close', () => {
  const lua = readFileSync(join(REPO_ROOT, 'hammerspoon/work-balancer.lua'), 'utf8');
  const createView = lua.slice(lua.indexOf('local function createView('), lua.indexOf('deleteView = function'));
  assert.match(createView, /v:show\(\)\s+if not rec\.openedAt then rec\.openedAt = nowMs\(\) end\s+if spec\.focus/);
  assert.match(lua, /table\.insert\(S\.closedOut, \{ id = id, by = by, at = nowMs\(\), openedAt = rec\.openedAt \}\)/);
  assert.match(lua, /windowOpenedAt = windowOpenedAt\(\)/);
});
