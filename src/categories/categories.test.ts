process.env.TZ = 'Asia/Jerusalem';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../core/env.ts';
import { silentLogger } from '../core/log.ts';
import { fixedClock } from '../core/clock.ts';
import { local, makeTmpDir } from '../testing/tmp.ts';
import { createStore } from '../store/store.ts';
import { createInteractiveProvider } from '../providers/interactive/index.ts';
import { createWorkProvider } from '../providers/work/index.ts';
import { parseHeartbeat, MAX_TITLE } from '../bridge/protocol.ts';
import { createCategories, type AppContext } from './categories.ts';

const MIN = 60_000;
const WA: AppContext = { bundleId: 'net.whatsapp.WhatsApp', appName: '\u200eWhatsApp', windowTitle: 'Family' };
const CODE: AppContext = { bundleId: 'com.microsoft.VSCode', appName: 'Code', windowTitle: 'ledger.md — work-balancer' };

test("the owner's config/categories.ts: WhatsApp by bundle id, everything else Work; styles for the built-ins", async () => {
  const c = createCategories({ path: join(REPO_ROOT, 'config', 'categories.ts'), log: silentLogger });
  await c.refresh();
  assert.deepEqual(c.errors(), []);
  assert.equal(c.categorize(WA), 'WhatsApp');
  assert.equal(c.categorize({ ...WA, bundleId: 'desktop.WhatsApp' }), 'WhatsApp');
  assert.equal(c.categorize(CODE), 'Work');
  assert.equal(c.categorize({ bundleId: 'com.google.Chrome', appName: 'Google Chrome', windowTitle: null }), 'Work');
  for (const k of ['Work', 'WhatsApp', 'Inactive', 'Blocked', 'Future', 'Something new']) {
    const s = c.style(k);
    assert.equal(typeof s.color, 'string');
    assert.ok(s.thickness > 0);
    assert.ok(s.label.length > 0);
  }
});

test('a broken categorizer never breaks tracking: invalid answers and throws → Work; a broken file keeps the previous one', async (t) => {
  const tmp = makeTmpDir('categories');
  t.after(tmp.cleanup);
  const path = join(tmp.dir, 'categories.ts');
  const write = (src: string, mtime: number) => {
    writeFileSync(path, src);
    utimesSync(path, mtime, mtime);
  };
  const c = createCategories({ path, log: silentLogger });
  await c.refresh();
  assert.equal(c.categorize(WA), 'Work', 'missing file: everything is Work');
  assert.equal(c.errors().length, 1);

  write(`export function categorize(a) { if (a.bundleId === 'x.throw') throw new Error('boom'); if (a.bundleId === 'x.builtin') return 'Blocked';
    if (a.bundleId === 'x.empty') return '  '; if (a.bundleId === 'x.long') return 'L'.repeat(41); if (a.bundleId === 'x.num') return 7; return ' Chat '; }
    export function categoryStyle(c) { if (c === 'bad') return { color: 1 }; if (c === 'throw') throw new Error('x'); return { color: 'red', thickness: 3 }; }`, 1000);
  await c.refresh();
  assert.deepEqual(c.errors(), []);
  assert.equal(c.categorize(CODE), 'Chat', 'trimmed');
  for (const b of ['x.throw', 'x.builtin', 'x.empty', 'x.long', 'x.num']) assert.equal(c.categorize({ ...CODE, bundleId: b }), 'Work', b);
  assert.deepEqual(c.style('ok'), { color: 'red', thickness: 3, label: 'ok' });
  assert.ok(c.style('bad').thickness > 0, 'fallback style');
  assert.ok(c.style('throw').thickness > 0);

  write('export function categorize( { syntax error', 2000);
  await c.refresh();
  assert.equal(c.errors().length, 1);
  assert.equal(c.categorize(CODE), 'Chat', 'the previous version keeps running');
  write('export const categorize = 1;', 3000);
  await c.refresh();
  assert.equal(c.categorize(CODE), 'Chat');
});

