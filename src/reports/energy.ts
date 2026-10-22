// The Energy Graph (menu → "Energy Graph"): one row per day from the first report to today — the lowest and highest
// energy reported that day (null: none) and that day's reports, oldest first.
import { addDays, weekday, type DayKey } from '../core/time.ts';
import { reportView, type Report, type ReportView } from './reports.ts';

export interface EnergyDay {
  day: DayKey;
  weekday: string;
  min: number | null;
  max: number | null;
  reports: ReportView[];
}

/** Safety bound (≈ 10 years, like Manage Reports' days): an ancient stray report cannot make the graph huge. */
export const ENERGY_DAYS_CAP = 3660;

/** Oldest day first; reports after `today` (a stepped clock) are left out. */
export function energyDays(reports: readonly Report[], today: DayKey): EnergyDay[] {
  const floor = addDays(today, -(ENERGY_DAYS_CAP - 1));
  const byDay = new Map<DayKey, Report[]>();
  for (const r of reports) {
    if (r.day > today || r.day < floor) continue;
    byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  }
  if (!byDay.size) return [];
  const first = [...byDay.keys()].reduce((a, b) => (b < a ? b : a));
  const out: EnergyDay[] = [];
  for (let day = first; day <= today; day = addDays(day, 1)) {
    const list = [...(byDay.get(day) ?? [])].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id));
    const energies = list.flatMap((r) => (r.energy === null ? [] : [r.energy]));
    out.push({
      day, weekday: weekday(day),
      min: energies.length ? Math.min(...energies) : null,
      max: energies.length ? Math.max(...energies) : null,
      reports: list.map(reportView),
    });
  }
  return out;
}
