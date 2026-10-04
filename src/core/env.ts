// Runtime environment: which instance (live/dev), its port and its namespaced paths (instructions §4.4, §6).
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
}

export const DEFAULT_PORTS: Record<EnvName, number> = { live: 47621, dev: 47622 };

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export function resolveEnv(env: NodeJS.ProcessEnv, repoRoot: string = REPO_ROOT): RuntimeEnv {
  const raw = (env.WB_ENV ?? 'live').trim();
  if (raw !== 'live' && raw !== 'dev') throw new Error(`WB_ENV must be "live" or "dev", got ${JSON.stringify(raw)}`);
  const name: EnvName = raw;
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
  };
}
