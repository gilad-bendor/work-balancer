// Dry-run report over today's real Copilot history: counts only, nothing is written (M5 acceptance).
//   scripts/prompt-history-report
import { homedir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '../../core/clock.ts';
import { REPO_ROOT } from '../../core/env.ts';
import { silentLogger } from '../../core/log.ts';
import { dayEnd, dayKey, dayStart } from '../../core/time.ts';
import { createStore, type Store } from '../../store/store.ts';
import { createInteractiveProvider } from '../interactive/index.ts';
import { createPromptHistoryProvider } from './index.ts';

const now = systemClock.now();
const today = dayKey(now);
// Read-only view of the live data (for `interactive` corroboration, C8); appends are refused.
const live = createStore({ dataDir: join(REPO_ROOT, 'data'), clock: systemClock, log: silentLogger });
const readOnly: Store = { ...live, append: () => null };
const interactive = createInteractiveProvider({ store: readOnly, log: silentLogger, now: () => now });
interactive.load(live.readDay(today));
const p = createPromptHistoryProvider({
  store: readOnly, log: silentLogger, now: () => now, home: homedir(),
  inputActivity: (from, to) => interactive.workSource.activity!(from, to),
});
const t0 = performance.now();
p.poll(now, { force: true, write: false });
const ms = Math.round(performance.now() - t0);

const d = p.diagnostics(dayStart(today), dayEnd(today));
console.log(`prompt-history dry run — day ${today} (04:00 → now), scan ${ms} ms; counts only, nothing written\n`);
for (const k of Object.keys(d).sort()) console.log(`  ${k.padEnd(36)} ${d[k]}`);
const r = p.getRangeInfo(dayStart(today), dayEnd(today));
if (r) {
  console.log(`\nhuman prompts ${r.prompts}, human answers ${r.answers}, unclassified ${r.unclassified}, automated ${r.automated}`);
  console.log(`first ${r.firstAt ? new Date(r.firstAt).toTimeString().slice(0, 8) : '-'}, last ${r.lastAt ? new Date(r.lastAt).toTimeString().slice(0, 8) : '-'}, ` +
    `per hour ${r.perHour.toFixed(2)}, longest silence ${Math.round(r.longestSilenceSeconds / 60)} min`);
}
