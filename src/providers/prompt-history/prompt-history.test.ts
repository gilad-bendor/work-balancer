process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPromptHistoryProvider, decodePromptMinute } from './index.ts';
import { createStore } from '../../store/store.ts';
import { fixedClock } from '../../core/clock.ts';
import { REPO_ROOT } from '../../core/env.ts';
import { silentLogger } from '../../core/log.ts';
import { lastWinsByMinute } from '../../store/records.ts';
import type { Interval } from '../../core/intervals.ts';
import { makeTmpDir } from '../../testing/tmp.ts';

const FIXTURES = join(REPO_ROOT, 'test-fixtures', 'prompt-history');
const AH = ['Library', 'Application Support', 'Code', 'agentSessionData'];
const VS1 = ['Library', 'Application Support', 'Code', 'User', 'workspaceStorage', 'fixturehash0001', 'chatSessions', 'vs000000-0000-4000-8000-000000000001.jsonl'];

interface Expected {
  cli: { prompts: { class: string; rule: string }[]; answers: { class: string; rule: string }[] };
  vscode: { prompts: { class: string; rule: string }[]; answers: { class: string; rule: string }[] };
}

/** A fake $HOME from the fixtures, with the agent-host `.sql` files materialised as SQLite dbs. */
function fixtureHome() {
  const tmp = makeTmpDir('prompt-history');
  const home = join(tmp.dir, 'home');
  cpSync(join(FIXTURES, 'home'), home, { recursive: true });
  const ah = join(home, ...AH);
  for (const d of readdirSync(ah)) {
    const db = new DatabaseSync(join(ah, d, 'session.db'));
    db.exec(readFileSync(join(ah, d, 'session.sql'), 'utf8'));
    db.close();
    rmSync(join(ah, d, 'session.sql'));
  }
  return { ...tmp, home };
}

function setup(inputs: Interval[] = []) {
  const h = fixtureHome();
  const clock = fixedClock(Date.UTC(2026, 0, 11, 12, 30)); // day key 2026-01-11 (local 14:30), after all deferrals
  const store = createStore({ dataDir: join(h.dir, 'data'), clock, log: silentLogger });
  const p = createPromptHistoryProvider({ store, log: silentLogger, now: () => clock.now(), home: h.home, inputActivity: (from, to) => inputs.filter(([a]) => a >= from && a <= to) });
  return { ...h, clock, store, p };
}

/** expected.json → counts per `<store>.<kind>.<class>.<rule>`. */
function expectedCounts(): Record<string, number> {
  const e = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as Expected;
  const out: Record<string, number> = {};
  for (const store of ['cli', 'vscode'] as const) {
    for (const kind of ['prompts', 'answers'] as const) {
      for (const r of e[store][kind]) {
        const k = `${store}.${kind === 'prompts' ? 'prompt' : 'answer'}.${r.class}.${r.rule.split(' ')[0]}`;
        out[k] = (out[k] ?? 0) + 1;
      }
    }
  }
  return out;
}

const DAY = [Date.UTC(2026, 0, 11, 2, 0), Date.UTC(2026, 0, 12, 2, 0)] as const; // 04:00 → 04:00 local (UTC+2)

function actual(p: ReturnType<typeof setup>['p']): Record<string, number> {
  const d = p.diagnostics(...DAY);
  delete d['cli.prompt.pending'];
  return d;
}

test('every fixture record is classified as expected.json says (rules C0–C10, A1–A2, V1–V5, VA1)', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.p.poll(s.clock.now(), { force: true });
  assert.deepEqual(actual(s.p), expectedCounts());
  assert.equal(s.p.diagnostics(...DAY)['cli.prompt.pending'], 0);
});

test('C8: a runner-session follow-up counts as human when `interactive` saw input in the preceding 60 s', (t) => {
  const followUp = Date.UTC(2026, 0, 11, 9, 30); // session …0007, no turn index
  const s = setup([[followUp - 20_000, followUp - 20_000]]);
  t.after(s.cleanup);
  s.p.poll(s.clock.now(), { force: true });
  const d = actual(s.p);
  assert.equal(d['cli.prompt.human.C8'], 1);
  assert.equal(d['cli.prompt.unclassified.C8'], undefined);
});

test('minute records: counts and human times only (no text); human times are work activity; re-poll is idempotent', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.p.poll(s.clock.now(), { force: true });
  const recs = s.store.readDay('2026-01-11').filter((r) => r.type === 'minute');
  const byMinute = lastWinsByMinute(recs, 'prompt-history');
  const all = [...byMinute.values()].map((r) => decodePromptMinute(r.data));
  assert.equal(all.reduce((n, m) => n + m.prompts, 0), 9);
  assert.equal(all.reduce((n, m) => n + m.answers, 0), 4);
  assert.equal(all.reduce((n, m) => n + m.unclassified, 0), 5);
  assert.equal(all.reduce((n, m) => n + m.automated, 0), 10);
  const raw = readFileSync(s.store.filePath('2026-01-11'), 'utf8');
  assert.doesNotMatch(raw, /prompt text|placeholder|WORKING AGREEMENT/, 'no text ever reaches data/');
  // 08:00:02 is the first human prompt (session …0001).
  const first = Date.UTC(2026, 0, 11, 8, 0, 2);
  assert.deepEqual(s.p.workSource.activity!(first - 1000, first + 1000), [[first, first]]);
  const lines = recs.length;
  s.clock.advance(60_000);
  s.p.poll(s.clock.now(), { force: true });
  assert.equal(s.store.readDay('2026-01-11').filter((r) => r.type === 'minute').length, lines);
  const r = s.p.getRangeInfo(...DAY)!;
  assert.equal(r.prompts, 9);
  assert.equal(r.answers, 4);
  assert.equal(r.firstAt, first);
});

