// Runtime environment: which instance (live/dev), its port and its namespaced paths (instructions §4.4, §6).
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type EnvName = 'live' | 'dev';

export interface RuntimeEnv {
  name: EnvName;
  repoRoot: string;
  port: number;
  /** var/<env>/ — daemon.json, logs, snapshots, cursors. */
  varDir: string;
  logDir: string;
  /** The owner's data/ for live; var/dev/data/ for dev — dev never writes to data/. */
  dataDir: string;
  configPath: string;
  /** Home whose Copilot history (~/.copilot, ~/Library/Application Support/Code) the prompt-history provider reads. */
  copilotHome: string;
}

export const DEFAULT_PORTS: Record<EnvName, number> = { live: 47621, dev: 47622 };

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export function resolveEnv(env: NodeJS.ProcessEnv, repoRoot: string = REPO_ROOT): RuntimeEnv {
  const raw = (env.WB_ENV ?? 'live').trim();
  if (raw !== 'live' && raw !== 'dev') throw new Error(`WB_ENV must be "live" or "dev", got ${JSON.stringify(raw)}`);
  const name: EnvName = raw;
  // The live instance writes the owner's data/: no knobs that could make a second, misconfigured live daemon
  // (its own port → no mutex; a fake clock → fake timestamps in append-only data).
  if (name === 'live' && env.WB_PORT && Number(env.WB_PORT) !== DEFAULT_PORTS.live) throw new Error('WB_PORT cannot be changed for the live env (use WB_ENV=dev)');
  if (name === 'live' && env.WB_FAKE_NOW) throw new Error('WB_FAKE_NOW is for the dev env only');
  if (name === 'live' && env.WB_COPILOT_HOME) throw new Error('WB_COPILOT_HOME is for the dev env only');
  const port = env.WB_PORT ? Number(env.WB_PORT) : DEFAULT_PORTS[name];
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`WB_PORT invalid: ${env.WB_PORT}`);
  if (env.WB_VAR_DIR && name === 'live') throw new Error('WB_VAR_DIR is for dev/test instances only');
  // WB_VAR_DIR: tests only — isolates a spawned daemon's runtime files (and, for dev, its data).
  const varDir = env.WB_VAR_DIR ? resolve(env.WB_VAR_DIR) : join(repoRoot, 'var', name);
  return {
    name,
    repoRoot,
    port,
    varDir,
    logDir: join(varDir, 'logs'),
    dataDir: name === 'live' ? join(repoRoot, 'data') : join(varDir, 'data'),
    configPath: join(repoRoot, 'config', 'policy.ts'),
    copilotHome: env.WB_COPILOT_HOME ? resolve(env.WB_COPILOT_HOME) : homedir(),
  };
}
