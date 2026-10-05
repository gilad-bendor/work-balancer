import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ownersPolicy from '../../config/policy.ts';
import { createPolicyLoader, validatePolicy, type ConfigEvent, type PolicyConfig } from './config.ts';
import { silentLogger } from '../core/log.ts';
import { makeTmpDir } from '../testing/tmp.ts';

const typeImport = `import type { PolicyConfig } from '${join(import.meta.dirname, 'config.ts')}';`;
const fileFor = (cfg: unknown) => `${typeImport}\nexport default ${JSON.stringify(cfg)} as unknown as PolicyConfig;\n`;

test("the owner's config/policy.ts is valid and matches R-POL-2", () => {
  const r = validatePolicy(ownersPolicy);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(ownersPolicy.weeklyBudgetMin, 44 * 60);
  assert.deepEqual(
    Object.entries(ownersPolicy.days).filter(([, d]) => d.enforce).map(([k]) => k),
    ['sun', 'tue', 'thu'],
  );
  assert.equal(ownersPolicy.days.sat.colours, false);
  assert.equal(ownersPolicy.days.sat.inactivityDialog, false);
  assert.equal(ownersPolicy.days.fri.morningReview, false);
  // D-35: only Sun/Tue/Thu are intrusive at all.
  const intrusive = Object.entries(ownersPolicy.days)
    .filter(([, d]) => d.enforce || d.inactivityDialog || d.breakNudge || d.morningReview)
    .map(([k]) => k);
  assert.deepEqual(intrusive, ['sun', 'tue', 'thu']);
  assert.deepEqual(ownersPolicy.tokensMin, [10, 5, 5]);
});

test('validation reports clear errors', () => {
  const bad = structuredClone(ownersPolicy) as unknown as Record<string, any>;
  bad.weeklyBudgetMin = -1;
  bad.ladder.countdownBeforeMin = 40;
  bad.days.mon.enforce = true;
  delete bad.days.fri;
  bad.days.funday = {};
  bad.days.sat.enforce = true;
  const r = validatePolicy(bad);
  assert.equal(r.ok, false);
  const errors = (r as { errors: string[] }).errors.join('\n');
  assert.match(errors, /weeklyBudgetMin must be a number/);
  assert.match(errors, /countdownBeforeMin must be ≤/);
  assert.match(errors, /days.mon.enforce needs a dailyBudgetMin/);
  assert.match(errors, /days.fri is missing/);
  assert.match(errors, /days.funday is not a weekday/);
  assert.match(errors, /days.sat.enforce must be false/);
  assert.equal(validatePolicy(null).ok, false);
});

function loaderSetup() {
  const tmp = makeTmpDir('config');
  const path = join(tmp.dir, 'policy.ts');
  const snapshotPath = join(tmp.dir, 'var', 'policy.last-good.json');
  const events: ConfigEvent[] = [];
  let mtime = 1_000_000;
  const write = (content: string) => {
    writeFileSync(path, content);
    mtime += 10;
    utimesSync(path, mtime, mtime); // distinct mtimes even within one fs tick
  };
  const loader = () => createPolicyLoader({ path, snapshotPath, log: silentLogger, onEvent: (e) => events.push(e) });
  return { ...tmp, path, snapshotPath, events, write, loader };
}

test('hot reload: picks up a change, keeps the previous config on an invalid edit, snapshots valid ones', async (t) => {
  const s = loaderSetup();
  t.after(s.cleanup);
  s.write(fileFor(ownersPolicy));
  const loader = s.loader();
  assert.equal(await loader.refresh(), true);
  assert.equal(loader.state().source, 'file');
  assert.equal(await loader.refresh(), false, 'unchanged mtime → no re-import');
  assert.ok(existsSync(s.snapshotPath));

  const edited: PolicyConfig = { ...ownersPolicy, weeklyBudgetMin: 40 * 60 };
  s.write(fileFor(edited));
  await loader.refresh();
  assert.equal(loader.state().config?.weeklyBudgetMin, 40 * 60);
  assert.equal(JSON.parse(readFileSync(s.snapshotPath, 'utf8')).weeklyBudgetMin, 40 * 60);

  s.write(`${typeImport}\nexport default { oops: true` /* syntax error */);
  await loader.refresh();
  assert.equal(loader.state().config?.weeklyBudgetMin, 40 * 60, 'previous config kept');
  assert.match(loader.state().errors[0] ?? '', /cannot load/);

  s.write(fileFor({ ...ownersPolicy, busyGraceMin: 0 }));
  await loader.refresh();
  assert.equal(loader.state().config?.busyGraceMin, 5);
  assert.match(loader.state().errors.join(), /busyGraceMin/);

  s.write(fileFor(ownersPolicy));
  await loader.refresh();
  assert.deepEqual(loader.state().errors, []);
  assert.deepEqual(s.events.map((e) => e.type), ['config.loaded', 'config.loaded', 'config.invalid', 'config.invalid', 'config.loaded']);
});

test('cold start with an invalid config: last-good snapshot, else tracking-only', async (t) => {
  const s = loaderSetup();
  t.after(s.cleanup);
  s.write(fileFor({ ...ownersPolicy, weeklyBudgetMin: 30 * 60 }));
  await s.loader().refresh(); // creates the snapshot

  s.write(fileFor({ nonsense: 1 }));
  const cold = s.loader();
  await cold.refresh();
  assert.equal(cold.state().source, 'snapshot');
  assert.equal(cold.state().config?.weeklyBudgetMin, 30 * 60);
  assert.ok(cold.state().errors.length > 0);

  writeFileSync(s.snapshotPath, 'garbage');
  const bare = s.loader();
  await bare.refresh();
  assert.equal(bare.state().source, 'none');
  assert.equal(bare.state().config, null);
});