test('categories are recorded per minute (seconds, locked time excluded) — titles never stored, worked time unchanged', async (t) => {
  const tmp = makeTmpDir('categories-minute');
  t.after(tmp.cleanup);
  const T = local(2026, 10, 6, 10, 0);
  const clock = fixedClock(T);
  const make = (categorize?: (a: AppContext) => string) => {
    const store = createStore({ dataDir: join(tmp.dir, categorize ? 'with' : 'without'), clock, log: silentLogger });
    const p = createInteractiveProvider({ store, log: silentLogger, now: () => clock.now(), ...(categorize ? { categorize } : {}) });
    const work = createWorkProvider({ sources: () => [p.workSource], graceMs: () => 5 * MIN, now: () => clock.now() });
    return { store, p, work };
  };
  const seen: (string | null)[] = [];
  const cat = (a: AppContext): string => {
    seen.push(a.windowTitle);
    return a.bundleId === WA.bundleId ? 'WhatsApp' : 'Work';
  };
  const runs = [make(cat), make()];
  clock.set(T + 3 * MIN);
  for (const r of runs) {
    r.p.ingest({
      inputs: [T + 5_000, T + 70_000, T + 130_000],
      apps: [
        { id: CODE.bundleId, name: CODE.appName, from: T, to: T + 40_000, title: CODE.windowTitle! },
        { id: WA.bundleId, name: WA.appName, from: T + 40_000, to: T + 100_000, title: 'Secret chat name' },
        { id: CODE.bundleId, name: CODE.appName, from: T + 100_000, to: T + 3 * MIN, title: 'other file' },
      ],
      system: [{ event: 'lock', at: T + 150_000 }, { event: 'unlock', at: T + 170_000 }],
      locked: false, since: T,
    }, { since: T, until: T + 3 * MIN }, T + 3 * MIN);
  }
  clock.set(T + 5 * MIN);
  for (const r of runs) r.p.flushMinutes(clock.now());
  const [withCats, without] = runs;
  const recs = withCats!.store.readDay('2026-10-06').filter((r) => r.type === 'minute');
  assert.deepEqual(recs.map((r) => (r.data as { categories?: unknown }).categories), [
    { Work: 40, WhatsApp: 20 },
    { WhatsApp: 40, Work: 20 },
    { Work: 40 }, // 20 s locked
  ]);
  assert.ok(seen.includes('Secret chat name'), 'the categorizer sees the title');
  const raw = readFileSync(join(tmp.dir, 'with', '2026-10', '2026-10-06.jsonl'), 'utf8');
  assert.ok(!raw.includes('Secret chat name') && !raw.includes('ledger.md'), 'titles never reach data/');
  // Time logic does not read categories: identical worked time with or without them.
  const day = [local(2026, 10, 6, 4, 0), local(2026, 10, 7, 4, 0)] as const;
  assert.equal(withCats!.work.getRangeInfo(...day)!.workedSeconds, without!.work.getRangeInfo(...day)!.workedSeconds);
  assert.deepEqual(withCats!.p.getRangeInfo(...day)!.categories, { Work: 100, WhatsApp: 60 });
  // Without a categorizer everything is Work.
  assert.deepEqual(without!.p.getRangeInfo(...day)!.categories, { Work: 160 });

  // A restart keeps the recorded categories (no raw intervals on disk; nothing is rewritten).
  const store2 = createStore({ dataDir: join(tmp.dir, 'with'), clock, log: silentLogger });
  const p2 = createInteractiveProvider({ store: store2, log: silentLogger, now: () => clock.now(), categorize: cat });
  p2.load(store2.readDay('2026-10-06'));
  assert.deepEqual(p2.getRangeInfo(...day)!.categories, { Work: 100, WhatsApp: 60 });
  assert.equal(p2.flushMinutes(clock.now()), 0);
});

test('heartbeat parsing keeps a window title (capped), drops a non-string one', () => {
  const hb = parseHeartbeat({
    protocol: 1, loadId: 'x', seq: 1, sentAt: 1,
    samples: { inputs: [], system: [], locked: false, since: 0, apps: [
      { id: 'a', name: 'A', from: 0, to: 1, title: 'T'.repeat(MAX_TITLE + 50) },
      { id: 'b', name: 'B', from: 0, to: 1, title: 42 },
      { id: 'c', name: 'C', from: 0, to: 1 },
    ] },
    ui: { windows: {}, closed: [], dimmed: false, latches: { panic: false, quit: false } },
    acks: [],
  });
  assert.equal(hb.samples.apps[0]!.title!.length, MAX_TITLE);
  assert.equal('title' in hb.samples.apps[1]!, false);
  assert.equal('title' in hb.samples.apps[2]!, false);
});

