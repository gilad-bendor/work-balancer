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

async function start(t: { after(fn: () => unknown): void }) {
  const tmp = makeTmpDir('daemon');
  const env = { ...testEnv(tmp.dir), port: 0 };
  const clock = fixedClock(Date.UTC(2026, 9, 4, 10, 0));
  const daemon = (await startDaemon({ env, clock, log: silentLogger, tickMs: 60_000 }))!;
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

test('panic latch transition is logged once', async (t) => {
  const s = await start(t);
  const panic = (seq: number, on: boolean) => hb(seq, { ui: { windows: [], dimmed: false, latches: { panic: on, quit: false }, panicBy: 'cli' } });
  await s.post('/bridge/heartbeat', panic(1, true));
  await s.post('/bridge/heartbeat', panic(2, true));
  await s.post('/bridge/heartbeat', panic(3, false));
  await s.post('/bridge/heartbeat', panic(4, true));
  const panics = s.daemon.store.readDay('2026-10-04').filter((r) => r.type === 'panic');
  assert.equal(panics.length, 2);
  assert.equal(panics[0]!.by, 'cli');
});

test('WB_VAR_DIR is refused for the live env (live data must never be redirected by accident)', () => {
  assert.throws(() => resolveEnv({ WB_ENV: 'live', WB_VAR_DIR: '/x' }), /dev\/test/);
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
