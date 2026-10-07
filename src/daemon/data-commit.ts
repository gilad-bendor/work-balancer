// Auto-commit of settled data/ day files (ledger D-72). Once per day (the first eligible daemon tick of each 04:00
// day — start, 04:00 or the first tick after a wake), on `main` only, it commits day files that are new/changed and
// were last modified before yesterday's start, plus deleted day files — amending HEAD when HEAD is itself a pure data/
// commit, always with one constant message — then pushes that one commit with `--force-with-lease` (owner's choice).
// Only those paths: `git commit --only` leaves the owner's other staged/unstaged work untouched. Live env only.
// Failure never affects tracking; it is retried and surfaced.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Logger } from '../core/log.ts';
import { addDays, dayKey, dayStart, type DayKey } from '../core/time.ts';

/** Runs git with `args` in `cwd`; resolves with stdout, rejects on a non-zero exit. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export interface DataCommitDeps {
  repoRoot: string;
  dataDir: string;
  log: Logger;
  git?: GitRunner;
  /** Delay after a failure or a skip (operation in progress, detached HEAD) before the next attempt. */
  retryMs?: number;
  /** No attempt before this time (lets the daemon finish starting). */
  notBefore?: number;
  /** The only branch commits are made on (default `main`). */
  branch?: string;
}

export type DataCommitResult =
  | { kind: 'committed'; changed: DayKey[]; deleted: DayKey[]; amended: boolean; pushed: boolean; pushSkipped?: string }
  | { kind: 'pushed' }
  | { kind: 'nothing' }
  | { kind: 'skipped'; reason: string };

export interface DataCommit {
  /** Called on every daemon tick; starts at most one attempt (async, never throws). */
  tick(now: number): void;
  /** One attempt now (tests, manual use). Rejects on a git failure. */
  run(now: number): Promise<DataCommitResult>;
  /** Menubar warning text after repeated failures or held-back bulk deletions, else null. */
  warning(): string | null;
}

export interface StatusEntry { code: string; path: string }

const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer'];
const WARN_AFTER_FAILURES = 3;
/** More deleted day files than this in one run are never auto-committed: a moved-away or lost data/ (the store
 * recreates today's file within a minute) must not become "delete every day file", amended and force-pushed. */
export const MAX_AUTO_DELETIONS = 2;

export const defaultGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      // Never prompt (credentials, editors) and never take optional locks that could collide with the owner's git.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'true', LC_ALL: 'C' },
    }, (error, stdout, stderr) => (error ? reject(new Error(`git ${args[0]}: ${(stderr || error.message).trim()}`)) : resolve(stdout)));
  });

/** `git status --porcelain=v1 -z --no-renames` output → entries (paths are repo-relative, `/`-separated). */
export function parseStatusZ(out: string): StatusEntry[] {
  return out.split('\0').filter((s) => s.length > 3).map((s) => ({ code: s.slice(0, 2), path: s.slice(3) }));
}

/** Day key of a repo-relative day-file path under `dataRel` (`data/YYYY-MM/YYYY-MM-DD.jsonl`), else null. */
export function dayOfPath(path: string, dataRel: string): DayKey | null {
  const m = /^(\d{4}-\d{2})\/((\d{4}-\d{2})-\d{2})\.jsonl$/.exec(path.startsWith(dataRel + '/') ? path.slice(dataRel.length + 1) : '');
  return m && m[1] === m[3] ? m[2]! : null;
}

/**
 * Which status entries to commit. An existing day file qualifies when it was last modified before `cutoff` (it is
 * settled: no late record has touched it since); a committed day file missing from the working tree is a deletion.
 */
export function selectPaths(entries: readonly StatusEntry[], dataRel: string, cutoff: number, mtimeOf: (path: string) => number | null, inHead: ReadonlySet<string>): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const e of entries) {
    if (!dayOfPath(e.path, dataRel)) continue;
    const mtime = mtimeOf(e.path);
    if (mtime === null) {
      if (inHead.has(e.path)) deleted.push(e.path); // else staged-then-deleted (`AD`): nothing to commit
    }
    else if (mtime < cutoff) changed.push(e.path);
  }
  return { changed: [...new Set(changed)].sort(), deleted: [...new Set(deleted)].sort() };
}

export const COMMIT_MESSAGE = 'data: auto-commit day files';

/**
 * Deletions that look like a lost/moved data/ rather than a deliberate prune of a day or two: more than
 * MAX_AUTO_DELETIONS, or emptying a whole month folder of HEAD (catches small totals), or any deletion while an
 * earlier hold is still unresolved (a partial restore must not release the rest).
 */
export function isBulkDeletion(deleted: readonly string[], inHead: ReadonlySet<string>, dataRel: string, wasHeld: boolean): boolean {
  if (!deleted.length) return false;
  if (wasHeld || deleted.length > MAX_AUTO_DELETIONS) return true;
  const month = (p: string): string => p.split('/').at(-2) ?? '';
  const gone = new Set(deleted);
  const headDays = [...inHead].filter((p) => dayOfPath(p, dataRel) !== null);
  // Deleted paths are always in HEAD, so each of their months has at least one day file there.
  return [...new Set(deleted.map(month))].some((m) => headDays.filter((p) => month(p) === m).every((p) => gone.has(p)));
}