test('review D-67: a restart never re-labels a minute on disk; identical minutes are not rewritten; totals ≤ 60 s; no titles in logs', async (t) => {
  const tmp = makeTmpDir('categories-restart');
  t.after(tmp.cleanup);
  const T = local(2026, 10, 6, 11, 0);
  const clock = fixedClock(T + 3 * MIN);
  const dir = join(tmp.dir, 'data');
  const s1 = createStore({ dataDir: dir, clock, log: silentLogger });
  const p1 = createInteractiveProvider({ store: s1, log: silentLogger, now: () => clock.now(), categorize: (a) => (a.bundleId === WA.bundleId ? 'WhatsApp' : 'Work') });
  const open = { id: CODE.bundleId, name: CODE.appName, from: T + 20_000, to: T + 3 * MIN, title: 'x' };
  p1.ingest({ inputs: [T + 1000], apps: [{ id: WA.bundleId, name: WA.appName, from: T, to: T + 20_000 }, open], system: [], locked: false, since: T }, { since: T, until: T + 3 * MIN }, T + 3 * MIN);
  clock.set(T + 5 * MIN);
  p1.flushMinutes(clock.now());
  const before = s1.readDay('2026-10-06').filter((r) => r.type === 'minute').length;
  // Restart with a changed categorizer; Lua re-sends the open interval with its old `from`.
  const s2 = createStore({ dataDir: dir, clock, log: silentLogger });
  const p2 = createInteractiveProvider({ store: s2, log: silentLogger, now: () => clock.now(), categorize: () => 'Chat' });
  p2.load(s2.readDay('2026-10-06'));
  p2.ingest({ inputs: [], apps: [{ ...open, to: T + 5 * MIN }], system: [], locked: false, since: T + 3 * MIN }, { since: T + 3 * MIN, until: T + 5 * MIN }, T + 5 * MIN);
  clock.set(T + 7 * MIN);
  p2.flushMinutes(clock.now());
  const recs = s2.readDay('2026-10-06').filter((r) => r.type === 'minute');
  const old = recs.filter((r) => (r.minute as number) < T + 3 * MIN);
  assert.equal(old.length, before, 'no minute on disk was rewritten');
  assert.deepEqual(old.map((r) => (r.data as { categories?: unknown }).categories), [{ WhatsApp: 20, Work: 40 }, { Work: 60 }, { Work: 60 }]);
  assert.deepEqual(recs.filter((r) => (r.minute as number) >= T + 3 * MIN).map((r) => (r.data as { categories?: unknown }).categories), [{ Chat: 60 }, { Chat: 60 }]);
});

test('roundSeconds: whole seconds per category, never more than the rounded total', async () => {
  const { roundSeconds } = await import('../providers/interactive/index.ts');
  assert.deepEqual(roundSeconds([['a', 20.6], ['b', 20.6], ['c', 18.8]]), { a: 21, b: 20, c: 19 });
  assert.deepEqual(roundSeconds([['a', 30.5], ['b', 29.5]]), { a: 31, b: 29 });
  assert.deepEqual(roundSeconds([['a', 0.3]]), {});
});

test('a throwing categorizer logs the error kind and bundle id, never its message (it may quote the title)', async (t) => {
  const tmp = makeTmpDir('categories-log');
  t.after(tmp.cleanup);
  const path = join(tmp.dir, 'c.ts');
  writeFileSync(path, 'export function categorize(a) { return JSON.parse(a.windowTitle); }\nexport function categoryStyle() { return { color: "x", thickness: 1, label: "" }; }');
  const lines: string[] = [];
  const log = { ...silentLogger, warn: (msg: string, f?: Record<string, unknown>) => { lines.push(msg + JSON.stringify(f ?? {})); } } as typeof silentLogger;
  const c = createCategories({ path, log });
  await c.refresh();
  assert.equal(c.categorize({ ...WA, windowTitle: 'Secret chat name' }), 'Work');
  assert.equal(lines.length, 1);
  assert.ok(!lines.join().includes('Secret'), lines.join());
  assert.match(lines[0]!, /SyntaxError/);
});

