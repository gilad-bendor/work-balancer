// Test scratch dirs live under var/test/ (gitignored) — never /tmp, never data/.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../core/env.ts';

export function makeTmpDir(prefix: string): { dir: string; cleanup(): void } {
  const base = join(REPO_ROOT, 'var', 'test');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Local civil time → epoch ms (in the process TZ). Month is 1-based. */
export function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}
