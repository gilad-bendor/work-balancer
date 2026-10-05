// The daemon: binds the port (= the per-env mutex), writes var/<env>/daemon.json, serves the bridge, ticks.
// Everything here is restart-safe: state that matters is recomputed from data/ (instructions §4.2).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Clock } from '../core/clock.ts';
import type { RuntimeEnv } from '../core/env.ts';
import type { Logger } from '../core/log.ts';
import { addDays, dayKey } from '../core/time.ts';
import { createStore, type Store } from '../store/store.ts';
import { createPolicyLoader, type PolicyLoader } from '../policy/config.ts';
import { createBridgeServer, type Route } from '../bridge/server.ts';
import { parseHeartbeat, PROTOCOL_VERSION, shiftSamples, type HeartbeatReply, type SensorSamples } from '../bridge/protocol.ts';
import type { MenubarSpec, UiCommand } from '../core/effects.ts';
import { createEffectsManager, type EffectsManager } from '../effects/manager.ts';
import { createTestEffect } from '../effects/test-effect.ts';
import { DEFAULT_QUIET } from '../effects/reconcile.ts';
import { pagesRoute } from '../ui/serve.ts';
import { strings } from '../ui/strings.ts';

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
  /** Latest input instant (R-UI-QUIET); null if none known. */
  lastInputAt?(now: number): number | null;
}

export interface TrackerDeps {
  store: Store;
  clock: Clock;
  log: Logger;
  policy: PolicyLoader;
  /** This daemon's start (coverage holes that began before it are `daemon-down`/`quit` gaps). */
  startedAt: number;
  /** Home whose Copilot history is read (prompt-history). */
  copilotHome: string;
  /** Product effects register here (M8+). Optional so tests can omit it. */
  effects?: EffectsManager;
}

export interface Daemon {
  info: DaemonInfo;
  store: Store;
  effects: EffectsManager;
  server: Server;
  stop(reason: string): Promise<void>;
}

export interface DaemonOptions {
  env: RuntimeEnv;
  clock: Clock;
  log: Logger;
  createTracker?: (deps: TrackerDeps) => Tracker | Promise<Tracker>;
  tickMs?: number;
  /** Called after a /bridge/shutdown request was answered (main.ts exits the process). */
  onShutdownRequest?: () => void;
}

