import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  consoleTail,
  ensureInitLua,
  ensureSymlink,
  HEALTH_COMMAND,
  inspectSymlink,
  normaliseInitLua,
  reloadAndVerify,
  REQUIRE_LINE,
  type HsReply,
  type HsRunner,
} from './_reload-hammerspoon.ts';

const repo = resolve(import.meta.dirname, '..');
const wrapper = join(repo, 'scripts', 'reload-hammerspoon');
const target = join(repo, 'hammerspoon', 'work-balancer.lua');
const scratchRoot = join(repo, '.github/tmp/2026-10-04--16-19--kickoff-m1-m4/tbd-01-reload-hammerspoon/scratch');

let base: string;
before(() => {
  mkdirSync(scratchRoot, { recursive: true });
  base = mkdtempSync(join(scratchRoot, 'test-'));
});
after(() => rmSync(base, { recursive: true, force: true }));

const newDir = (): string => mkdtempSync(join(base, 'hs-'));
const backups = (dir: string): string[] => readdirSync(dir).filter((f) => f.startsWith('init.lua.bak.'));

describe('normaliseInitLua', () => {
  it('appends the line to an empty file', () => {
    const r = normaliseInitLua('');
    assert.equal(r.text, `${REQUIRE_LINE}\n`);
    assert.ok(r.changed && r.added);
  });

  it('appends after a newline when the file has no trailing newline; other lines byte-identical', () => {
    const before = 'require("a")\n  -- keep  me \t\nrequire("b")';
    const r = normaliseInitLua(before);
    assert.equal(r.text, `${before}\n${REQUIRE_LINE}\n`);
  });

  it('appends without an extra blank line when the file ends with a newline', () => {
    const r = normaliseInitLua('require("a")\n');
    assert.equal(r.text, `require("a")\n${REQUIRE_LINE}\n`);
  });

  it('is a no-op when exactly one canonical line exists', () => {
    const text = `require("a")\n${REQUIRE_LINE}\nrequire("b")\n`;
    const r = normaliseInitLua(text);
    assert.equal(r.text, text);
    assert.ok(!r.changed);
    assert.equal(r.matches, 1);
  });

  it('removes duplicates, keeping the first position', () => {
    const r = normaliseInitLua(`a()\n${REQUIRE_LINE}\nb()\n${REQUIRE_LINE}\nc()\n${REQUIRE_LINE}`);
    assert.equal(r.text, `a()\n${REQUIRE_LINE}\nb()\nc()\n`);
    assert.equal(r.removed, 2);
    assert.ok(!r.added);
  });

  it("normalises a '-quoted line", () => {
    const r = normaliseInitLua("a()\nrequire('work-balancer')\nb()\n");
    assert.equal(r.text, `a()\n${REQUIRE_LINE}\nb()\n`);
    assert.ok(r.normalised && r.changed);
  });

  it('normalises surrounding whitespace and inner spacing', () => {
    const r = normaliseInitLua(`a()\n  \t require ( 'work-balancer' )  \nb()\n`);
    assert.equal(r.text, `a()\n${REQUIRE_LINE}\nb()\n`);
  });

  it('treats mixed canonical + quoted variants as duplicates', () => {
    const r = normaliseInitLua(`require('work-balancer')\n${REQUIRE_LINE}\n`);
    assert.equal(r.text, `${REQUIRE_LINE}\n`);
    assert.equal(r.removed, 1);
  });

  it('keeps a canonical line that is the last line without a trailing newline', () => {
    const text = `a()\n${REQUIRE_LINE}`;
    const r = normaliseInitLua(text);
    assert.equal(r.text, text);
    assert.ok(!r.changed);
  });

  it('preserves CRLF line endings of the kept line', () => {
    const r = normaliseInitLua("a()\r\nrequire('work-balancer')\r\nb()\r\n");
    assert.equal(r.text, `a()\r\n${REQUIRE_LINE}\r\nb()\r\n`);
  });

  it('does not treat comments or other modules as the line', () => {
    const text = `-- ${REQUIRE_LINE}\nrequire("work-balancer-other")\nrequire("not-work-balancer")\n`;
    const r = normaliseInitLua(text);
    assert.equal(r.text, `${text}${REQUIRE_LINE}\n`);
    assert.ok(r.added);
  });
});

