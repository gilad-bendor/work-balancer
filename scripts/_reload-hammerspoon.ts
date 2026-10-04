// Logic of scripts/reload-hammerspoon (spec: .github/ledger.md §3 M1).
// Installs the work-balancer Hammerspoon module (symlink + one `require` line) and reloads Hammerspoon.
// The pure / filesystem helpers are exported for tests; the CLI runs only when this is the main module.
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export const REQUIRE_LINE = 'require("work-balancer")';
export const MODULE_FILE = 'work-balancer.lua';
const REQUIRE_RE = /^\s*require\s*\(\s*(["'])work-balancer\1\s*\)\s*;?\s*$/;

// ───────────────────────────── init.lua ─────────────────────────────

export interface NormaliseResult {
  text: string;
  changed: boolean;
  /** Number of detected require-lines in the input. */
  matches: number;
  added: boolean;
  /** The kept line was rewritten to the canonical form. */
  normalised: boolean;
  /** Number of duplicate lines dropped. */
  removed: number;
}

/** Make `text` contain exactly one canonical require line; every other line stays byte-identical. */
export function normaliseInitLua(text: string): NormaliseResult {
  const segments = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let matches = 0;
  let normalised = false;
  let removed = 0;
  for (const seg of segments) {
    const body = seg.replace(/\r?\n$/, '');
    if (!REQUIRE_RE.test(body)) {
      out.push(seg);
      continue;
    }
    matches++;
    if (matches > 1) {
      removed++;
      continue;
    }
    const eol = seg.slice(body.length);
    if (body === REQUIRE_LINE) {
      out.push(seg);
    } else {
      normalised = true;
      out.push(REQUIRE_LINE + eol);
    }
  }
  let result = out.join('');
  let added = false;
  if (matches === 0) {
    added = true;
    if (result !== '' && !result.endsWith('\n')) result += '\n';
    result += REQUIRE_LINE + '\n';
  }
  return { text: result, changed: result !== text, matches, added, normalised, removed };
}

export interface InitLuaResult {
  path: string;
  /** init.lua did not exist. */
  created: boolean;
  changed: boolean;
  backupPath: string | null;
  detail: NormaliseResult;
}

/** Ensure `<dir>/init.lua` holds exactly one canonical require line. `dryRun` reports without writing. */
export function ensureInitLua(
  dir: string,
  opts: { dryRun?: boolean; now?: () => number } = {},
): InitLuaResult {
  const path = join(dir, 'init.lua');
  let original = '';
  let created = false;
  try {
    original = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    created = true;
  }
  const detail = normaliseInitLua(original);
  let backupPath: string | null = null;
  if (detail.changed && !opts.dryRun) {
    if (!created) backupPath = writeBackup(path, (opts.now ?? Date.now)());
    writeFileSync(path, detail.text);
  }
  return { path, created, changed: detail.changed, backupPath, detail };
}

function writeBackup(path: string, epochMs: number): string {
  for (let ms = epochMs; ; ms++) {
    const backup = `${path}.bak.${ms}`;
    try {
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
      return backup;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

// ───────────────────────────── symlink ─────────────────────────────

export type SymlinkState = 'ok' | 'missing' | 'wrong' | 'conflict';

export interface SymlinkInspection {
  path: string;
  state: SymlinkState;
  /** Raw readlink value, for `wrong`. */
  oldTarget?: string;
  /** What is in the way, for `conflict`. */
  kind?: 'file' | 'directory' | 'other';
}

function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function inspectSymlink(dir: string, target: string): SymlinkInspection {
  const path = join(dir, MODULE_FILE);
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { path, state: 'missing' };
    throw e;
  }
  if (!st.isSymbolicLink()) {
    return { path, state: 'conflict', kind: st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other' };
  }
  const oldTarget = readlinkSync(path);
  return sameFile(resolve(dir, oldTarget), target) ? { path, state: 'ok' } : { path, state: 'wrong', oldTarget };
}

export interface SymlinkResult extends SymlinkInspection {
  changed: boolean;
}

/** Ensure `<dir>/work-balancer.lua` is a symlink to `target`. Never clobbers a regular file (state `conflict`). */
export function ensureSymlink(dir: string, target: string): SymlinkResult {
  const inspection = inspectSymlink(dir, target);
  if (inspection.state === 'ok' || inspection.state === 'conflict') {
    return { ...inspection, changed: false };
  }
  const tmp = `${inspection.path}.tmp-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    // no stale temp link
  }
  symlinkSync(target, tmp);
  renameSync(tmp, inspection.path);
  return { ...inspection, changed: true };
}

// ───────────────────────────── Hammerspoon CLI ─────────────────────────────

export interface HsReply {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `hs <args>`. Injectable so the reload orchestration is testable without a live Hammerspoon. */
export type HsRunner = (args: string[], timeoutMs?: number) => HsReply;

export function findHs(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'hs')),
    '/opt/homebrew/bin/hs',
    '/usr/local/bin/hs',
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function makeHsRunner(hsPath: string): HsRunner {
  return (args, timeoutMs = 8000) => {
    const r = spawnSync(hsPath, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

export const RELOAD_COMMAND = 'hs.timer.doAfter(0.2, hs.reload)';
// Set before the reload: the fresh Lua state after the reload has no such global, so an `ok` that is
// answered by the old instance (before the reload actually happened) is never mistaken for success.
const MARK_COMMAND = '_WB_RELOAD_PENDING = true';
export const HEALTH_COMMAND =
  'return _WB_RELOAD_PENDING and "reloading" or (WorkBalancer and WorkBalancer.health() or "missing")';

export function hsResponds(hs: HsRunner): boolean {
  const r = hs(['-t', '2', '-c', 'return 1'], 6000);
  return r.status === 0 && r.stdout.trim() === '1';
}

// getConsole() returns an hs.styledtext (plain `hs` output would print its address); :string() is the text.
export const CONSOLE_COMMAND = 'local c = hs.console.getConsole(); return type(c) == "string" and c or c:string()';

export function consoleTail(hs: HsRunner, lines = 40): string {
  const r = hs(['-t', '5', '-c', CONSOLE_COMMAND], 10000);
  if (r.status !== 0) return `(could not read the Hammerspoon console: ${(r.stderr || r.stdout).trim()})`;
  return r.stdout.trimEnd().split('\n').slice(-lines).join('\n');
}

export interface ReloadOutcome {
  ok: boolean;
  /** Last health reply (or error text). */
  health: string;
}

export async function reloadAndVerify(
  hs: HsRunner,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<ReloadOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  hs(['-t', '2', '-c', MARK_COMMAND]);
  const reload = hs(['-c', RELOAD_COMMAND]);
  if (reload.status !== 0) {
    return { ok: false, health: `could not request the reload: ${(reload.stderr || reload.stdout).trim()}` };
  }
  const deadline = now() + timeoutMs;
  let health = 'no reply';
  do {
    await sleep(pollMs);
    const r = hs(['-t', '2', '-c', HEALTH_COMMAND]);
    health = r.status === 0 ? r.stdout.trim() : (r.stderr || r.stdout).trim() || `hs exited ${r.status}`;
    if (r.status === 0 && health.startsWith('ok')) return { ok: true, health };
  } while (now() < deadline);
  return { ok: false, health };
}

// ───────────────────────────── CLI ─────────────────────────────

const USAGE = `Usage: scripts/reload-hammerspoon [options]

Installs the work-balancer Hammerspoon module and reloads Hammerspoon:
  1. ~/.hammerspoon/work-balancer.lua  ->  symlink to <repo>/hammerspoon/work-balancer.lua
     (a regular file there is never overwritten: the script refuses)
  2. ~/.hammerspoon/init.lua contains exactly one line  ${REQUIRE_LINE}
     (a backup init.lua.bak.<epochMs> is written before any change)
  3. Hammerspoon is running and the \`hs\` CLI answers
  4. Hammerspoon is reloaded and WorkBalancer.health() answers "ok ..." (timeout ~15 s)
Idempotent: a second run changes nothing. Exit code 0 = healthy, non-zero = failure.

Options:
  --check                    Read-only: report the symlink and the init.lua line; exit 1 if not installed.
  --hammerspoon-dir <dir>    Operate on <dir> instead of ~/.hammerspoon (implies no reload; for tests).
  --quiet                    Print only warnings and errors.
  --help                     This help.
`;

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

function makeLogger(quiet: boolean): Logger {
  return {
    info: (msg) => {
      if (!quiet) console.log(msg);
    },
    error: (msg) => console.error(msg),
  };
}

export function repoRoot(): string {
  return realpathSync(resolve(import.meta.dirname, '..'));
}

function describeInit(r: InitLuaResult): string {
  const d = r.detail;
  const parts: string[] = [];
  if (d.added) parts.push(`add ${REQUIRE_LINE}`);
  if (d.normalised) parts.push('normalise the require line');
  if (d.removed > 0) parts.push(`remove ${d.removed} duplicate line${d.removed > 1 ? 's' : ''}`);
  return parts.join(', ');
}

function conflictMessage(s: SymlinkInspection): string {
  return (
    `refusing: ${s.path} is a ${s.kind}, not a symlink. Move it away yourself (it is not ours to delete), ` +
    `then re-run.`
  );
}

/** `--check`: read-only report. Returns true when fully installed. */
export function checkInstall(dir: string, target: string, log: Logger): boolean {
  let ok = true;
  if (!existsSync(dir)) {
    log.error(`not installed: ${dir} does not exist`);
    return false;
  }
  const s = inspectSymlink(dir, target);
  if (s.state === 'ok') log.info(`symlink ok: ${s.path} -> ${target}`);
  else {
    ok = false;
    if (s.state === 'missing') log.error(`not installed: ${s.path} is missing (should link to ${target})`);
    else if (s.state === 'wrong') log.error(`wrong symlink: ${s.path} -> ${s.oldTarget} (should be ${target})`);
    else log.error(conflictMessage(s));
  }
  const init = ensureInitLua(dir, { dryRun: true });
  if (!init.changed) log.info(`init.lua ok: exactly one ${REQUIRE_LINE}`);
  else {
    ok = false;
    log.error(`init.lua needs a change: ${describeInit(init)}${init.created ? ' (file does not exist)' : ''}`);
  }
  return ok;
}

/** Ensure files, returns false on a refusal. */
export function installFiles(dir: string, target: string, log: Logger): boolean {
  if (!existsSync(target)) {
    log.error(`error: ${target} does not exist (nothing to link to)`);
    return false;
  }
  mkdirSync(dir, { recursive: true });
  const s = ensureSymlink(dir, target);
  if (s.state === 'conflict') {
    log.error(conflictMessage(s));
    return false;
  }
  if (s.changed) {
    log.info(
      s.state === 'wrong'
        ? `fixed symlink ${s.path}: was -> ${s.oldTarget}, now -> ${target}`
        : `created symlink ${s.path} -> ${target}`,
    );
  } else log.info(`symlink ok: ${s.path}`);

  const init = ensureInitLua(dir);
  if (init.changed) {
    log.info(
      `updated ${init.path}: ${describeInit(init)}` +
        (init.backupPath ? ` (backup: ${init.backupPath})` : init.created ? ' (new file)' : ''),
    );
  } else log.info(`init.lua ok: exactly one ${REQUIRE_LINE}`);
  return true;
}

async function reloadHammerspoon(hs: HsRunner, log: Logger): Promise<boolean> {
  let launched = false;
  if (spawnSync('pgrep', ['-x', 'Hammerspoon']).status !== 0) {
    log.info('Hammerspoon is not running — starting it');
    spawnSync('open', ['-g', '-a', 'Hammerspoon']);
    launched = true;
  }
  const deadline = Date.now() + (launched ? 15_000 : 0);
  while (!hsResponds(hs)) {
    if (Date.now() >= deadline) {
      log.error(
        'error: the `hs` CLI does not answer. work-balancer.lua loads hs.ipc itself, but the very first load ' +
          'needs a manual one: click the Hammerspoon menubar icon -> "Reload Config" (or restart Hammerspoon), ' +
          'then re-run this script. The files are already in place.',
      );
      return false;
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  log.info('reloading Hammerspoon…');
  const outcome = await reloadAndVerify(hs);
  if (outcome.ok) {
    log.info(`Hammerspoon reloaded; WorkBalancer: ${outcome.health}`);
    return true;
  }
  log.error(`error: Hammerspoon did not become healthy within 15 s (last reply: ${outcome.health})`);
  log.error('--- Hammerspoon console (tail) ---');
  log.error(consoleTail(hs));
  log.error('--- end of console ---');
  return false;
}

export async function main(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        check: { type: 'boolean' },
        'hammerspoon-dir': { type: 'string' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const log = makeLogger(values.quiet === true);
  const customDir = values['hammerspoon-dir'];
  const dir = resolve(customDir ?? join(homedir(), '.hammerspoon'));
  const target = join(repoRoot(), 'hammerspoon', MODULE_FILE);

  if (values.check) return checkInstall(dir, target, log) ? 0 : 1;
  if (!installFiles(dir, target, log)) return 1;
  if (customDir !== undefined) return 0;

  const hsPath = findHs();
  if (hsPath === null) {
    log.error('error: the `hs` CLI was not found (expected /opt/homebrew/bin/hs). Is Hammerspoon installed?');
    return 1;
  }
  return (await reloadHammerspoon(makeHsRunner(hsPath), log)) ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