test('a restart re-scans today and writes nothing new; VS Code compaction (file rewritten) adds nothing', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.p.poll(s.clock.now(), { force: true });
  const lines = s.store.readDay('2026-01-11').length;
  const p2 = createPromptHistoryProvider({ store: s.store, log: silentLogger, now: () => s.clock.now(), home: s.home, inputActivity: () => [] });
  p2.load(s.store.readDay('2026-01-11'));
  p2.poll(s.clock.now(), { force: true });
  assert.equal(s.store.readDay('2026-01-11').length, lines, 'restart: no new lines');
  copyFileSync(join(FIXTURES, 'variants', 'compacted', ...VS1.slice(0)), join(s.home, ...VS1));
  p2.poll(s.clock.now() + 1, { force: true });
  assert.deepEqual(actual(p2), expectedCounts());
  assert.equal(s.store.readDay('2026-01-11').length, lines, 'compaction: no new lines');
});

test('C9: an agent-host prompt without a turn row waits (pending) before becoming unclassified', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.clock.set(Date.UTC(2026, 0, 11, 9, 41)); // 1 min after session …0008's prompt
  s.p.poll(s.clock.now(), { force: true });
  assert.equal(s.p.diagnostics(...DAY)['cli.prompt.pending'], 1);
  s.clock.set(Date.UTC(2026, 0, 11, 9, 46));
  s.p.poll(s.clock.now(), { force: true });
  assert.equal(s.p.diagnostics(...DAY)['cli.prompt.pending'], 0);
  assert.equal(actual(s.p)['cli.prompt.unclassified.C9'], 1);
});

test('review M5#1: a VS Code answer is stamped with its request time — live and after a restart alike (no double count)', (t) => {
  const s = setup();
  t.after(s.cleanup);
  const file = join(s.home, ...VS1);
  const full = readFileSync(file, 'utf8');
  const lines = full.split('\n');
  const answered = lines.findIndex((l) => l.includes('"isUsed":true'));
  writeFileSync(file, lines.slice(0, answered).join('\n') + '\n'); // the question is still open
  s.p.poll(s.clock.now(), { force: true });
  writeFileSync(file, full); // answered later (live)
  s.p.poll(s.clock.now() + 1, { force: true });
  const answers = () => [...lastWinsByMinute(s.store.readDay('2026-01-11'), 'prompt-history').values()].reduce((n, r) => n + decodePromptMinute(r.data).answers, 0);
  assert.equal(answers(), 4);
  const p2 = createPromptHistoryProvider({ store: s.store, log: silentLogger, now: () => s.clock.now(), home: s.home, inputActivity: () => [] });
  p2.load(s.store.readDay('2026-01-11'));
  p2.poll(s.clock.now() + 2, { force: true });
  assert.equal(answers(), 4, 'restart: still 4 answers');
});

test('review M5#2: a failed minute write is retried on the next poll', (t) => {
  const s = setup();
  t.after(s.cleanup);
  let failing = true;
  const flaky = { ...s.store, append: (r: Parameters<typeof s.store.append>[0]) => (failing ? null : s.store.append(r)) };
  const p = createPromptHistoryProvider({ store: flaky, log: silentLogger, now: () => s.clock.now(), home: s.home, inputActivity: () => [] });
  p.poll(s.clock.now(), { force: true });
  assert.equal(s.store.readDay('2026-01-11').length, 0);
  failing = false;
  p.poll(s.clock.now() + 1, { force: true });
  assert.ok(s.store.readDay('2026-01-11').filter((r) => r.type === 'minute').length > 0);
});

test('review M5#3: the original of a copied session is the older one, whatever the directory order', (t) => {
  const s = setup();
  t.after(s.cleanup);
  const cli = join(s.home, '.copilot', 'session-state');
  // The copy (…0006, created later) now sorts first by name.
  renameSync(join(cli, '00000000-0000-4000-8000-000000000006'), join(cli, '00000000-0000-0000-0000-000000000000'));
  s.p.poll(s.clock.now(), { force: true });
  assert.deepEqual(actual(s.p), expectedCounts());
});

test('review M5#5: an agent-host db with a hot journal (commit in flight) is not read this poll', (t) => {
  const s = setup();
  t.after(s.cleanup);
  const db = join(s.home, ...AH, 'a0000000-0000-4000-8000-000000000001', 'session.db');
  writeFileSync(`${db}-journal`, 'x');
  s.p.poll(s.clock.now(), { force: true });
  assert.equal(actual(s.p)['cli.prompt.human.C6'], 1, "only …0002's UI turn; …0001's turns wait for the journal to go");
  rmSync(`${db}-journal`);
});

test('review M5#8: a drift warning when nothing is parsed on a long working day', (t) => {
  const tmp = makeTmpDir('ph-empty');
  t.after(tmp.cleanup);
  const clock = fixedClock(Date.UTC(2026, 0, 11, 12, 30));
  const store = createStore({ dataDir: join(tmp.dir, 'data'), clock, log: silentLogger });
  const p = createPromptHistoryProvider({ store, log: silentLogger, now: () => clock.now(), home: join(tmp.dir, 'nohome'), inputActivity: () => [] });
  p.poll(clock.now(), { force: true });
  assert.equal(p.warning(clock.now(), 4 * 3600), null, 'no Copilot history on earlier days either: not drift');
  p.load([{ v: 1, ts: 0, type: 'minute', provider: 'prompt-history', minute: Date.UTC(2026, 0, 10, 9, 0), data: { prompts: 3 } }]);
  assert.equal(p.warning(clock.now(), 3600), null);
  assert.match(p.warning(clock.now(), 4 * 3600) ?? '', /nothing parsed/);
});