test('review D-67 round 2: a hostile return value cannot escape; a partial minute gets its rest after a restart', async (t) => {
  const tmp = makeTmpDir('categories-hostile');
  t.after(tmp.cleanup);
  const path = join(tmp.dir, 'c.ts');
  writeFileSync(path, 'export function categorize() { return Object.create(null); }\nexport function categoryStyle() { return null; }');
  const c = createCategories({ path, log: silentLogger });
  await c.refresh();
  assert.equal(c.categorize(CODE), 'Work');

  const T = local(2026, 10, 6, 12, 0);
  const clock = fixedClock(T + 20_000);
  const dir = join(tmp.dir, 'data');
  const s1 = createStore({ dataDir: dir, clock, log: silentLogger });
  const p1 = createInteractiveProvider({ store: s1, log: silentLogger, now: () => clock.now() });
  p1.ingest({ inputs: [T + 1000], apps: [{ id: CODE.bundleId, name: CODE.appName, from: T, to: T + 20_000 }], system: [], locked: false, since: T }, { since: T, until: T + 20_000 }, T + 20_000);
  p1.flushMinutes(clock.now(), { all: true }); // shutdown at :20
  const s2 = createStore({ dataDir: dir, clock, log: silentLogger });
  const p2 = createInteractiveProvider({ store: s2, log: silentLogger, now: () => clock.now() });
  p2.load(s2.readDay('2026-10-06'));
  p2.ingest({ inputs: [], apps: [{ id: CODE.bundleId, name: CODE.appName, from: T, to: T + 2 * MIN }], system: [], locked: false, since: T + 20_000 }, { since: T + 20_000, until: T + 2 * MIN }, T + 2 * MIN);
  clock.set(T + 4 * MIN);
  p2.flushMinutes(clock.now());
  const last = s2.readDay('2026-10-06').filter((r) => r.type === 'minute' && r.minute === T).at(-1)!;
  assert.deepEqual((last.data as { categories?: unknown }).categories, { Work: 60 });
  // A throwing categorizer inside the provider never stops coverage.
  const p3 = createInteractiveProvider({ store: s2, log: silentLogger, now: () => clock.now(), categorize: () => { throw new Error('x'); } });
  p3.ingest({ inputs: [], apps: [{ id: 'a', name: 'A', from: T + 4 * MIN, to: T + 5 * MIN }], system: [], locked: false, since: T + 4 * MIN }, { since: T + 4 * MIN, until: T + 5 * MIN }, T + 5 * MIN);
  assert.equal(p3.coverageEnd(), T + 5 * MIN);
});

test('review D-67 round 3: an async categorizer never leaves an unhandled rejection; a minute split by a restart keeps both halves', async (t) => {
  const tmp = makeTmpDir('categories-async');
  t.after(tmp.cleanup);
  const path = join(tmp.dir, 'c.ts');
  writeFileSync(path, 'export async function categorize(a) { return a.windowTitle.includes("x") ? "X" : "Work"; }\nexport function categoryStyle() { return null; }');
  const c = createCategories({ path, log: silentLogger });
  await c.refresh();
  let unhandled = 0;
  const on = () => { unhandled++; };
  process.on('unhandledRejection', on);
  t.after(() => process.off('unhandledRejection', on));
  assert.equal(c.categorize({ ...CODE, windowTitle: null }), 'Work');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(unhandled, 0);

  // WhatsApp :00–:20, Code from :20; the daemon restarts at :30; Lua re-sends only the open Code interval.
  const T = local(2026, 10, 6, 13, 0);
  const clock = fixedClock(T + 30_000);
  const dir = join(tmp.dir, 'data');
  const cat = (a: AppContext) => (a.bundleId === WA.bundleId ? 'WhatsApp' : 'Work');
  const s1 = createStore({ dataDir: dir, clock, log: silentLogger });
  const p1 = createInteractiveProvider({ store: s1, log: silentLogger, now: () => clock.now(), categorize: cat });
  p1.ingest({ inputs: [T + 1000], apps: [{ id: WA.bundleId, name: WA.appName, from: T, to: T + 20_000 }, { id: CODE.bundleId, name: CODE.appName, from: T + 20_000, to: T + 30_000 }], system: [], locked: false, since: T }, { since: T, until: T + 30_000 }, T + 30_000);
  p1.flushMinutes(clock.now(), { all: true });
  const s2 = createStore({ dataDir: dir, clock, log: silentLogger });
  const p2 = createInteractiveProvider({ store: s2, log: silentLogger, now: () => clock.now(), categorize: cat });
  p2.load(s2.readDay('2026-10-06'));
  p2.ingest({ inputs: [], apps: [{ id: CODE.bundleId, name: CODE.appName, from: T + 20_000, to: T + 2 * MIN }], system: [], locked: false, since: T + 30_000 }, { since: T + 30_000, until: T + 2 * MIN }, T + 2 * MIN);
  clock.set(T + 4 * MIN);
  p2.flushMinutes(clock.now());
  const last = s2.readDay('2026-10-06').filter((r) => r.type === 'minute' && r.minute === T).at(-1)!;
  assert.deepEqual((last.data as { categories?: unknown }).categories, { WhatsApp: 20, Work: 40 });
});
