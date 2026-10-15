// M11 wrap-up: read-only summary of the live period from a COPY of data/ (never data/ itself).
// Prints counts and times only — never note, report-feedback or bypass-reason text.
// Usage: scripts/run-node <this file> <copy-of-data-dir> <fromDay> <toDay> [nowEpochMs]
import { createStore } from '../../../../../../../src/store/store.ts';
import { silentLogger } from '../../../../../../../src/core/log.ts';
import { addDays, dayEnd, dayKeysBetween, dayStart, formatHM, weekday, weekStartKey, type DayKey } from '../../../../../../../src/core/time.ts';
import { createInteractiveProvider } from '../../../../../../../src/providers/interactive/index.ts';
import { createPromptHistoryProvider } from '../../../../../../../src/providers/prompt-history/index.ts';
import { createWorkProvider } from '../../../../../../../src/providers/work/index.ts';
import { creditsFromRecords } from '../../../../../../../src/inactivity/inactivity.ts';
import { reportPeriods, reportWorkSource, withoutReportWork } from '../../../../../../../src/reports/work.ts';
import { foldReports, isSkipReport } from '../../../../../../../src/reports/reports.ts';
import policy from '../../../../../../../config/policy.ts';
import { lastWinsByMinute, type AnyRecord } from '../../../../../../../src/store/records.ts';

const [dataDir, from, to, nowArg] = process.argv.slice(2) as [string, DayKey, DayKey, string | undefined];
if (!dataDir || !from || !to) throw new Error('usage: <data-copy> <from> <to> [now]');
if (/(^|\/)data\/?$/.test(dataDir) && !dataDir.includes('scratch')) throw new Error('refusing to read data/ directly — pass a copy');
const NOW = nowArg ? Number(nowArg) : Date.now();
const clock = { now: () => NOW, offsetMs: 0 };
const store = createStore({ dataDir, clock, log: silentLogger });
const graceMs = () => policy.busyGraceMin * 60_000;

const allDays = store.listDays();
const allRecords: AnyRecord[] = allDays.flatMap((k) => store.readDay(k));
const reports = foldReports(allRecords);

// Work digest over everything (like history.ts, but keeping the provider for range info).
const now = () => NOW;
const interactive = createInteractiveProvider({ store, log: silentLogger, now });
interactive.load(allRecords);
const prompts = createPromptHistoryProvider({
  store, log: silentLogger, now, home: '/nonexistent-history-home',
  inputActivity: (a, b) => interactive.workSource.activity!(a, b),
});
prompts.load(allRecords);
const credits = creditsFromRecords(allRecords, graceMs);
const periods = () => reportPeriods(allRecords, NOW, (at) => interactive.coveredUntil(at, 15_000));
const v = () => 0;
const work = createWorkProvider({
  sources: () => [withoutReportWork(interactive.workSource, periods, v), withoutReportWork(prompts.workSource, periods, v), withoutReportWork(credits, periods, v), reportWorkSource(periods, v)],
  graceMs, now,
});

const hm = (s: number) => formatHM(Math.max(0, Math.round(s)));
const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const count = <T extends string>(xs: T[]) => { const m: Record<string, number> = {}; for (const x of xs) m[x] = (m[x] ?? 0) + 1; return m; };
const fmt = (m: Record<string, number>) => Object.entries(m).map(([k, n]) => `${k}×${n}`).join(', ') || '—';