describe('ensureInitLua', () => {
  it('creates init.lua when missing, without a backup', () => {
    const dir = newDir();
    const r = ensureInitLua(dir);
    assert.ok(r.created && r.changed);
    assert.equal(readFileSync(join(dir, 'init.lua'), 'utf8'), `${REQUIRE_LINE}\n`);
    assert.deepEqual(backups(dir), []);
  });

  it('backs up the original bytes before changing, named init.lua.bak.<epochMs>', () => {
    const dir = newDir();
    const original = 'require("a")\nrequire("b")';
    writeFileSync(join(dir, 'init.lua'), original);
    const r = ensureInitLua(dir, { now: () => 1234567890123 });
    assert.equal(r.backupPath, join(dir, 'init.lua.bak.1234567890123'));
    assert.equal(readFileSync(r.backupPath!, 'utf8'), original);
    assert.equal(readFileSync(join(dir, 'init.lua'), 'utf8'), `${original}\n${REQUIRE_LINE}\n`);
  });

  it('never overwrites an existing backup with the same timestamp', () => {
    const dir = newDir();
    writeFileSync(join(dir, 'init.lua'), 'x()\n');
    writeFileSync(join(dir, 'init.lua.bak.100'), 'precious');
    const r = ensureInitLua(dir, { now: () => 100 });
    assert.equal(r.backupPath, join(dir, 'init.lua.bak.101'));
    assert.equal(readFileSync(join(dir, 'init.lua.bak.100'), 'utf8'), 'precious');
  });

  it('is idempotent: the second run changes nothing and writes no backup', () => {
    const dir = newDir();
    writeFileSync(join(dir, 'init.lua'), "require('x')\nrequire('work-balancer')\nrequire('work-balancer')\n");
    const first = ensureInitLua(dir);
    assert.ok(first.changed);
    const after1 = readFileSync(join(dir, 'init.lua'), 'utf8');
    const second = ensureInitLua(dir);
    assert.ok(!second.changed);
    assert.equal(second.backupPath, null);
    assert.equal(readFileSync(join(dir, 'init.lua'), 'utf8'), after1);
    assert.equal(backups(dir).length, 1);
  });

  it('writes no backup when nothing changes', () => {
    const dir = newDir();
    writeFileSync(join(dir, 'init.lua'), `${REQUIRE_LINE}\n`);
    ensureInitLua(dir);
    assert.deepEqual(backups(dir), []);
  });

  it('dryRun reports the change without touching anything', () => {
    const dir = newDir();
    writeFileSync(join(dir, 'init.lua'), 'x()\n');
    const r = ensureInitLua(dir, { dryRun: true });
    assert.ok(r.changed);
    assert.equal(readFileSync(join(dir, 'init.lua'), 'utf8'), 'x()\n');
    assert.deepEqual(backups(dir), []);
  });
});

