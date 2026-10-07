process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COMMIT_MESSAGE, MAX_AUTO_DELETIONS, createDataCommit, isBulkDeletion, dayOfPath, defaultGit, parseStatusZ, selectPaths, type GitRunner } from './data-commit.ts';
import { silentLogger } from '../core/log.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';

const NOW = local(2026, 10, 7, 10, 0); // cutoff = yesterday's start = 2026-10-06 04:00
const SETTLED = local(2026, 10, 6, 3, 59);
const RECENT = local(2026, 10, 6, 4, 1);

test('day-file paths and selection by mtime; deletions only of committed files', () => {
  assert.equal(dayOfPath('data/2026-10/2026-10-05.jsonl', 'data'), '2026-10-05');
  assert.equal(dayOfPath('data/2026-10/2026-11-05.jsonl', 'data'), null, 'month folder must match');
  assert.equal(dayOfPath('data/2026-10/notes.txt', 'data'), null);
  assert.equal(dayOfPath('other/2026-10/2026-10-05.jsonl', 'data'), null);
  const entries = parseStatusZ(' D data/2026-10/2026-10-01.jsonl\0 M data/2026-10/2026-10-02.jsonl\0?? data/2026-10/2026-10-06.jsonl\0AD data/2026-10/2026-10-04.jsonl\0?? data/x.jsonl\0');
  assert.deepEqual(entries.map((e) => e.code), [' D', ' M', '??', 'AD', '??']);
  const mtimes: Record<string, number> = { 'data/2026-10/2026-10-02.jsonl': SETTLED, 'data/2026-10/2026-10-06.jsonl': RECENT, 'data/x.jsonl': 0 };
  const cutoff = local(2026, 10, 6, 4, 0);
  assert.deepEqual(selectPaths(entries, 'data', cutoff, (p) => mtimes[p] ?? null, new Set(['data/2026-10/2026-10-01.jsonl', 'data/2026-10/2026-10-02.jsonl'])), {
    changed: ['data/2026-10/2026-10-02.jsonl'], deleted: ['data/2026-10/2026-10-01.jsonl'],
  });
});

test('bulk deletion: > 2, a whole month folder of HEAD, or anything while an earlier hold is unresolved', () => {
  const head = new Set(['data/2026-10/2026-10-01.jsonl', 'data/2026-10/2026-10-02.jsonl', 'data/2026-10/2026-10-03.jsonl', 'data/2026-11/2026-11-01.jsonl', 'data/x.txt']);
  const d = (...days: string[]): string[] => days.map((k) => `data/${k.slice(0, 7)}/${k}.jsonl`);
  assert.equal(isBulkDeletion([], head, 'data', true), false);
  assert.equal(isBulkDeletion(d('2026-10-01'), head, 'data', false), false, 'a deliberate prune of a day');
  assert.equal(isBulkDeletion(d('2026-10-01', '2026-10-02'), head, 'data', false), false);
  assert.equal(isBulkDeletion(d('2026-10-01', '2026-10-02', '2026-10-03'), head, 'data', false), true, '> 2');
  assert.equal(isBulkDeletion(d('2026-11-01'), head, 'data', false), true, 'a whole month folder (small totals, moved month)');
  assert.equal(isBulkDeletion(d('2026-10-01'), new Set(d('2026-10-01')), 'data', false), true, 'every day file');
  assert.equal(isBulkDeletion(d('2026-10-01'), head, 'data', true), true, 'a partial restore does not release the rest');
});

interface Repo { dir: string; remote: string; sh(...args: string[]): string; file(rel: string, text: string, mtime?: number): void; commit(git?: GitRunner): ReturnType<typeof createDataCommit> }