export function createDataCommit(deps: DataCommitDeps): DataCommit {
  const git = deps.git ?? defaultGit;
  const retryMs = deps.retryMs ?? 15 * 60_000;
  const branch = deps.branch ?? 'main';
  const { repoRoot, log } = deps;
  let doneDay: DayKey | null = null;
  let running = false;
  let nextAttemptAt = deps.notBefore ?? 0;
  let failures = 0;
  /** Deletions held back by the last completed run (MAX_AUTO_DELETIONS). */
  let heldDeletions = 0;
  /** Committed day files the last completed run held back because they are not an append to HEAD's version. */
  let heldRewrites = 0;

  const lines = (out: string): string[] => out.split('\n').filter(Boolean);

  /** `rev` is a single-parent commit that changes only files under data/ (any message: the owner's data commits too),
   * or our own auto-commit emptied by an amend that cancelled out. */
  async function isPureData(top: string, dataRel: string, rev: string): Promise<boolean> {
    if ((await git(['rev-list', '--parents', '-n', '1', rev], top)).trim().split(' ').length !== 2) return false;
    const files = lines(await git(['diff-tree', '--no-commit-id', '--name-only', '-r', rev], top));
    if (files.length === 0) return (await git(['log', '-1', '--format=%s', rev], top)).trim() === COMMIT_MESSAGE;
    return files.every((f) => f.startsWith(dataRel + '/'));
  }
  const rev = async (top: string, r: string): Promise<string> => (await git(['rev-parse', '--verify', '-q', r], top)).trim();

  /**
   * Pushes only our data commit, never other local history (review D-72): `main` must be our commit on top of the
   * upstream tip (a fast-forward), or replace an upstream pure-data tip with the same parent (an amend). Explicit
   * source, destination and lease, so neither push.default nor the reflog matter; a stale tracking ref fails the lease.
   * Returns null when pushed or nothing to push, else why it was not pushed.
   */
  async function pushDataCommit(top: string, dataRel: string): Promise<string | null> {
    const remote = (await git(['config', `branch.${branch}.remote`], top).catch(() => '')).trim();
    const merge = (await git(['config', `branch.${branch}.merge`], top).catch(() => '')).trim();
    if (!remote || remote === '.' || !merge) return `${branch} has no remote upstream`;
    const head = await rev(top, `refs/heads/${branch}`);
    const up = await rev(top, `${branch}@{upstream}`).catch(() => '');
    if (!up) return 'upstream not fetched yet';
    if (head === up) return null;
    // The exact sha pushed must itself be a data commit (someone may have committed on top since `run` checked).
    if (!(await isPureData(top, dataRel, head))) return `${branch} tip ${head.slice(0, 8)} is not a data commit`;
    const parent = await rev(top, `${head}^`).catch(() => '');
    const fastForward = parent === up;
    const replaces = !fastForward && await isPureData(top, dataRel, up) && await rev(top, `${up}^`) === parent;
    if (!fastForward && !replaces) return `${branch} is not exactly one data commit ahead of / replacing ${up.slice(0, 8)}`;
    await git(['push', '-q', `--force-with-lease=${merge}:${up}`, remote, `${head}:${merge}`], top);
    return null;
  }

  async function run(now: number): Promise<DataCommitResult> {
    const [top = '', gitDir = ''] = lines(await git(['rev-parse', '--show-toplevel', '--absolute-git-dir'], repoRoot));
    // Via the repo root, not realpath(dataDir), which throws when data/ is missing (skipped below).
    const dataReal = join(realpathSync(repoRoot), relative(repoRoot, deps.dataDir));
    const dataRel = relative(realpathSync(top), dataReal).split(sep).join('/');
    if (!dataRel || dataRel.startsWith('..')) return { kind: 'skipped', reason: `data dir is not inside the repo ${top}` };
    // A missing data/ is almost surely transient (moved away by hand or a session): never commit "delete everything".
    if (!existsSync(dataReal)) return { kind: 'skipped', reason: 'data dir missing' };
    const busy = IN_PROGRESS.find((f) => existsSync(join(gitDir, f)));
    if (busy) return { kind: 'skipped', reason: `git operation in progress (${busy})` };
    // Only on the branch that holds the data: a day file committed on another branch would vanish from disk when the
    // owner checks out a branch without it (review D-72).
    const current = (await git(['symbolic-ref', '-q', '--short', 'HEAD'], top).catch(() => '')).trim();
    if (current !== branch) return { kind: 'skipped', reason: current ? `on branch ${current}, not ${branch}` : 'detached HEAD' };

    const inHead = new Set(lines(await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', dataRel], top)));
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', dataRel], top);
    const cutoff = dayStart(addDays(dayKey(now), -1));
    const mtimeOf = (p: string): number | null => {
      try {
        return statSync(join(top, p)).mtimeMs;
      } catch {
        return null;
      }
    };
    const days = (ps: string[]): DayKey[] => ps.map((p) => dayOfPath(p, dataRel)!);
    const selected = selectPaths(parseStatusZ(status), dataRel, cutoff, mtimeOf, inHead);
    let { changed, deleted } = selected;
    // Day files are append-only: a committed one that no longer starts with its HEAD content (an older backup
    // restored, a recreated file) is never committed over the full version (amend + force push would lose it).
    const rewritten: string[] = [];
    for (const p of changed) {
      if (!inHead.has(p)) continue;
      const committed = await git(['cat-file', 'blob', `HEAD:${p}`], top);
      if (!readFileSync(join(top, p), 'utf8').startsWith(committed)) rewritten.push(p);
    }
    heldRewrites = rewritten.length;
    if (heldRewrites) {
      log.warn('data auto-commit: non-append changes held back', { days: days(rewritten) });
      changed = changed.filter((p) => !rewritten.includes(p));
    }
    heldDeletions = isBulkDeletion(deleted, inHead, dataRel, heldDeletions > 0) ? deleted.length : 0;
    if (heldDeletions) {
      log.warn('data auto-commit: bulk deletion held back (commit it by hand if intended)', { deleted: deleted.length });
      deleted = [];
    }
    const paths = [...changed, ...deleted];
    let amended = false;
    if (paths.length) {
      const head = await rev(top, 'HEAD');
      amended = await isPureData(top, dataRel, head);
      await git(['add', '-A', '--', ...paths], top);
      const unstage = (): Promise<void> => git(['reset', '-q', '--', ...paths], top).then(() => {}, (re: unknown) => log.warn('data auto-commit: could not unstage', { error: re as Error, paths }));
      // An amend must hit the commit that was checked: someone may have committed meanwhile (narrows the race).
      if (amended && await rev(top, 'HEAD') !== head) {
        await unstage();
        return { kind: 'skipped', reason: 'HEAD moved' };
      }
      try {
        // --only: exactly these paths, whatever else the owner has staged. --no-verify: a machine data commit must not
        // run (or wait on) the owner's code hooks. --allow-empty: an amend may cancel out (a pushed day file deleted).
        await git(['commit', '--only', '--no-verify', '-q', ...(amended ? ['--amend', '--allow-empty'] : []), '-m', COMMIT_MESSAGE, '--', ...paths], top);
      } catch (e) {
        // Do not leave our paths staged: the owner's next commit would sweep them in.
        await unstage();
        throw e;
      }
    }
    // Push after a commit, or retry an earlier unpushed one (HEAD = our auto-commit).
    let pushed = false;
    let pushSkipped: string | null = null;
    const ours = paths.length > 0 || ((await git(['log', '-1', '--format=%s'], top)).trim() === COMMIT_MESSAGE && await isPureData(top, dataRel, 'HEAD'));
    if (ours) {
      const before = await rev(top, `${branch}@{upstream}`).catch(() => '');
      pushSkipped = await pushDataCommit(top, dataRel);
      pushed = pushSkipped === null && before !== await rev(top, `refs/heads/${branch}`);
      if (pushSkipped) log.info('data auto-commit: not pushed', { reason: pushSkipped });
    }
    if (!paths.length) return pushed ? { kind: 'pushed' } : { kind: 'nothing' };
    return { kind: 'committed', changed: days(changed), deleted: days(deleted), amended, pushed, ...(pushSkipped ? { pushSkipped } : {}) };
  }

  return {
    run,
    tick(now) {
      const today = dayKey(now);
      if (running || doneDay === today || now < nextAttemptAt) return;
      running = true;
      run(now).then((r) => {
        failures = 0;
        if (r.kind === 'skipped' || heldDeletions || heldRewrites) {
          // Held-back deletions: keep checking, so the warning clears soon after the files are restored.
          nextAttemptAt = now + retryMs;
          if (r.kind === 'skipped') log.info('data auto-commit skipped', { reason: r.reason });
          else log.info('data auto-commit', { ...r });
          return;
        }
        doneDay = today;
        log.info('data auto-commit', { ...r });
      }, (e: unknown) => {
        failures++;
        nextAttemptAt = now + retryMs;
        log.warn('data auto-commit failed', { error: e as Error, failures });
      }).finally(() => {
        running = false;
      });
    },
    warning: () => {
      const w: string[] = [];
      if (failures >= WARN_AFTER_FAILURES) w.push('Auto-commit of data/ keeps failing — see the daemon log.');
      if (heldRewrites) w.push(`${heldRewrites} day files in data/ were shortened or rewritten — not auto-committed. Restore them from git, or commit by hand.`);
      if (heldDeletions) w.push(`${heldDeletions} day files are missing from data/ — not auto-committed. Restore them, or commit the deletion by hand.`);
      return w.length ? w.join('\n') : null;
    },
  };
}