describe('ensureSymlink', () => {
  it('creates a missing symlink', () => {
    const dir = newDir();
    const r = ensureSymlink(dir, target);
    assert.ok(r.changed);
    assert.equal(readlinkSync(join(dir, 'work-balancer.lua')), target);
  });

  it('is idempotent', () => {
    const dir = newDir();
    ensureSymlink(dir, target);
    const r = ensureSymlink(dir, target);
    assert.ok(!r.changed);
    assert.equal(r.state, 'ok');
  });

  it('fixes a symlink pointing elsewhere and reports the old target', () => {
    const dir = newDir();
    symlinkSync('/nonexistent/old-place.lua', join(dir, 'work-balancer.lua'));
    assert.deepEqual(
      { state: inspectSymlink(dir, target).state, old: inspectSymlink(dir, target).oldTarget },
      { state: 'wrong', old: '/nonexistent/old-place.lua' },
    );
    const r = ensureSymlink(dir, target);
    assert.ok(r.changed);
    assert.equal(r.state, 'wrong');
    assert.equal(r.oldTarget, '/nonexistent/old-place.lua');
    assert.equal(readlinkSync(join(dir, 'work-balancer.lua')), target);
    assert.deepEqual(readdirSync(dir), ['work-balancer.lua']);
  });

  it('accepts an equivalent relative symlink as correct', () => {
    const dir = newDir();
    symlinkSync(relative(dir, target), join(dir, 'work-balancer.lua'));
    assert.equal(inspectSymlink(dir, target).state, 'ok');
    assert.ok(!ensureSymlink(dir, target).changed);
  });

  it('refuses to clobber a regular file', () => {
    const dir = newDir();
    writeFileSync(join(dir, 'work-balancer.lua'), 'my precious module');
    const r = ensureSymlink(dir, target);
    assert.equal(r.state, 'conflict');
    assert.ok(!r.changed);
    assert.ok(!lstatSync(join(dir, 'work-balancer.lua')).isSymbolicLink());
    assert.equal(readFileSync(join(dir, 'work-balancer.lua'), 'utf8'), 'my precious module');
  });
});

describe('reloadAndVerify (fake hs)', () => {
  const reply = (status: number | null, stdout = '', stderr = ''): HsReply => ({ status, stdout, stderr });
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('marks, requests the reload, then polls until the health reply starts with ok', async () => {
    const calls: string[] = [];
    let polls = 0;
    const hs: HsRunner = (args) => {
      calls.push(args.at(-1)!);
      if (args.at(-1) === HEALTH_COMMAND) {
        polls++;
        return polls < 3 ? reply(69, '', "can't access Hammerspoon") : reply(0, 'ok 0.1.0\n');
      }
      return reply(0);
    };
    const out = await reloadAndVerify(hs, fakeClock());
    assert.deepEqual(out, { ok: true, health: 'ok 0.1.0' });
    assert.equal(calls[0], '_WB_RELOAD_PENDING = true');
    assert.equal(calls[1], 'hs.timer.doAfter(0.2, hs.reload)');
    assert.equal(polls, 3);
  });

  it('keeps polling while the old instance answers "reloading"', async () => {
    let polls = 0;
    const hs: HsRunner = (args) =>
      args.at(-1) === HEALTH_COMMAND ? (++polls < 4 ? reply(0, 'reloading\n') : reply(0, 'ok 1\n')) : reply(0);
    assert.equal((await reloadAndVerify(hs, fakeClock())).ok, true);
    assert.equal(polls, 4);
  });

  it('times out with the last reply when never healthy', async () => {
    const hs: HsRunner = (args) => (args.at(-1) === HEALTH_COMMAND ? reply(0, 'missing\n') : reply(0));
    const out = await reloadAndVerify(hs, { ...fakeClock(), timeoutMs: 3000, pollMs: 500 });
    assert.deepEqual(out, { ok: false, health: 'missing' });
  });

  it('consoleTail returns only the last lines', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const out = consoleTail(() => reply(0, text), 5);
    assert.equal(out, 'line 95\nline 96\nline 97\nline 98\nline 99');
    assert.match(consoleTail(() => reply(1, '', 'no ipc')), /could not read.*no ipc/);
  });

  it('fails immediately when the reload request itself fails', async () => {
    const hs: HsRunner = (args) => (args.at(-1) === 'hs.timer.doAfter(0.2, hs.reload)' ? reply(1, '', 'boom') : reply(0));
    const out = await reloadAndVerify(hs, fakeClock());
    assert.ok(!out.ok);
    assert.match(out.health, /boom/);
  });
});

