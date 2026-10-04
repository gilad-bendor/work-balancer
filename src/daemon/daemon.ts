// The daemon: binds the port (= the per-env mutex), writes var/<env>/daemon.json, serves the bridge, ticks.
// Everything here is restart-safe: state that matters is recomputed from data/ (instructions §4.2).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Clock } from '../core/clock.ts';
import type { RuntimeEnv } from '../core/env.ts';
import type { Logger } from '../core/log.ts';
import { dayKey } from '../core/time.ts';
import { createStore, type Store } from '../store/store.ts';
import { createPolicyLoader, type PolicyLoader } from '../policy/config.ts';
import { createBridgeServer, type Route } from '../bridge/server.ts';
import { parseHeartbeat, PROTOCOL_VERSION, shiftSamples, type HeartbeatReply, type SensorSamples } from '../bridge/protocol.ts';
import type { MenubarSpec } from '../core/effects.ts';

export const DAEMON_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  protocol: number;
  version: string;
  env: string;
  repo: string;
  startedAt: number;
}

/** What M4+ plug in: ingest sensor samples, tick, and describe the status for the menubar / API. */
export interface Tracker {
  ingest(samples: SensorSamples, receivedAt: number): void;
  tick(now: number): void;
  menubar(now: number): MenubarSpec;
  status(now: number): unknown;
  /** Called once on graceful stop (flush pending minutes). */
  flush(now: number): void;
}

export interface TrackerDeps {
  store: Store;
  clock: Clock;
  log: Logger;
  policy: PolicyLoader;
  /** Last heartbeat time of the previous daemon run, if known (for gap detection). */
  startedAt: number;
}

export interface Daemon {
  info: DaemonInfo;
  store: Store;
  server: Server;
  stop(reason: string): Promise<void>;
}

export interface DaemonOptions {
  env: RuntimeEnv;
  clock: Clock;
  log: Logger;
  createTracker?: (deps: TrackerDeps) => Tracker;
  tickMs?: number;
  /** Called after a /bridge/shutdown request was answered (main.ts exits the process). */
  onShutdownRequest?: () => void;
}

