import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, type DaemonInfo } from './daemon.ts';
import { fixedClock } from '../core/clock.ts';
import { REPO_ROOT, resolveEnv } from '../core/env.ts';
import { silentLogger } from '../core/log.ts';
import { PROTOCOL_VERSION } from '../bridge/protocol.ts';
import { makeTmpDir } from '../testing/tmp.ts';

function testEnv(dir: string, port = 0) {
  return resolveEnv({ WB_ENV: 'dev', WB_VAR_DIR: dir, WB_PORT: String(port || 1) }, REPO_ROOT);
}

const stubTracker = () => ({
  ingest() {}, tick() {}, flush() {}, status: () => null,
  menubar: () => ({ title: '⏱', colour: 'none' as const, tooltip: '', warning: null }),
});

async function start(t: { after(fn: () => unknown): void }) {
  const tmp = makeTmpDir('daemon');
  const env = { ...testEnv(tmp.dir), port: 0 };
  const clock = fixedClock(Date.UTC(2026, 9, 4, 10, 0));
  const daemon = (await startDaemon({ env, clock, log: silentLogger, tickMs: 60_000, createTracker: stubTracker }))!;
  t.after(async () => { await daemon.stop('test'); tmp.cleanup(); });
  const base = `http://127.0.0.1:${daemon.info.port}`;
  const post = (path: string, body: unknown, token: string | null = daemon.info.token) =>
    fetch(base + path, { method: 'POST', headers: token ? { 'x-wb-token': token } : {}, body: JSON.stringify(body) });
  return { tmp, env, daemon, base, post, clock };
}

const hb = (seq: number, extra: Record<string, unknown> = {}) => ({
  protocol: PROTOCOL_VERSION, loadId: 'L1', seq, sentAt: 0,
  samples: { inputs: {}, apps: {}, system: {}, locked: false },
  ui: { windows: {}, dimmed: false, latches: { panic: false, quit: false } },
  acks: {}, ...extra,
});

test('daemon.json is written atomically with mode 0600 and removed on stop', async (t) => {
  const s = await start(t);
  const path = join(s.env.varDir, 'daemon.json');
  const info = JSON.parse(readFileSync(path, 'utf8')) as DaemonInfo;
  assert.equal(info.pid, process.pid);
  assert.equal(info.port, s.daemon.info.port);
  assert.equal(info.protocol, PROTOCOL_VERSION);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await s.daemon.stop('test');
  assert.equal(existsSync(path), false);
  const types = s.daemon.store.readDay('2026-10-04').map((r) => r.type);
  assert.deepEqual(types.filter((t) => t.startsWith('daemon.')), ['daemon.started', 'daemon.stopped']);
});