/** A work repo on `main` tracking a bare `origin` (both under var/test/). */
function makeRepo(t: { after(fn: () => void): void }): Repo {
  const tmp = makeTmpDir('data-commit');
  t.after(tmp.cleanup);
  const dir = join(tmp.dir, 'work');
  const remote = join(tmp.dir, 'remote.git');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const sh = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const file = (rel: string, text: string, mtime?: number): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    if (mtime !== undefined) utimesSync(join(dir, rel), mtime / 1000, mtime / 1000);
  };
  sh('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) sh('config', k!, v!);
  file('code.ts', 'x\n');
  file('data/2026-10/2026-10-01.jsonl', '{"a":1}\n');
  file('data/2026-10/2026-10-02.jsonl', '{"b":1}\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'base');
  sh('remote', 'add', 'origin', remote);
  sh('push', '-q', '-u', 'origin', 'main');
  const commit = (git?: GitRunner) => createDataCommit({ repoRoot: dir, dataDir: join(dir, 'data'), log: silentLogger, ...(git ? { git } : {}) });
  return { dir, remote, sh, file, commit };
}

const remoteHead = (r: Repo): string => execFileSync('git', ['--git-dir', r.remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();

test('commits settled new/changed day files and deletions only, pushes; the owner\'s staged work stays staged', async (t) => {
  const r = makeRepo(t);
  rmSync(join(r.dir, 'data/2026-10/2026-10-01.jsonl'));
  r.file('data/2026-10/2026-10-02.jsonl', '{"b":1}\n{"b":2}\n', SETTLED);
  r.file('data/2026-10/2026-10-05.jsonl', '{"c":1}\n', SETTLED);
  r.file('data/2026-10/2026-10-06.jsonl', '{"d":1}\n', RECENT); // yesterday: not settled yet
  r.file('data/2026-10/notes.txt', 'n\n', SETTLED); // not a day file
  r.file('data/2026-10/2026-10-04.jsonl', '{}\n');
  r.sh('add', 'data/2026-10/2026-10-04.jsonl');
  rmSync(join(r.dir, 'data/2026-10/2026-10-04.jsonl')); // staged then deleted (AD): not a deletion to commit
  r.file('code.ts', 'y\n');
  r.sh('add', 'code.ts'); // the owner's own staged change
  r.file('other.ts', 'z\n');

  const dc = r.commit();
  assert.deepEqual(await dc.run(NOW), { kind: 'committed', changed: ['2026-10-02', '2026-10-05'], deleted: ['2026-10-01'], amended: false, pushed: true });
  assert.deepEqual(r.sh('show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort(), [
    'A\tdata/2026-10/2026-10-05.jsonl', 'D\tdata/2026-10/2026-10-01.jsonl', 'M\tdata/2026-10/2026-10-02.jsonl',
  ]);
  assert.equal(r.sh('log', '-1', '--format=%B').trim(), COMMIT_MESSAGE);
  assert.equal(remoteHead(r), r.sh('rev-parse', 'HEAD').trim());
  assert.deepEqual(r.sh('status', '--porcelain', '--untracked-files=all').trim().split('\n').sort(), [
    '?? data/2026-10/2026-10-06.jsonl', '?? data/2026-10/notes.txt', '?? other.ts', 'AD data/2026-10/2026-10-04.jsonl', 'M  code.ts',
  ]);
  assert.deepEqual(await dc.run(NOW), { kind: 'nothing' });
});

test('a pure data/ HEAD is amended and force-pushed; a code HEAD is not', async (t) => {
  const r = makeRepo(t);
  r.file('data/2026-10/2026-10-03.jsonl', '{}\n', SETTLED);
  const dc = r.commit();
  assert.equal((await dc.run(NOW)).kind, 'committed');
  const count = r.sh('rev-list', '--count', 'HEAD').trim();

  r.file('data/2026-10/2026-10-05.jsonl', '{}\n', SETTLED);
  r.file('code.ts', 'staged\n');
  r.sh('add', 'code.ts');
  assert.deepEqual(await dc.run(NOW), { kind: 'committed', changed: ['2026-10-05'], deleted: [], amended: true, pushed: true });
  assert.equal(r.sh('rev-list', '--count', 'HEAD').trim(), count, 'amended, not a new commit');
  assert.deepEqual(r.sh('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['data/2026-10/2026-10-03.jsonl', 'data/2026-10/2026-10-05.jsonl']);
  assert.equal(remoteHead(r), r.sh('rev-parse', 'HEAD').trim(), 'force-pushed');
  assert.equal(r.sh('status', '--porcelain', '--', 'code.ts').trim(), 'M  code.ts');

  // Deleting the only day file the pushed data commit added cancels it out: still amended (empty), not an error.
  rmSync(join(r.dir, 'data/2026-10/2026-10-05.jsonl'));
  rmSync(join(r.dir, 'data/2026-10/2026-10-03.jsonl'));
  assert.deepEqual(await dc.run(NOW), { kind: 'committed', changed: [], deleted: ['2026-10-03', '2026-10-05'], amended: true, pushed: true });

  r.sh('commit', '-q', '-m', 'code'); // the owner commits code: the next data commit is a new one
  r.file('data/2026-10/2026-10-04.jsonl', '{}\n', SETTLED);
  assert.equal((await dc.run(NOW) as { amended: boolean }).amended, false);
  assert.equal(r.sh('log', '-2', '--format=%s').trim(), `${COMMIT_MESSAGE}\ncode`);
});

test('a failed push is retried on the next run; remote commits fetched but not merged are never overwritten', async (t) => {
  const r = makeRepo(t);
  let failPush = true;
  const dc = r.commit((args, cwd) => (args[0] === 'push' && failPush ? Promise.reject(new Error('git push: offline')) : defaultGit(args, cwd)));
  r.file('data/2026-10/2026-10-03.jsonl', '{}\n', SETTLED);
  await assert.rejects(dc.run(NOW), /offline/);
  failPush = false;
  assert.deepEqual(await dc.run(NOW), { kind: 'pushed' });
  assert.equal(remoteHead(r), r.sh('rev-parse', 'HEAD').trim());

  // Another clone pushes; a background fetch updates origin/main; our amend must not force over it.
  const other = join(dirname(r.dir), 'other');
  execFileSync('git', ['clone', '-q', r.remote, other]);
  for (const a of [['config', 'user.email', 'o@example.invalid'], ['config', 'user.name', 'o'], ['commit', '-q', '--allow-empty', '-m', 'foreign'], ['push', '-q']]) execFileSync('git', a, { cwd: other });
  const foreign = remoteHead(r);
  r.sh('fetch', '-q');
  r.file('data/2026-10/2026-10-05.jsonl', '{}\n', SETTLED);
  const res = await dc.run(NOW) as { amended: boolean; pushed: boolean; pushSkipped?: string };
  assert.deepEqual([res.amended, res.pushed, /not exactly one data commit/.test(res.pushSkipped ?? '')], [true, false, true]);
  assert.equal(remoteHead(r), foreign, 'the foreign commit survives');
});

test('only the data commit is ever pushed: never unpushed code, never over a locally rewound main', async (t) => {
  const r = makeRepo(t);
  const dc = r.commit();
  // Unpushed code commit below: the data commit stays local; the code is not published.
  r.file('code.ts', 'unpushed\n');
  r.sh('commit', '-q', '-am', 'local code');
  const pushedBase = remoteHead(r);
  r.file('data/2026-10/2026-10-03.jsonl', '{}\n', SETTLED);
  const res = await dc.run(NOW) as { pushed: boolean; pushSkipped?: string };
  assert.equal(res.pushed, false);
  assert.match(res.pushSkipped ?? '', /not exactly one data commit/);
  assert.equal(remoteHead(r), pushedBase);
  // The owner pushes himself; the next amend replaces the pushed data commit (same parent) with a lease.
  r.sh('push', '-q');
  r.file('data/2026-10/2026-10-05.jsonl', '{}\n', SETTLED);
  const amended = await dc.run(NOW) as { amended: boolean; pushed: boolean };
  assert.deepEqual([amended.amended, amended.pushed], [true, true]);
  assert.equal(remoteHead(r), r.sh('rev-parse', 'HEAD').trim());

  // main rewound locally below what was pushed: nothing is force-pushed over the remote's commits.
  const remoteBefore = remoteHead(r);
  r.sh('reset', '-q', '--hard', 'HEAD~2');
  r.file('data/2026-10/2026-10-04.jsonl', '{}\n', SETTLED);
  const rewound = await dc.run(NOW) as { pushed: boolean };
  assert.equal(rewound.pushed, false);
  assert.equal(remoteHead(r), remoteBefore);
});

test('skips during a git operation, off main and on a detached HEAD; a failed commit leaves nothing staged', async (t) => {
  const r = makeRepo(t);
  r.file('data/2026-10/2026-10-03.jsonl', '{}\n', SETTLED);
  const dc = r.commit();

  renameSync(join(r.dir, 'data'), join(r.dir, 'data-moved'));
  assert.deepEqual(await dc.run(NOW), { kind: 'skipped', reason: 'data dir missing' }, 'never commit "delete every day file"');
  renameSync(join(r.dir, 'data-moved'), join(r.dir, 'data'));

  writeFileSync(join(r.dir, '.git', 'MERGE_HEAD'), r.sh('rev-parse', 'HEAD'));
  assert.deepEqual(await dc.run(NOW), { kind: 'skipped', reason: 'git operation in progress (MERGE_HEAD)' });
  rmSync(join(r.dir, '.git', 'MERGE_HEAD'));

  r.sh('checkout', '-q', '-b', 'feature');
  assert.deepEqual(await dc.run(NOW), { kind: 'skipped', reason: 'on branch feature, not main' });
  r.sh('checkout', '-q', '--detach');
  assert.deepEqual(await dc.run(NOW), { kind: 'skipped', reason: 'detached HEAD' });
  r.sh('checkout', '-q', 'main');

  const failing = r.commit((args, cwd) => (args[0] === 'commit' ? Promise.reject(new Error('git commit: boom')) : defaultGit(args, cwd)));
  await assert.rejects(failing.run(NOW), /boom/);
  assert.equal(r.sh('status', '--porcelain', '--', 'data').trim(), '?? data/2026-10/2026-10-03.jsonl');
});

test('bulk deletions (data/ moved away, store recreated today) are held back and warned; one or two commit', async (t) => {
  const r = makeRepo(t);
  r.file('data/2026-10/2026-10-03.jsonl', '{}\n');
  r.sh('add', 'data');
  r.sh('commit', '-q', '-m', 'more data');
  r.sh('push', '-q');
  const dc = r.commit();
  const remoteData = (): string[] => execFileSync('git', ['--git-dir', r.remote, 'ls-tree', '-r', '--name-only', 'main', '--', 'data'], { encoding: 'utf8' }).trim().split('\n');
  const all = remoteData();
  assert.equal(all.length, MAX_AUTO_DELETIONS + 1);

  renameSync(join(r.dir, 'data'), join(r.dir, 'data-away'));
  r.file('data/2026-10/2026-10-07.jsonl', '{}\n', NOW); // today's file, recreated by the store
  r.file('data/2026-10/2026-10-05.jsonl', '{}\n', SETTLED);
  const res = await dc.run(NOW) as { kind: string; changed: string[]; deleted: string[] };
  assert.deepEqual([res.kind, res.changed, res.deleted], ['committed', ['2026-10-05'], []]);
  assert.deepEqual(remoteData(), [...all, 'data/2026-10/2026-10-05.jsonl'].sort(), 'nothing deleted remotely');
  assert.match(dc.warning() ?? '', /3 day files are missing/);

  r.sh('checkout', '-q', '--', 'data/2026-10/2026-10-01.jsonl'); // partial restore: 2 still missing
  assert.deepEqual(await dc.run(NOW), { kind: 'nothing' }, 'still held');
  assert.match(dc.warning() ?? '', /2 day files are missing/);
  rmSync(join(r.dir, 'data/2026-10/2026-10-07.jsonl'));
  r.sh('checkout', '-q', '--', 'data'); // restored
  rmSync(join(r.dir, 'data-away'), { recursive: true });
  assert.deepEqual(await dc.run(NOW), { kind: 'nothing' });
  assert.equal(dc.warning(), null);

  rmSync(join(r.dir, 'data/2026-10/2026-10-01.jsonl'));
  rmSync(join(r.dir, 'data/2026-10/2026-10-02.jsonl'));
  assert.deepEqual((await dc.run(NOW) as { deleted: string[] }).deleted, ['2026-10-01', '2026-10-02']);
});

test('a committed day file that is not an append (older backup restored) is held back; a real append commits', async (t) => {
  const r = makeRepo(t);
  r.file('data/2026-10/2026-10-02.jsonl', '{"b":0}\n', SETTLED); // shorter / different than HEAD's '{"b":1}\n'
  r.file('data/2026-10/2026-10-05.jsonl', '{}\n', SETTLED);
  const dc = r.commit();
  const res = await dc.run(NOW) as { changed: string[] };
  assert.deepEqual(res.changed, ['2026-10-05']);
  assert.equal(r.sh('show', 'HEAD:data/2026-10/2026-10-02.jsonl'), '{"b":1}\n');
  assert.match(dc.warning() ?? '', /1 day files in data\/ were shortened or rewritten/);
  r.file('data/2026-10/2026-10-02.jsonl', '{"b":1}\n{"b":2}\n', SETTLED);
  assert.deepEqual((await dc.run(NOW) as { changed: string[] }).changed, ['2026-10-02']);
  assert.equal(dc.warning(), null);
});

test('scheduler: once per day after notBefore, retries failures, warns after repeated failures', async (t) => {
  const tmp = makeTmpDir('data-commit-sched');
  t.after(tmp.cleanup);
  let attempts = 0;
  let fail = true;
  const git: GitRunner = async (args) => {
    if (args[0] === 'symbolic-ref') return 'main\n';
    if (args[1] === '--verify') throw new Error('no upstream');
    if (args[1] !== '--show-toplevel') return '';
    attempts++;
    if (fail) throw new Error('git rev-parse: index.lock exists');
    return `${tmp.dir}\n${tmp.dir}/.git\n`;
  };
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
  const tick = async (at: number): Promise<void> => {
    dc.tick(at);
    await settle();
  };
  mkdirSync(join(tmp.dir, 'data'));
  const dc = createDataCommit({ repoRoot: tmp.dir, dataDir: join(tmp.dir, 'data'), log: silentLogger, git, retryMs: 1000, notBefore: NOW });
  await tick(NOW - 1);
  assert.equal(attempts, 0, 'not before notBefore');
  for (let i = 0; i < 3; i++) {
    await tick(NOW + i * 1000);
    await tick(NOW + i * 1000 + 500); // inside the retry delay
  }
  assert.equal(attempts, 3);
  assert.match(dc.warning() ?? '', /keeps failing/);

  fail = false;
  await tick(NOW + 3000);
  assert.equal(attempts, 4);
  assert.equal(dc.warning(), null, 'a success clears the warning');
  await tick(NOW + 3_600_000);
  assert.equal(attempts, 4, 'once per day');
  await tick(local(2026, 10, 8, 3, 59));
  assert.equal(attempts, 4, 'still the same 04:00 day');
  await tick(local(2026, 10, 8, 4, 0));
  assert.equal(attempts, 5, 'again on the next day');
});