const weekWorked = new Map<DayKey, number>();
const out: string[] = [];
for (const day of dayKeysBetween(from, to)) {
  const recs = store.readDay(day);
  const wd = weekday(day);
  const dp = policy.days[wd];
  const range = work.getRangeInfo(dayStart(day), Math.min(dayEnd(day), Math.floor(NOW / 60_000) * 60_000));
  const worked = range?.workedSeconds ?? 0;
  const reported = range?.reportedSeconds ?? 0;
  const ws = weekStartKey(day);
  const earlier = [...weekWorked].filter(([k]) => k >= ws && k < day).reduce((a, [, s]) => a + s, 0);
  weekWorked.set(day, worked);
  const budget = dp.dailyBudgetMin;
  const effLimitMin = budget === null ? null : Math.max(0, Math.min(budget, policy.weeklyBudgetMin - earlier / 60));
  const of = (t: string) => recs.filter((r) => r.type === t);

  const transitions = of('policy.transition').map((r) => `${clockOf(r.ts)} ${r.from}→${r.to} (${r.workedMin}/${r.limitMin}m)`);
  const tokens = of('token.used').map((r) => `${clockOf(r.ts)} ${r.minutes}m`);
  const bypasses = of('bypass.used').map((r) => `${clockOf(r.ts)} ${r.minutes}m`);
  const forfeits = of('budget.forfeited').map((r) => `${clockOf(r.ts)} by ${r.by} (${Math.round(Number(r.remainingSeconds) / 60)}m given up)`);
  const inactDetected = of('inactivity.detected').length;
  const resolved = of('inactivity.resolved');
  const choices = count(resolved.map((r) => String(r.choice)));
  const creditedMin = resolved.reduce((a, r) => a + Number(r.creditedMinutes ?? 0), 0);
  const nudgeBreaks = of('nudge.break').length;
  const shown = count(of('effect.shown').map((r) => String(r.windowId ?? r.effect)));
  const closed = count(of('effect.closed').map((r) => `${r.windowId ?? r.effect}/${r.by}`));
  const rollover = of('day.rollover').map((r) => `${clockOf(r.ts)} reportMissing=${r.reportMissing}${r.yesterdaySeconds !== undefined ? ` ySec=${r.yesterdaySeconds}` : ''}`);
  const gaps = of('monitor.gap').map((r) => `${r.cause} ${clockOf(Number(r.from))}–${clockOf(Number(r.to))} (${Math.round((Number(r.to) - Number(r.from)) / 60_000)}m)`);
  const starts = of('daemon.started').map((r) => `${clockOf(r.ts)} ${r.version} (${r.reason})`);
  const configs = [...new Set(of('config.loaded').map((r) => String(r.hash).slice(0, 8)))];
  const notesCreated = count(of('note.created').map((r) => String(r.source)));
  const noteOther = count(recs.filter((r) => r.type.startsWith('note.') && r.type !== 'note.created').map((r) => r.type));
  const reportEvents = count(recs.filter((r) => r.type.startsWith('report.')).map((r) => r.type));
  const misc = count(recs.filter((r) => ['panic', 'resume', 'app.quit', 'config.invalid'].includes(r.type)).map((r) => r.type));
  const dayReports = [...reports.values()].filter((r) => r.day === day);
  const repLines = dayReports.map((r) => `${r.timestamp.slice(11)} ${r.stage ?? '-'} src=${r.source}${isSkipReport(r) ? ' SKIP' : ''} energy=${r.energy ?? '-'} status=[${r.status.join('|')}] feedback=${r.feedback ? 'yes' : 'no'}${r.dismissedAt !== null ? ' (dismissed)' : ''}`);
  const promptMin = [...lastWinsByMinute(recs, 'prompt-history').values()] as AnyRecord[];

  out.push(`## ${day} ${wd} (${budget === null ? 'personal' : `budget ${hm(budget * 60)}, effective ${hm((effLimitMin ?? 0) * 60)}`})`,
    `- lines ${recs.length}; worked ${hm(worked)} = seen ${hm(worked - reported)} + reported ${hm(reported)}; longest stretch ${hm(range?.longestStretchSeconds ?? 0)}; breaks ${range?.breaks ?? 0}; first ${range?.firstActivityAt ? clockOf(range.firstActivityAt) : '-'} last ${range?.lastActivityAt ? clockOf(range.lastActivityAt) : '-'}`,
    `- transitions: ${transitions.join('; ') || '—'}`,
    `- tokens: ${tokens.join('; ') || '—'} · bypass: ${bypasses.join('; ') || '—'} · forfeited: ${forfeits.join('; ') || '—'}`,
    `- inactivity: detected ${inactDetected}, resolved ${fmt(choices)}, credited ${creditedMin} min · nudge.break ${nudgeBreaks}`,
    `- effect.shown: ${fmt(shown)}`,
    `- effect.closed: ${fmt(closed)}`,
    `- rollover: ${rollover.join('; ') || '—'}`,
    `- reports for this day (${dayReports.length}): ${repLines.length ? '\n  - ' + repLines.join('\n  - ') : '—'}`,
    `- report.* events in file: ${fmt(reportEvents)} · notes created: ${fmt(notesCreated)} · other note.*: ${fmt(noteOther)}`,
    `- prompt minutes ${promptMin.length}, human prompts ${promptMin.reduce((a, r) => a + Number((r.data as Record<string, unknown>).prompts ?? 0), 0)}, answers ${promptMin.reduce((a, r) => a + Number((r.data as Record<string, unknown>).answers ?? 0), 0)}`,
    `- monitor.gap: ${gaps.join('; ') || '—'}`,
    `- daemon starts: ${starts.join('; ') || '—'} · config hashes ${configs.join(', ') || '—'} · ${fmt(misc)}`,
    '');
}
const weekTotals = new Map<DayKey, number>();
for (const [k, s] of weekWorked) weekTotals.set(weekStartKey(k), (weekTotals.get(weekStartKey(k)) ?? 0) + s);
out.push('## Weeks', ...[...weekTotals].map(([k, s]) => `- week of ${k}: ${hm(s)} of ${hm(policy.weeklyBudgetMin * 60)} (days in range only)`));
const all = [...reports.values()];
out.push('', '## Reports overall', `- created ${all.length}, dismissed ${all.filter((r) => r.dismissedAt !== null).length}, skips ${all.filter((r) => isSkipReport(r)).length}`);
console.log(out.join('\n'));
void addDays;