/** Resolves to null when another daemon of this env already owns the port. */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon | null> {
  const { env, clock, log } = opts;
  const token = loadToken(env.varDir);
  const store = createStore({ dataDir: env.dataDir, clock, log });
  const policy = createPolicyLoader({
    path: env.configPath,
    snapshotPath: join(env.varDir, 'policy.last-good.json'),
    log,
    onEvent: (e) => store.append(e.type === 'config.loaded' ? { type: e.type, hash: e.hash, source: e.source } : { type: e.type, errors: e.errors }),
  });

  let tracker: Tracker | null = null;
  const effects = createEffectsManager({
    env: env.name, store, log, now: () => clock.now(),
    gateOpen: () => env.name === 'dev' || policy.state().config?.liveEffects === true,
    lastInputAt: (now) => tracker?.lastInputAt?.(now) ?? null,
    quiet: () => {
      const q = policy.state().config?.quiet;
      return q ? { afterInputMs: q.afterInputSec * 1000, maxDeferMs: q.maxDeferSec * 1000 } : DEFAULT_QUIET;
    },
    overlayOpacity: () => policy.state().config?.overlayOpacity ?? 1,
  });
  const testEffect = createTestEffect({ env: env.name, now: () => clock.now(), log: (m, f) => log.info(m, f) });
  effects.register(testEffect.effect);
  let lastSeq: { loadId: string; seq: number } | null = null;
  let panicLatched = false;
  /** `at` of the last logged panic: an expired latch that was never logged (daemon unreachable until after 04:00)
   * is still recorded once, as panic + resume. */
  let lastLoggedPanicAt: number | null = null;
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
    return { ...spec, menu: strings.menu.map((m) => ({ ...m })), ...(w ? { warning: [spec.warning, w].filter(Boolean).join('\n') } : {}) };
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
        // Not ready: a 200 would make Lua drop samples that nobody ingested. Lua keeps its outbox and retries.
        if (!tracker) return { status: 503, json: { error: 'starting' } };
        const duplicate = lastSeq !== null && lastSeq.loadId === hb.loadId && hb.seq <= lastSeq.seq;
        if (!duplicate) {
          lastSeq = { loadId: hb.loadId, seq: hb.seq };
          lastHeartbeatAt = now;
          // Expiry first, so a stale latch is never logged as a new panic (review: panic/resume pairs after 04:00).
          const expired = hb.ui.latches.panic && hb.ui.panicAt !== null && dayKey(hb.ui.panicAt + clock.offsetMs) !== dayKey(now);
          const luaPanic = hb.ui.latches.panic && !expired;
          const logPanic = (): void => {
            store.append({ type: 'panic', by: hb.ui.panicBy ?? 'unknown', at: hb.ui.panicAt ?? now });
            lastLoggedPanicAt = hb.ui.panicAt;
          };
          if (luaPanic && !panicLatched) logPanic();
          if (expired && !panicLatched && hb.ui.panicAt !== lastLoggedPanicAt) {
            logPanic();
            store.append({ type: 'resume', by: 'rollover' });
          }
          if (!luaPanic && panicLatched) store.append({ type: 'resume', by: expired ? 'rollover' : 'cli' });
          if (expired) lastLoggedPanicAt = hb.ui.panicAt; // this latch is fully accounted for
          panicLatched = luaPanic;
          try {
            tracker?.ingest(shiftSamples(hb.samples, clock.offsetMs), now);
          } catch (e) {
            log.error('ingest failed', { error: e as Error });
          }
        }
        // The latch lasts until the next 04:00 (R-UI-ESC); Lua clears it when told so.
        const panicExpired = hb.ui.latches.panic && hb.ui.panicAt !== null && dayKey(hb.ui.panicAt + clock.offsetMs) !== dayKey(now);
        let commands: UiCommand[] = [];
        try {
          commands = effects.heartbeat({
            actual: { windows: hb.ui.windows, dimmed: hb.ui.dimmed, closed: hb.ui.closed }, acks: hb.acks,
            panic: hb.ui.latches.panic && !panicExpired, now,
          });
        } catch (e) {
          // Fail open: no commands this beat (Lua keeps what it has; a broken reconciler never blocks the heartbeat).
          log.error('effects reconcile failed', { error: e as Error });
        }
        const reply: HeartbeatReply = { protocol: PROTOCOL_VERSION, serverNow: now, dayKey: dayKey(now), menubar: menubar(now), commands, duplicate, panicExpired };
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
            effects: effects.status(now),
            tracker: tracker?.status(now) ?? null,
          },
        };
      },
    },
    {
      method: 'POST', path: '/bridge/shutdown', auth: true,
      handle: ({ body }) => {
        const b = (body && typeof body === 'object' ? body : {}) as { reason?: unknown; by?: unknown };
        const reason = typeof b.reason === 'string' ? b.reason : 'requested';
        // R-UI-MENU-3: an intentional stop is logged (the gap that follows is a `quit` gap).
        if (reason === 'quit') store.append({ type: 'app.quit', by: b.by === 'menu' ? 'menu' : 'cli' });
        setTimeout(() => void daemon.stop(reason).then(() => opts.onShutdownRequest?.()), 50);
        return { json: { ok: true } };
      },
    },
    pagesRoute(),
    ...effects.routes(),
    ...testEffect.routes,
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
  // Latest panic state (yesterday + today: a panic from last night is still latched until its rollover is logged),
  // so a restart neither re-logs an active panic nor misses its resume.
  const today = dayKey(clock.now());
  for (const r of store.readDays(addDays(today, -1), today)) {
    if (r.type === 'panic') {
      panicLatched = true;
      lastLoggedPanicAt = typeof r.at === 'number' ? r.at : null;
    }
    else if (r.type === 'resume') panicLatched = false;
  }
  tracker = (await opts.createTracker?.({ store, clock, log, policy, startedAt, copilotHome: env.copilotHome, effects })) ?? null;
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
    effects,
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

/**
 * The bridge token persists in var/<env>/token (0600) across daemon restarts: pages carry it in their URL, so a window
 * the owner kept open across a restart (adopted, maybe mid-typing) must still be able to save (review M8#1).
 */
export function loadToken(varDir: string): string {
  const path = join(varDir, 'token');
  try {
    const t = readFileSync(path, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32}$/.test(t)) return t;
  } catch {
    // first start
  }
  const t = randomBytes(24).toString('base64url');
  mkdirSync(varDir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, t + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return t;
}
