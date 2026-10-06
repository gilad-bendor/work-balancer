import { randomBytes } from 'node:crypto';
import { addDays, dayKey, dayKeysBetween, parseDayKey, weekday, type DayKey } from '../core/time.ts';
import type { ActionResult } from '../core/effects.ts';
import type { Store } from '../store/store.ts';
import type { PolicyConfig } from '../policy/config.ts';
import { cleanText } from '../notes/notes.ts';

export interface DailyReport {
  day: DayKey;
  weekday: string;
  daysAgo: number;
  status: 'pending' | 'answered' | 'skipped';
  energy: number | null;
  text: string;
  choices: string[];
}

export interface Reports {
  list(now: number): DailyReport[];
  get(day: DayKey, now: number): DailyReport | null;
  freshDue(now: number): boolean;
  action(action: string, payload: unknown, now: number): ActionResult;
}

export function validReportDay(value: unknown): value is DayKey {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { y, m0, d } = parseDayKey(value);
  const date = new Date(Date.UTC(y, m0, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m0 && date.getUTCDate() === d;
}

function civilOrdinal(day: DayKey): number {
  const { y, m0, d } = parseDayKey(day);
  return Date.UTC(y, m0, d) / 86_400_000;
}

export function createReports(d: { store: Store; config: () => PolicyConfig | null }): Reports {
  const saved = new Map<DayKey, Omit<DailyReport, 'weekday' | 'daysAgo'>>();
  for (const file of d.store.listDays()) {
    for (const r of d.store.scanDay(file, (line) => line.includes('"type":"report.'))) {
      if (!validReportDay(r.day)) continue;
      if (r.type === 'report.skipped') {
        saved.set(r.day, { day: r.day, status: 'skipped', energy: null, text: '', choices: [] });
      } else if (r.type === 'report.submitted' && typeof r.energy === 'number' && Number.isInteger(r.energy) && r.energy >= 1 && r.energy <= 5) {
        saved.set(r.day, {
          day: r.day, status: 'answered', energy: r.energy, text: cleanText(r.text),
          choices: Array.isArray(r.choices) ? r.choices.filter((x): x is string => typeof x === 'string') : [],
        });
      }
    }
  }
  // The nonce is deliberately not persistent: a restart cancels confirmation, never confirms a skip.
  const armed = new Map<DayKey, { nonce: string; at: number }>();
  function get(day: DayKey, now: number): DailyReport | null {
    const start = d.config()?.dailyReportsStartDay;
    const today = dayKey(now);
    if (!start || !validReportDay(day) || day < start || day > today) return null;
    return {
      ...(saved.get(day) ?? { day, status: 'pending', energy: null, text: '', choices: [] }),
      weekday: weekday(day), daysAgo: civilOrdinal(today) - civilOrdinal(day),
    };
  }
  return {
    get,
    list(now) {
      const start = d.config()?.dailyReportsStartDay;
      return start && start <= dayKey(now) ? dayKeysBetween(start, dayKey(now)).map((day) => get(day, now)!) : [];
    },
    freshDue: (now) => get(addDays(dayKey(now), -1), now)?.status === 'pending',
    action(action, payload, now) {
      const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const report = typeof p.day === 'string' ? get(p.day, now) : null;
      if (!report) return { ok: false, error: 'day' };
      if (action === 'report-arm-skip') {
        if (report.status !== 'pending') return { ok: false, error: 'resolved' };
        const nonce = randomBytes(12).toString('hex');
        armed.set(report.day, { nonce, at: now });
        return { ok: true, nonce, delayMs: report.daysAgo <= 1 ? 800 : 0 };
      }
      if (action === 'report-skip') {
        const confirm = armed.get(report.day);
        if (!confirm || p.nonce !== confirm.nonce || now - confirm.at < (report.daysAgo <= 1 ? 800 : 0) || now - confirm.at > 60_000) {
          return { ok: false, error: 'confirmation' };
        }
        if (report.status !== 'pending') return { ok: false, error: 'resolved' };
        if (!d.store.append({ type: 'report.skipped', day: report.day })) return { ok: false, error: 'write' };
        saved.set(report.day, { day: report.day, status: 'skipped', energy: null, text: '', choices: [] });
      } else if (action === 'report-submit') {
        if (typeof p.energy !== 'number' || !Number.isInteger(p.energy) || p.energy < 1 || p.energy > 5) return { ok: false, error: 'energy' };
        const allowed = new Set(d.config()?.feedbackChoices ?? []);
        const choices = Array.isArray(p.choices) ? [...new Set(p.choices.filter((x): x is string => typeof x === 'string' && allowed.has(x)))].slice(0, 20) : [];
        const text = cleanText(p.text);
        if (report.status === 'answered' && report.energy === p.energy && report.text === text && JSON.stringify(report.choices) === JSON.stringify(choices)) return { ok: true };
        if (!d.store.append({ type: 'report.submitted', day: report.day, energy: p.energy, choices, text })) return { ok: false, error: 'write' };
        saved.set(report.day, { day: report.day, status: 'answered', energy: p.energy, text, choices });
      } else return { ok: false, error: `unknown action ${action}` };
      armed.delete(report.day);
      return { ok: true };
    },
  };
}
