import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon } from '../daemon/daemon.ts';
import { fixedClock } from '../core/clock.ts';
import { REPO_ROOT, resolveEnv } from '../core/env.ts';
import { silentLogger } from '../core/log.ts';
import { PROTOCOL_VERSION } from '../bridge/protocol.ts';
import { makeTmpDir } from '../testing/tmp.ts';
import { createEffectsManager } from './manager.ts';
import type { Effect } from '../core/effects.ts';
import type { Store } from '../store/store.ts';

async function start(t: { after(fn: () => unknown): void }, envName: 'dev' | 'live' = 'dev') {
  const tmp = makeTmpDir('effects');
  // A "live" env for the gate tests, but with every path in the tmp dir (resolveEnv refuses WB_VAR_DIR for live).
  const devEnv = resolveEnv({ WB_ENV: 'dev', WB_VAR_DIR: tmp.dir }, REPO_ROOT);
  const env = { ...devEnv, name: envName, port: 0 };
  const clock = fixedClock(Date.UTC(2026, 9, 4, 10, 0));
  let lastInput: number | null = null;
  const daemon = (await startDaemon({
    env, clock, log: silentLogger, tickMs: 60_000,
    createTracker: () => ({ ingest() {}, tick() {}, flush() {}, status: () => null, lastInputAt: () => lastInput, menubar: () => ({ title: '⏱', colour: 'none' as const, tooltip: '', warning: null }) }),
  }))!;
  t.after(async () => { await daemon.stop('test'); tmp.cleanup(); });
  const base = `http://127.0.0.1:${daemon.info.port}`;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-wb-token': daemon.info.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  let seq = 0;
  const beat = async (ui: Record<string, unknown> = {}, acks: string[] = []) =>
    (await call('/bridge/heartbeat', {
      protocol: PROTOCOL_VERSION, loadId: 'L', seq: ++seq, sentAt: clock.now(), samples: { inputs: [], apps: [], system: [], locked: false },
      ui: { windows: {}, dimmed: false, latches: { panic: false, quit: false }, ...ui }, acks,
    })).json;
  return { tmp, daemon, base, call, beat, clock, setLastInput: (t: number | null) => { lastInput = t; } };
}