/** Resolves to null when another daemon of this env already owns the port. */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon | null> {
  const { env, clock, log } = opts;
  const token = randomBytes(24).toString('base64url');
  const store = createStore({ dataDir: env.dataDir, clock, log });
  const policy = createPolicyLoader({
    path: env.configPath,
    snapshotPath: join(env.varDir, 'policy.last-good.json'),
    log,
    onEvent: (e) => store.append(e.type === 'config.loaded' ? { type: e.type, hash: e.hash, source: e.source } : { type: e.type, errors: e.errors }),
  });

  let tracker: Tracker | null = null;
  let lastSeq: { loadId: string; seq: number } | null = null;
  let panicLatched = false;
  let lastHeartbeatAt: number | null = null;

  const fallbackMenubar = (): MenubarSpec => ({ title: '⏱', colour: 'none', tooltip: 'work-balancer: observing', warning: null });
  const warnings = (): string | null => {
    const w: string[] = [];
    const c = policy.state();
    if (c.errors.length) w.push(c.config ? `Policy file has errors — using the ${c.source === 'snapshot' ? 'last good' : 'previous'} policy.` : 'Policy file has errors — tracking only.');
    const se = store.health().writeError;
    if (se) w.push(`Cannot write data: ${se}`);
    return w.length ? w.join('\n') : null;
  };
  const menubar = (now: number): MenubarSpec => {
    let spec: MenubarSpec;
    try {
      spec = tracker ? tracker.menubar(now) : fallbackMenubar();
    } catch (e) {
      log.error('menubar computation failed', { error: e as Error });
      spec = { ...fallbackMenubar(), warning: 'internal error (see daemon log)' };
    }
    const w = warnings();
    return w ? { ...spec, warning: [spec.warning, w].filter(Boolean).join('\n') } : spec;
  };

  const routes: Route[] = [
    {
      method: 'GET', path: '/health', auth: false,
      handle: () => ({ json: { ok: true, env: env.name, version: DAEMON_VERSION, protocol: PROTOCOL_VERSION, pid: process.pid } }),
    },
    {
      method: 'POST', path: '/bridge/heartbeat', auth: true,
      handle: ({ body }) => {
        const now = clock.now();
        let hb;
        try {
          hb = parseHeartbeat(body);
        } catch (e) {
          return { status: 400, json: { error: (e as Error).message } };
        }
        if (hb.protocol !== PROTOCOL_VERSION) return { status: 409, json: { error: 'protocol mismatch', protocol: PROTOCOL_VERSION } };
        const duplicate = lastSeq !== null && lastSeq.loadId === hb.loadId && hb.seq <= lastSeq.seq;
        if (!duplicate) {
          lastSeq = { loadId: hb.loadId, seq: hb.seq };
          lastHeartbeatAt = now;
          if (hb.ui.latches.panic && !panicLatched) store.append({ type: 'panic', by: hb.ui.panicBy ?? 'unknown' });
          panicLatched = hb.ui.latches.panic;
          try {
            tracker?.ingest(shiftSamples(hb.samples, clock.offsetMs), now);
          } catch (e) {
            log.error('ingest failed', { error: e as Error });
          }
        }
        const reply: HeartbeatReply = { protocol: PROTOCOL_VERSION, serverNow: now, dayKey: dayKey(now), menubar: menubar(now), commands: [], duplicate };
        return { json: reply };
      },
    },
    {
      method: 'GET', path: '/api/status', auth: true,
      handle: () => {
        const now = clock.now();
        return {
          json: {
            env: env.name, version: DAEMON_VERSION, pid: process.pid, now, dayKey: dayKey(now), lastHeartbeatAt, panic: panicLatched,
            policy: { source: policy.state().source, hash: policy.state().hash, errors: policy.state().errors },
            menubar: menubar(now),
            tracker: tracker?.status(now) ?? null,
          },
        };
      },
    },
    {
      method: 'POST', path: '/bridge/shutdown', auth: true,
      handle: ({ body }) => {
        const reason = body && typeof body === 'object' && typeof (body as { reason?: unknown }).reason === 'string' ? (body as { reason: string }).reason : 'requested';
        setTimeout(() => void daemon.stop(reason).then(() => opts.onShutdownRequest?.()), 50);
        return { json: { ok: true } };
      },
    },
  ];

  const server = createBridgeServer({ token, log, routes });
  const bound = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve(false) : reject(e)));
    server.listen(env.port, '127.0.0.1', () => resolve(true));
  });
  if (!bound) {
    log.info('another daemon already owns the port; exiting', { port: env.port });
    return null;
  }
  const port = (server.address() as { port: number }).port;

  const startedAt = clock.now();
  const info: DaemonInfo = { pid: process.pid, port, token, protocol: PROTOCOL_VERSION, version: DAEMON_VERSION, env: env.name, repo: env.repoRoot, startedAt };
  const infoPath = join(env.varDir, 'daemon.json');
  mkdirSync(env.varDir, { recursive: true });
  const tmp = `${infoPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, infoPath);

  store.append({ type: 'daemon.started', pid: process.pid, version: DAEMON_VERSION, env: env.name, reason: 'start' });
  await policy.refresh();
  tracker = opts.createTracker?.({ store, clock, log, policy, startedAt }) ?? null;
  log.info('daemon started', { env: env.name, port, pid: process.pid, dataDir: env.dataDir });

  const tick = async (): Promise<void> => {
    try {
      await policy.refresh();
      tracker?.tick(clock.now());
    } catch (e) {
      log.error('tick failed', { error: e as Error });
    }
  };
  const timer = setInterval(() => void tick(), opts.tickMs ?? 5000);

  let stopped = false;
  const daemon: Daemon = {
    info,
    store,
    server,
    async stop(reason) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        tracker?.flush(clock.now());
      } catch (e) {
        log.error('flush failed', { error: e as Error });
      }
      store.append({ type: 'daemon.stopped', pid: process.pid, reason });
      try {
        const current = JSON.parse(readFileSync(infoPath, 'utf8')) as DaemonInfo;
        if (current.pid === process.pid && current.token === token) rmSync(infoPath, { force: true });
      } catch {
        // already gone
      }
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      log.info('daemon stopped', { reason });
    },
  };
  return daemon;
}
