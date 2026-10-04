// Daemon log → <logDir>/daemon-<dayKey>.log (+ stderr when asked). Logging must never throw.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from './clock.ts';
import { dayKey } from './time.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: { dir: string | null; clock: Clock; stderr?: boolean; debug?: boolean }): Logger {
  let dirReady = false;
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (level === 'debug' && !opts.debug) return;
    const now = opts.clock.now();
    const line = `${new Date(now).toISOString()} ${level.toUpperCase()} ${msg}${fields ? ' ' + safeJson(fields) : ''}\n`;
    if (opts.stderr) process.stderr.write(line);
    if (!opts.dir) return;
    try {
      if (!dirReady) {
        mkdirSync(opts.dir, { recursive: true });
        dirReady = true;
      }
      appendFileSync(join(opts.dir, `daemon-${dayKey(now)}.log`), line);
    } catch {
      // A log failure must never take the daemon down; stderr (when enabled) still has it.
    }
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Error ? { message: x.message, stack: x.stack } : x));
  } catch {
    return String(v);
  }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