test('pages: html/css served as is, page scripts type-stripped, no path escapes, no token needed', async (t) => {
  const { base } = await start(t);
  const html = await fetch(`${base}/ui/fixture.html`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type')!, /text\/html/);
  const js = await fetch(`${base}/ui/page.ts`);
  assert.match(js.headers.get('content-type')!, /javascript/);
  const src = await js.text();
  assert.doesNotMatch(src, /interface WbHandler|: Promise<T>/);
  assert.match(src, /export async function api/);
  for (const bad of ['/ui/../serve.ts', '/ui/%2e%2e/serve.ts', '/ui/missing.ts', '/ui/Fixture.html', '/ui/']) assert.equal((await fetch(base + bad)).status, 404, bad);
});

test('test windows: open via the reconciler, Lua report → no more commands, page action closes, user close forgets', async (t) => {
  const { call, beat, tmp } = await start(t);
  assert.equal((await call('/api/ui/strings')).json.strings.close, 'Close');
  const { json: opened } = await call('/api/test/window', { mode: 'overlay', perScreen: true });
  const r1 = await beat();
  const open = r1.commands.find((c: any) => c.op === 'window.open');
  assert.equal(open.window.id, opened.id);
  assert.equal(open.window.mode, 'overlay');
  assert.equal(open.window.placement, 'full');
  assert.equal(open.window.perScreen, true);
  const r2 = await beat({ windows: { [opened.id]: open.window.rev } }, [open.id]);
  assert.deepEqual(r2.commands, []);
  const model = (await call(`/api/ui/model?win=${encodeURIComponent(opened.id)}`)).json;
  assert.equal(model.model.mode, 'overlay');
  assert.equal(model.env, 'dev');
  assert.equal((await call('/api/ui/action', { win: opened.id, action: 'echo', payload: { text: 'hi' } })).json.echo, 'hi');
  assert.deepEqual((await call('/api/ui/action', { win: opened.id, action: 'close' })).json, { ok: true, close: true });
  const r3 = await beat({ windows: { [opened.id]: open.window.rev } });
  assert.deepEqual(r3.commands.map((c: any) => c.id), [`close:${opened.id}`]);
  // A second window closed by the user (Lua report) is forgotten; a system/panic close is not a dismissal.
  const { json: w2 } = await call('/api/test/window', { mode: 'floating' });
  const rev2 = (await beat()).commands[0].window.rev;
  const panicClosed = await beat({ closed: [{ id: w2.id, by: 'panic', at: 1 }] });
  assert.equal(panicClosed.commands[0].window.id, w2.id, 'panic close: still desired (Lua refuses while latched)');
  await beat({ windows: { [w2.id]: rev2 } });
  const userClosed = await beat({ closed: [{ id: w2.id, by: 'user', at: 2 }] });
  assert.deepEqual(userClosed.commands, []);
  // Test windows are never audited into data.
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(tmp.dir, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl'));
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const f of files) assert.doesNotMatch(readFileSync(join(tmp.dir, f), 'utf8'), /effect\./);
});

test('R-UI-QUIET through the daemon; panic latch suppresses intrusive test windows and dims', async (t) => {
  const { call, beat, clock, setLastInput } = await start(t);
  await call('/api/test/window', { mode: 'floating' });
  await call('/api/test/dim', { seconds: 2 });
  setLastInput(clock.now() - 3_000);
  assert.deepEqual((await beat()).commands, []);
  setLastInput(clock.now() - 10_000);
  const r = await beat({ latches: { panic: true, quit: false }, panicAt: clock.now() });
  assert.deepEqual(r.commands, [], 'panic: nothing intrusive');
  const r2 = await beat();
  assert.deepEqual(r2.commands.map((c: any) => c.op).sort(), ['dim', 'window.open']);
  const dimId = r2.commands.find((c: any) => c.op === 'dim').id;
  const r3 = await beat({}, [dimId]);
  assert.deepEqual(r3.commands.map((c: any) => c.op), ['window.open'], 'acked pulse never re-sent');
});

test('live env: test windows need "live": true; the gate drops intrusive effects until liveEffects', async (t) => {
  const { call } = await start(t, 'live');
  assert.equal((await call('/api/test/window', { mode: 'overlay' })).status, 403);
  assert.equal((await call('/api/test/dim', {})).status, 403);
  assert.equal((await call('/api/test/window', { mode: 'overlay', live: true, ttlSeconds: 5 })).status, 200);

  let gate = false;
  const store = { append: () => null } as unknown as Store;
  const m = createEffectsManager({ env: 'live', store, log: silentLogger, now: () => 0, gateOpen: () => gate, lastInputAt: () => null, quiet: () => ({ afterInputMs: 0, maxDeferMs: 0 }) });
  const product: Effect = {
    name: 'warn', audit: true,
    desired: () => ({ windows: [{ id: 'warn', path: '/ui/x.html', mode: 'floating', placement: 'center', title: 'w', intrusive: true }, { id: 'warn:menu', path: '/ui/y.html', mode: 'normal', placement: 'center', title: 'm', intrusive: false }, { id: 'other', path: '/', mode: 'normal', placement: 'center', title: 'x', intrusive: false }], dims: [{ pulseId: 'p', level: 0.5, seconds: 1 }] }),
  };
  m.register(product);
  assert.deepEqual(m.desired(0).windows.map((w) => w.id), ['warn:menu'], 'gate closed: only user-initiated; mis-prefixed ids ignored');
  assert.deepEqual(m.desired(0).dims, []);
  gate = true;
  assert.deepEqual(m.desired(0).windows.map((w) => w.id), ['warn', 'warn:menu']);
  assert.equal(m.desired(0).dims.length, 1);
});

test('audited effects log effect.shown once and effect.closed once per report', async () => {
  const appended: Record<string, unknown>[] = [];
  const store = { append: (r: Record<string, unknown>) => { appended.push(r); return r; } } as unknown as Store;
  const m = createEffectsManager({ env: 'dev', store, log: silentLogger, now: () => 0, gateOpen: () => true, lastInputAt: () => null, quiet: () => ({ afterInputMs: 0, maxDeferMs: 0 }) });
  m.register({ name: 'warn', audit: true, desired: () => ({ windows: [], dims: [] }) });
  m.heartbeat({ actual: { windows: { warn: 'r' }, dimmed: false, closed: [] }, acks: [], panic: false, now: 0 });
  m.heartbeat({ actual: { windows: { warn: 'r' }, dimmed: false, closed: [] }, acks: [], panic: false, now: 0 });
  const closed = [{ id: 'warn', by: 'user' as const, at: 5 }];
  m.heartbeat({ actual: { windows: {}, dimmed: false, closed }, acks: [], panic: false, now: 0 });
  m.heartbeat({ actual: { windows: {}, dimmed: false, closed }, acks: [], panic: false, now: 0 });
  assert.deepEqual(appended, [{ type: 'effect.shown', effect: 'warn', windowId: 'warn' }, { type: 'effect.closed', effect: 'warn', windowId: 'warn', by: 'user' }]);
});

test('overlayOpacity applies to screen-covering windows only and changes their rev', () => {
  let opacity = 0.7;
  const store = { append: () => null } as unknown as Store;
  const m = createEffectsManager({ env: 'dev', store, log: silentLogger, now: () => 0, gateOpen: () => true, lastInputAt: () => null, quiet: () => ({ afterInputMs: 0, maxDeferMs: 0 }), overlayOpacity: () => opacity });
  m.register({ name: 'x', audit: false, desired: () => ({ windows: [
    { id: 'x:o', path: '/', mode: 'overlay', placement: 'full', title: '', intrusive: true },
    { id: 'x:f', path: '/', mode: 'floating', placement: 'full', title: '', intrusive: true },
    { id: 'x:d', path: '/', mode: 'floating', placement: 'center', title: '', intrusive: true },
  ], dims: [] }) });
  const [o, f, d] = m.desired(0).windows;
  assert.equal(o!.opacity, 0.7);
  assert.equal(f!.opacity, 0.7);
  assert.equal(d!.opacity, undefined);
  opacity = 1;
  const [o2] = m.desired(0).windows;
  assert.equal(o2!.opacity, undefined);
  assert.notEqual(o2!.rev, o!.rev);
});

test('review M7#4/#7: covering windows are always intrusive; audit state survives restarts; vanished windows close by reload', () => {
  const T0 = Date.UTC(2026, 9, 4, 10, 0);
  const appended: Record<string, unknown>[] = [];
  const history = [{ v: 1, ts: T0 - 1000, type: 'effect.shown', effect: 'block', windowId: 'block' }];
  const store = { append: (r: Record<string, unknown>) => { appended.push(r); return r; }, readDays: () => history } as unknown as Store;
  const m = createEffectsManager({ env: 'live', store, log: silentLogger, now: () => T0, gateOpen: () => false, lastInputAt: () => null, quiet: () => ({ afterInputMs: 0, maxDeferMs: 0 }) });
  m.register({ name: 'block', audit: true, desired: () => ({ windows: [{ id: 'block', path: '/', mode: 'overlay', placement: 'full', title: '', intrusive: false }], dims: [] }) });
  assert.deepEqual(m.desired(T0).windows, [], 'covering window gated like any intrusive one');
  m.heartbeat({ actual: { windows: { block: 'r' }, dimmed: false, closed: [] }, acks: [], panic: false, now: T0 });
  assert.deepEqual(appended, [], 'already shown before the restart: not re-logged');
  m.heartbeat({ actual: { windows: {}, dimmed: false, closed: [] }, acks: [], panic: false, now: T0 });
  assert.deepEqual(appended, [{ type: 'effect.closed', effect: 'block', windowId: 'block', by: 'reload' }]);
});

test('review M7#8: at most 4 test windows at a time', async (t) => {
  const { call } = await start(t);
  for (let i = 0; i < 4; i++) assert.equal((await call('/api/test/window', { mode: 'normal' })).status, 200);
  assert.equal((await call('/api/test/window', { mode: 'normal' })).status, 429);
  const { json } = await call('/api/test/window', { mode: 'overlay', intrusive: false, live: true });
  assert.equal(json.error?.includes('at most'), true);
});

test('review M7 round 2: a dismissed window obeys R-UI-QUIET next time; a reload-lost one re-appears at once', () => {
  const T0 = Date.UTC(2026, 9, 4, 10, 0);
  const store = { append: () => null, readDays: () => [] } as unknown as Store;
  const m = createEffectsManager({ env: 'dev', store, log: silentLogger, now: () => T0, gateOpen: () => true, lastInputAt: () => T0 - 1, quiet: () => ({ afterInputMs: 10_000, maxDeferMs: 120_000 }) });
  m.register({ name: 'nudge', audit: false, desired: () => ({ windows: [{ id: 'nudge', path: '/', mode: 'floating', placement: 'top-right', title: '', intrusive: true }], dims: [] }) });
  const hb = (windows: Record<string, string>, closed: { id: string; by: 'user' | 'reload'; at: number }[] = []) =>
    m.heartbeat({ actual: { windows, dimmed: false, closed }, acks: [], panic: false, now: T0 });
  hb({ nudge: 'r' });
  assert.deepEqual(hb({}).map((c) => c.op), ['window.open'], 'lost without a close report (reload): back at once');
  hb({ nudge: 'r' });
  assert.deepEqual(hb({}, [{ id: 'nudge', by: 'user', at: 1 }]), [], 'dismissed: the next one waits for a typing pause');
});

test('M8: every heartbeat reply carries the menu; a quit shutdown logs app.quit (by menu / cli)', async (t) => {
  const { beat, call, daemon } = await start(t);
  const r = await beat();
  assert.deepEqual(r.menubar.menu.map((m: any) => m.id), ['quick', 'summary', 'notes', '-', 'quit']);
  assert.equal(r.menubar.menu[0].title, 'Quick note…');
  assert.equal((await call('/bridge/ui-request', { open: 'nope' })).status, 404);
  assert.equal((await call('/bridge/shutdown', { reason: 'quit', by: 'menu' })).json.ok, true);
  await new Promise((res) => setTimeout(res, 150));
  const { readFileSync } = await import('node:fs');
  const { dayKey } = await import('../core/time.ts');
  const lines = readFileSync(daemon.store.filePath(dayKey(Date.UTC(2026, 9, 4, 10, 0))), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.type === 'app.quit').map((l) => l.by), ['menu']);
  assert.equal(lines.at(-1).type, 'daemon.stopped');
  assert.equal(lines.at(-1).reason, 'quit');
});
