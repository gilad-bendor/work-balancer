// Daemon entry point (scripts/run-daemon). Env: WB_ENV (live|dev), WB_PORT, WB_FAKE_NOW, WB_VAR_DIR (tests).
import { clockFromEnv } from './core/clock.ts';
import { resolveEnv } from './core/env.ts';
import { createLogger } from './core/log.ts';
import { startDaemon } from './daemon/daemon.ts';
import { createTracker } from './daemon/tracker.ts';

const env = resolveEnv(process.env);
const clock = clockFromEnv(process.env);
const log = createLogger({ dir: env.logDir, clock, stderr: env.name === 'dev' || process.stderr.isTTY, debug: !!process.env.WB_DEBUG });

process.on('uncaughtException', (e) => {
  log.error('uncaught exception — exiting so the supervisor restarts a clean daemon', { error: e });
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log.error('unhandled rejection — exiting so the supervisor restarts a clean daemon', { error: e as Error });
  process.exit(1);
});

const daemon = await startDaemon({ env, clock, log, createTracker, onShutdownRequest: () => process.exit(0) });
if (!daemon) process.exit(0);

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    void daemon.stop(sig).finally(() => process.exit(0));
  });
}