describe('CLI (spawned wrapper, --hammerspoon-dir only)', () => {
  const run = (args: string[], cwd = '/', script = wrapper) =>
    spawnSync(script, args, { encoding: 'utf8', cwd, timeout: 30_000 });

  it('--help prints usage and exits 0', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: scripts\/reload-hammerspoon/);
  });

  it('rejects unknown flags with exit 2', () => {
    const r = run(['--nope']);
    assert.equal(r.status, 2);
  });

  it('installs into a missing dir, from another cwd, and is idempotent', () => {
    const dir = join(newDir(), 'not-yet', '.hammerspoon');
    const r1 = run(['--hammerspoon-dir', dir], '/');
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(readlinkSync(join(dir, 'work-balancer.lua')), target);
    assert.equal(readFileSync(join(dir, 'init.lua'), 'utf8'), `${REQUIRE_LINE}\n`);

    const snapshot = readdirSync(dir).sort();
    const initBefore = readFileSync(join(dir, 'init.lua'), 'utf8');
    const r2 = run(['--hammerspoon-dir', dir], base);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(readdirSync(dir).sort(), snapshot);
    assert.equal(readFileSync(join(dir, 'init.lua'), 'utf8'), initBefore);
  });

  it('works through a symlink to the wrapper', () => {
    const link = join(newDir(), 'wrapper-link');
    symlinkSync(wrapper, link);
    const dir = newDir();
    const r = run(['--hammerspoon-dir', dir], base, link);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readlinkSync(join(dir, 'work-balancer.lua')), target);
  });

  it('modifies an existing init.lua with a backup, leaving other lines intact', () => {
    const dir = newDir();
    const original = 'require("one")\n\n-- note\nrequire(\'work-balancer\')\nrequire("two")';
    writeFileSync(join(dir, 'init.lua'), original);
    const r = run(['--hammerspoon-dir', dir, '--quiet']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(readFileSync(join(dir, 'init.lua'), 'utf8'), `require("one")\n\n-- note\n${REQUIRE_LINE}\nrequire("two")`);
    const [bak] = backups(dir);
    assert.equal(readFileSync(join(dir, bak), 'utf8'), original);
  });

  it('prints the old target when fixing a wrong symlink', () => {
    const dir = newDir();
    symlinkSync('/nonexistent/old-place.lua', join(dir, 'work-balancer.lua'));
    const r = run(['--hammerspoon-dir', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /was -> \/nonexistent\/old-place\.lua/);
    assert.equal(readlinkSync(join(dir, 'work-balancer.lua')), target);
  });

  it('refuses a regular-file conflict: exit != 0, file untouched, init.lua untouched', () => {
    const dir = newDir();
    writeFileSync(join(dir, 'work-balancer.lua'), 'mine');
    const r = run(['--hammerspoon-dir', dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing/);
    assert.equal(readFileSync(join(dir, 'work-balancer.lua'), 'utf8'), 'mine');
    assert.ok(!existsSync(join(dir, 'init.lua')));
  });

  it('--check is read-only and fails when not installed, succeeds when installed', () => {
    const dir = newDir();
    writeFileSync(join(dir, 'init.lua'), 'x()\n');
    const bad = run(['--check', '--hammerspoon-dir', dir]);
    assert.equal(bad.status, 1);
    assert.deepEqual(readdirSync(dir), ['init.lua']);
    assert.equal(readFileSync(join(dir, 'init.lua'), 'utf8'), 'x()\n');

    assert.equal(run(['--hammerspoon-dir', dir]).status, 0);
    const good = run(['--check', '--hammerspoon-dir', dir]);
    assert.equal(good.status, 0, good.stderr);
  });

  it('--check on a missing dir fails without creating it', () => {
    const dir = join(newDir(), 'absent');
    const r = run(['--check', '--hammerspoon-dir', dir]);
    assert.equal(r.status, 1);
    assert.ok(!existsSync(dir));
  });
});