test('/health is open; everything else needs the token; foreign Host is refused', async (t) => {
  const s = await start(t);
  const h = await (await fetch(s.base + '/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.env, 'dev');
  assert.equal((await s.post('/bridge/heartbeat', hb(1), null)).status, 401);
  assert.equal((await s.post('/bridge/heartbeat', hb(1), 'wrong')).status, 401);
  assert.equal((await fetch(s.base + '/api/status')).status, 401);
  assert.equal((await fetch(`${s.base}/api/status?token=${s.daemon.info.token}`)).status, 200);
  const evilStatus = await new Promise<number | undefined>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.daemon.info.port, path: '/health', headers: { host: 'evil.example:80' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(evilStatus, 403);
});

test('heartbeat: reply has a menubar; duplicates by (loadId, seq) are not re-processed; protocol mismatch → 409', async (t) => {
  const s = await start(t);
  const r1 = await (await s.post('/bridge/heartbeat', hb(1))).json();
  assert.equal(r1.protocol, PROTOCOL_VERSION);
  assert.equal(r1.dayKey, '2026-10-04');
  assert.equal(typeof r1.menubar.title, 'string');
  assert.equal(r1.duplicate, false);
  assert.equal((await (await s.post('/bridge/heartbeat', hb(1))).json()).duplicate, true);
  assert.equal((await (await s.post('/bridge/heartbeat', hb(2))).json()).duplicate, false);
  assert.equal((await (await s.post('/bridge/heartbeat', { ...hb(1), loadId: 'L2' })).json()).duplicate, false, 'new Lua load restarts seq');
  const mismatch = await s.post('/bridge/heartbeat', hb(3, { protocol: 999 }));
  assert.equal(mismatch.status, 409);
  assert.equal((await s.post('/bridge/heartbeat', { nope: 1 })).status, 400);
});

test('heartbeats are refused with 503 until the tracker is ready (samples must not be dropped)', async (t) => {
  const tmp = makeTmpDir('daemon-slow');
  const env = { ...testEnv(tmp.dir), port: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ingested: number[] = [];
  const starting = startDaemon({
    env, clock: fixedClock(Date.UTC(2026, 9, 4, 10, 0)), log: silentLogger, tickMs: 60_000,
    createTracker: async () => {
      await gate;
      return { ingest: (s) => ingested.push(...s.inputs), tick() {}, flush() {}, status: () => null,
        menubar: () => ({ title: 't', colour: 'none', tooltip: '', warning: null }) };
    },
  });
  for (let i = 0; i < 100 && !existsSync(join(env.varDir, 'daemon.json')); i++) await new Promise((r) => setTimeout(r, 10));
  const info = JSON.parse(readFileSync(join(env.varDir, 'daemon.json'), 'utf8')) as DaemonInfo;
  const send = (seq: number) => fetch(`http://127.0.0.1:${info.port}/bridge/heartbeat`, {
    method: 'POST', headers: { 'x-wb-token': info.token }, body: JSON.stringify({ ...hb(seq), samples: { inputs: [42], locked: false } }) });
  assert.equal((await send(1)).status, 503);
  release();
  const daemon = (await starting)!;
  t.after(async () => { await daemon.stop('test'); tmp.cleanup(); });
  assert.equal((await send(2)).status, 200);
  assert.deepEqual(ingested, [42]);
});

test('panic latch transition is logged once', async (t) => {
  const s = await start(t);
  const panic = (seq: number, on: boolean) => hb(seq, { ui: { windows: [], dimmed: false, latches: { panic: on, quit: false }, panicBy: 'cli' } });
  await s.post('/bridge/heartbeat', panic(1, true));
  await s.post('/bridge/heartbeat', panic(2, true));
  await s.post('/bridge/heartbeat', panic(3, false));
  await s.post('/bridge/heartbeat', panic(4, true));
  const records = s.daemon.store.readDay('2026-10-04').filter((r) => r.type === 'panic' || r.type === 'resume');
  assert.deepEqual(records.map((r) => r.type), ['panic', 'resume', 'panic']);
  assert.equal(records[0]!.by, 'cli');
});

test('panic: expiry at 04:00 is decided by the daemon from panicAt; a restarted daemon does not re-log it', async (t) => {
  const s = await start(t); // clock: 2026-10-04 13:00 local
  const at = (ms: number) => hb(0, { ui: { windows: [], dimmed: false, latches: { panic: true, quit: false }, panicBy: 'hotkey', panicAt: ms } });
  const today = Date.UTC(2026, 9, 4, 9, 0);
  const r1 = await (await s.post('/bridge/heartbeat', { ...at(today), seq: 1 })).json();
  assert.equal(r1.panicExpired, false);
  const yesterday = Date.UTC(2026, 9, 3, 9, 0);
  const r2 = await (await s.post('/bridge/heartbeat', { ...at(yesterday), seq: 2 })).json();
  assert.equal(r2.panicExpired, true);
  const types = s.daemon.store.readDay('2026-10-04').filter((r) => r.type === 'panic' || r.type === 'resume').map((r) => `${r.type}:${r.by}`);
  assert.deepEqual(types, ['panic:hotkey', 'resume:rollover']);
  // The reply was lost: Lua repeats the stale latch — nothing more is logged.
  const r3 = await (await s.post('/bridge/heartbeat', { ...at(yesterday), seq: 3 })).json();
  assert.equal(r3.panicExpired, true);
  assert.equal(s.daemon.store.readDay('2026-10-04').filter((r) => r.type === 'panic' || r.type === 'resume').length, 2);
});

test('a panic from last night restored after a restart is expired with one resume:rollover, never re-logged', async (t) => {
  const tmp = makeTmpDir('daemon-night');
  const env = { ...testEnv(tmp.dir), port: 0 };
  const clock = fixedClock(Date.UTC(2026, 9, 3, 19, 0)); // Sat 22:00 local
  const first = (await startDaemon({ env, clock, log: silentLogger, tickMs: 60_000, createTracker: stubTracker }))!;
  first.store.append({ type: 'panic', by: 'hotkey', at: clock.now() });
  await first.stop('test');
  clock.set(Date.UTC(2026, 9, 4, 6, 0)); // Sun 09:00 local
  const second = (await startDaemon({ env, clock, log: silentLogger, tickMs: 60_000, createTracker: stubTracker }))!;
  t.after(async () => { await second.stop('test'); tmp.cleanup(); });
  const send = (seq: number) => fetch(`http://127.0.0.1:${second.info.port}/bridge/heartbeat`, { method: 'POST', headers: { 'x-wb-token': second.info.token },
    body: JSON.stringify(hb(seq, { ui: { windows: [], dimmed: false, latches: { panic: true, quit: false }, panicBy: 'hotkey', panicAt: Date.UTC(2026, 9, 3, 19, 0) } })) });
  assert.equal((await (await send(1)).json()).panicExpired, true);
  await send(2);
  const today = second.store.readDay('2026-10-04').filter((r) => r.type === 'panic' || r.type === 'resume').map((r) => `${r.type}:${r.by}`);
  assert.deepEqual(today, ['resume:rollover']);
});

test('a restarted daemon picks up today\'s active panic and does not log it again', async (t) => {
  const tmp = makeTmpDir('daemon-panic');
  const env = { ...testEnv(tmp.dir), port: 0 };
  const clock = fixedClock(Date.UTC(2026, 9, 4, 10, 0));
  const first = (await startDaemon({ env, clock, log: silentLogger, tickMs: 60_000, createTracker: stubTracker }))!;
  first.store.append({ type: 'panic', by: 'hotkey', at: clock.now() });
  await first.stop('test');
  const second = (await startDaemon({ env, clock, log: silentLogger, tickMs: 60_000, createTracker: stubTracker }))!;
  t.after(async () => { await second.stop('test'); tmp.cleanup(); });
  await fetch(`http://127.0.0.1:${second.info.port}/bridge/heartbeat`, { method: 'POST', headers: { 'x-wb-token': second.info.token },
    body: JSON.stringify(hb(1, { ui: { windows: [], dimmed: false, latches: { panic: true, quit: false }, panicBy: 'hotkey', panicAt: clock.now() } })) });
  assert.equal(second.store.readDay('2026-10-04').filter((r) => r.type === 'panic').length, 1);
});

test('WB_VAR_DIR is refused for the live env (live data must never be redirected by accident)', () => {
  assert.throws(() => resolveEnv({ WB_ENV: 'live', WB_VAR_DIR: '/x' }), /dev\/test/);
  assert.throws(() => resolveEnv({ WB_ENV: 'live', WB_PORT: '47630' }), /WB_PORT cannot be changed/);
  assert.throws(() => resolveEnv({ WB_FAKE_NOW: '2026-10-08T10:00' }), /dev env only/);
  assert.equal(resolveEnv({ WB_PORT: '47621' }).port, 47621);
  assert.equal(resolveEnv({ WB_ENV: 'dev' }).dataDir, join(REPO_ROOT, 'var', 'dev', 'data'));
  assert.equal(resolveEnv({}).dataDir, join(REPO_ROOT, 'data'));
});

test('port bind is the mutex: a second daemon of the same env exits cleanly', async (t) => {
  const tmp = makeTmpDir('mutex');
  t.after(tmp.cleanup);
  const port = 47690 + Math.floor(Math.random() * 8);
  const envVars = { ...process.env, WB_ENV: 'dev', WB_VAR_DIR: tmp.dir, WB_PORT: String(port) };
  const runDaemon = join(REPO_ROOT, 'scripts', 'run-daemon');
  const first = spawn(runDaemon, [], { env: envVars, stdio: 'ignore' });
  t.after(() => { first.kill('SIGTERM'); });
  const infoPath = join(tmp.dir, 'daemon.json');
  for (let i = 0; i < 100 && !existsSync(infoPath); i++) await new Promise((r) => setTimeout(r, 50));
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as DaemonInfo;
  const second = spawn(runDaemon, [], { env: envVars, stdio: 'ignore' });
  const code = await new Promise<number | null>((r) => second.on('exit', r));
  assert.equal(code, 0);
  assert.equal((JSON.parse(readFileSync(infoPath, 'utf8')) as DaemonInfo).pid, info.pid, 'the first daemon keeps daemon.json');
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.pid, info.pid);
  first.kill('SIGTERM');
  await new Promise((r) => first.on('exit', r));
  assert.equal(existsSync(infoPath), false, 'graceful SIGTERM removes daemon.json');
});

test('a panic pressed while the daemon was unreachable until after 04:00 is still logged once (panic + resume)', async (t) => {
  const s = await start(t);
  const stale = hb(1, { ui: { windows: [], dimmed: false, latches: { panic: true, quit: false }, panicBy: 'hotkey', panicAt: Date.UTC(2026, 9, 3, 20, 0) } });
  assert.equal((await (await s.post('/bridge/heartbeat', stale)).json()).panicExpired, true);
  await s.post('/bridge/heartbeat', { ...stale, seq: 2 });
  const types = s.daemon.store.readDay('2026-10-04').filter((r) => r.type === 'panic' || r.type === 'resume').map((r) => `${r.type}:${r.by}`);
  assert.deepEqual(types, ['panic:hotkey', 'resume:rollover']);
});

test('review M8#1: the bridge token persists across restarts (open pages keep working), 0600, regenerated if invalid', async () => {
  const { loadToken } = await import('./daemon.ts');
  const { makeTmpDir } = await import('../testing/tmp.ts');
  const { statSync, writeFileSync } = await import('node:fs');
  const tmp = makeTmpDir('token');
  try {
    const a = loadToken(tmp.dir);
    assert.match(a, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(loadToken(tmp.dir), a);
    assert.equal(statSync(`${tmp.dir}/token`).mode & 0o777, 0o600);
    writeFileSync(`${tmp.dir}/token`, 'short\n');
    const b = loadToken(tmp.dir);
    assert.notEqual(b, 'short');
    assert.match(b, /^[A-Za-z0-9_-]{32}$/);
  } finally {
    tmp.cleanup();
  }
});
