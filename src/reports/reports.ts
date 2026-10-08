// Reports (ledger R-UI-REPORT): how the owner is doing — feedback text, status ("How are you doing?"), energy 1–5 —
// with a local "YYYY-MM-DD HH:MM" timestamp and an optional stage. Several per day; a day *without* any report is what
// the morning welcome and Manage Reports ask about. A skip = a report with all three fields empty. Never deleted:
// dismissed (and then not counted). Event-sourced like notes: a fold of `report.*` over ALL day files.
import { randomBytes } from 'node:crypto';
import type { ActionResult } from '../core/effects.ts';
import { addDays, dayKey, DAY_START_HOUR, parseDayKey, weekday, type DayKey } from '../core/time.ts';
import type { PolicyConfig, ReportsConfig } from '../policy/config.ts';
import type { AnyRecord } from '../store/records.ts';
import type { Store } from '../store/store.ts';
import { cleanText, isId, newId } from '../notes/notes.ts';

export const REPORT_STAGES = ['morning', 'afternoon', 'evening', 'end-of-workday'] as const;
export type ReportStage = (typeof REPORT_STAGES)[number];
export const REPORT_SOURCES = ['manager', 'countdown', 'block', 'review'] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export interface ReportFields {
  feedback: string;
  status: string[];
  energy: number | null;
}

export interface Report extends ReportFields {
  /** The creation time (epoch ms), bumped by 1 ms on a collision. */
  id: number;
  /** Local civil time it describes, "YYYY-MM-DD HH:MM" (a catch-up report: the middle of its stage). */
  timestamp: string;
  /** The 04:00-bounded day of `timestamp`. */
  day: DayKey;
  stage: ReportStage | null;
  source: ReportSource;
  createdAt: number;
  editedAt: number | null;
  dismissedAt: number | null;
}

/** A report as pages see it. */
export interface ReportView extends Omit<Report, 'dismissedAt' | 'editedAt'> {
  skip: boolean;
  dismissed: boolean;
}

/** A recent day without a report (Manage Reports shows it as a stub). */
export interface ReportStub {
  day: DayKey;
  weekday: string;
  daysAgo: number;
}

export const isSkipReport = (r: ReportFields): boolean => !r.feedback && r.status.length === 0 && r.energy === null;
const isStage = (x: unknown): x is ReportStage => REPORT_STAGES.includes(x as ReportStage);
const isSource = (x: unknown): x is ReportSource => REPORT_SOURCES.includes(x as ReportSource);
const isEnergy = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 5;

export function validReportDay(value: unknown): value is DayKey {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { y, m0, d } = parseDayKey(value);
  const date = new Date(Date.UTC(y, m0, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m0 && date.getUTCDate() === d;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;

/** Local civil "YYYY-MM-DD HH:MM" of an instant. */
export function formatTimestamp(ms: number): string {
  const t = new Date(ms);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** The 04:00-bounded day a timestamp belongs to (01:30 belongs to the previous date), or null if malformed. */
export function timestampDay(ts: unknown): DayKey | null {
  const m = typeof ts === 'string' ? TIMESTAMP.exec(ts) : null;
  if (!m || !validReportDay(m[1])) return null;
  return Number(m[2]) < DAY_START_HOUR ? addDays(m[1]!, -1) : m[1]!;
}

const DAY_FROM = DAY_START_HOUR * 60;
const DAY_TO = DAY_FROM + 24 * 60;
const clockMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Minutes after the day key's 00:00, on the 04:00 → 28:00 axis of the 04:00-bounded day. */
const dayMin = (clock: number): number => (clock < DAY_FROM ? clock + 24 * 60 : clock);

/** Stage of a timestamp by its time of day: morning from 04:00, then afternoon, then evening until the next 04:00. */
export function stageAt(ts: string, stages: ReportsConfig['stages']): Exclude<ReportStage, 'end-of-workday'> {
  const m = dayMin(clockMin(ts.slice(11)));
  if (m < clockMin(stages.afternoonFrom)) return 'morning';
  if (m < clockMin(stages.eveningFrom)) return 'afternoon';
  return 'evening';
}

/** A catch-up report's timestamp on `day`: the middle of the stage's range, or `endOfWorkdayAt` for end-of-workday. */
export function catchUpTimestamp(day: DayKey, stage: ReportStage, stages: ReportsConfig['stages']): string {
  const a = clockMin(stages.afternoonFrom);
  const e = clockMin(stages.eveningFrom);
  const m = stage === 'morning' ? Math.floor((DAY_FROM + a) / 2)
    : stage === 'afternoon' ? Math.floor((a + e) / 2)
      : stage === 'evening' ? Math.floor((e + DAY_TO) / 2)
        : dayMin(clockMin(stages.endOfWorkdayAt));
  const date = m >= 24 * 60 ? addDays(day, 1) : day;
  const clock = m % (24 * 60);
  return `${date} ${pad(Math.floor(clock / 60))}:${pad(clock % 60)}`;
}

function civilOrdinal(day: DayKey): number {
  const { y, m0, d } = parseDayKey(day);
  return Date.UTC(y, m0, d) / 86_400_000;
}
export const daysAgo = (day: DayKey, today: DayKey): number => civilOrdinal(today) - civilOrdinal(day);

const fieldsOf = (r: Record<string, unknown>): ReportFields => ({
  feedback: typeof r.feedback === 'string' ? r.feedback : '',
  status: Array.isArray(r.status) ? r.status.filter((x): x is string => typeof x === 'string') : [],
  energy: isEnergy(r.energy) ? r.energy : null,
});

/** Pure fold of `report.*` records (file order). Unknown ids, duplicates and malformed records are ignored. */
export function foldReports(records: Iterable<AnyRecord>, into: Map<number, Report> = new Map()): Map<number, Report> {
  for (const r of records) applyRecord(into, r);
  return into;
}

function applyRecord(reports: Map<number, Report>, r: AnyRecord): void {
  if (!isId(r.reportId)) return;
  const x = reports.get(r.reportId);
  switch (r.type) {
    case 'report.created': {
      const day = timestampDay(r.timestamp);
      if (x || !day) return;
      reports.set(r.reportId, {
        id: r.reportId, timestamp: r.timestamp as string, day, stage: isStage(r.stage) ? r.stage : null, ...fieldsOf(r),
        source: isSource(r.source) ? r.source : 'manager', createdAt: r.ts, editedAt: null, dismissedAt: null,
      });
      return;
    }
    case 'report.edited':
      if (x) reports.set(x.id, { ...x, ...fieldsOf(r), editedAt: r.ts });
      return;
    case 'report.dismissed':
      if (x && x.dismissedAt === null) reports.set(x.id, { ...x, dismissedAt: r.ts });
      return;
    case 'report.undismissed':
      if (x && x.dismissedAt !== null) reports.set(x.id, { ...x, dismissedAt: null });
      return;
  }
}

/** Newest first (by the time described, then by creation). */
const newestFirst = (a: Report, b: Report): number => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.id - a.id);

export const reportView = (r: Report): ReportView => {
  const { dismissedAt, editedAt: _edited, ...rest } = r;
  return { ...rest, skip: isSkipReport(r), dismissed: dismissedAt !== null };
};

export type ReportResult = { ok: true; report: Report } | { ok: false; error: string };

export interface Reports {
  /** Not dismissed, newest first. */
  list(): Report[];
  get(id: number): Report | null;
  /** Not dismissed reports of one day, newest first. */
  ofDay(day: DayKey): Report[];
  /** Recent days (newest first) without a report: the last `stubDays` days, not before `startDay`. */
  missing(now: number): ReportStub[];
  /** Yesterday has no report (the morning welcome asks for it). */
  freshDue(now: number): boolean;
  /** Countdown / block: an end-of-workday report, timed now. */
  createEndOfWorkday(fields: unknown, source: ReportSource, now: number): ReportResult;
  /** Page actions (`report-*`); `days` limits the days catch-up actions may target (default: any missing day). */
  action(action: string, payload: unknown, now: number, opts: { source: ReportSource; days?: (day: DayKey) => boolean }): ActionResult;
}

export function createReports(d: { store: Store; config: () => PolicyConfig | null }): Reports {
  const reports = new Map<number, Report>();
  for (const file of d.store.listDays()) foldReports(d.store.scanDay(file, (line) => line.includes('"type":"report.')), reports);
  // The nonce is deliberately not persistent: a restart cancels a confirmation, never confirms a skip.
  const armed = new Map<DayKey, { nonce: string; at: number }>();
  const cfg = (): ReportsConfig | null => d.config()?.reports ?? null;

  function write(record: { type: string; reportId: number; [k: string]: unknown }): boolean {
    const r = d.store.append(record);
    if (r) applyRecord(reports, r);
    return r !== null;
  }

  /** Fields from a page: statuses only from the config (deduplicated), text trimmed, energy 1–5 or none. */
  function clean(p: unknown): ReportFields {
    const b = p && typeof p === 'object' ? p as Record<string, unknown> : {};
    const allowed = new Set(cfg()?.statuses ?? []);
    const status = Array.isArray(b.status) ? [...new Set(b.status.filter((x): x is string => typeof x === 'string' && allowed.has(x)))] : [];
    return { feedback: cleanText(b.feedback), status, energy: isEnergy(b.energy) ? b.energy : null };
  }

  function create(timestamp: string, stage: ReportStage | null, fields: ReportFields, source: ReportSource, now: number): ReportResult {
    const id = newId(now, (x) => reports.has(x));
    const ok = write({ type: 'report.created', reportId: id, timestamp, ...(stage ? { stage } : {}), ...fields, source });
    return ok ? { ok: true, report: reports.get(id)! } : { ok: false, error: 'write' };
  }

  const list = (): Report[] => [...reports.values()].filter((r) => r.dismissedAt === null).sort(newestFirst);
  const ofDay = (day: DayKey): Report[] => list().filter((r) => r.day === day);

  function missing(now: number): ReportStub[] {
    const c = cfg();
    if (!c?.startDay) return [];
    const today = dayKey(now);
    const covered = new Set(list().map((r) => r.day));
    const out: ReportStub[] = [];
    for (let i = 0; i < c.stubDays; i++) {
      const day = addDays(today, -i);
      if (day < c.startDay) break;
      if (!covered.has(day)) out.push({ day, weekday: weekday(day), daysAgo: i });
    }
    return out;
  }

  const result = (r: ReportResult): ActionResult => (r.ok ? { ok: true, id: r.report.id } : { ok: false, error: r.error });

  return {
    list,
    get: (id) => reports.get(id) ?? null,
    ofDay,
    missing,
    freshDue: (now) => missing(now).some((s) => s.daysAgo === 1),
    createEndOfWorkday(p, source, now) {
      const fields = clean(p);
      if (isSkipReport(fields)) return { ok: false, error: 'empty' };
      return create(formatTimestamp(now), 'end-of-workday', fields, source, now);
    },
    action(action, payload, now, opts) {
      const c = cfg();
      if (!c) return { ok: false, error: 'unavailable' };
      const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const stub = (): ReportStub | null => {
        const s = missing(now).find((x) => x.day === p.day) ?? null;
        return s && (opts.days?.(s.day) ?? true) ? s : null;
      };
      const existing = (): Report | null => (isId(p.id) ? reports.get(p.id) ?? null : null);
      switch (action) {
        case 'report-new': {
          const fields = clean(p);
          if (isSkipReport(fields)) return { ok: false, error: 'empty' };
          const ts = formatTimestamp(now);
          return result(create(ts, stageAt(ts, c.stages), fields, opts.source, now));
        }
        case 'report-add': {
          const s = stub();
          // Today is reported as of now (`report-new`): a stage still ahead must not stand in for the end of the day.
          if (!s || s.daysAgo === 0) return { ok: false, error: 'day' };
          if (!isStage(p.stage)) return { ok: false, error: 'stage' };
          const fields = clean(p);
          if (isSkipReport(fields)) return { ok: false, error: 'empty' };
          armed.delete(s.day);
          return result(create(catchUpTimestamp(s.day, p.stage, c.stages), p.stage, fields, opts.source, now));
        }
        case 'report-arm-skip': {
          const s = stub();
          if (!s) return { ok: false, error: 'day' };
          const nonce = randomBytes(12).toString('hex');
          armed.set(s.day, { nonce, at: now });
          return { ok: true, nonce, delayMs: s.daysAgo <= 1 ? 800 : 0 };
        }
        case 'report-skip': {
          const s = stub();
          if (!s) return { ok: false, error: 'day' };
          const confirm = armed.get(s.day);
          if (!confirm || p.nonce !== confirm.nonce || now - confirm.at < (s.daysAgo <= 1 ? 800 : 0) || now - confirm.at > 60_000) {
            return { ok: false, error: 'confirmation' };
          }
          armed.delete(s.day);
          return result(create(catchUpTimestamp(s.day, 'end-of-workday', c.stages), null, { feedback: '', status: [], energy: null }, opts.source, now));
        }
        case 'report-edit': {
          const r = existing();
          if (!r || r.dismissedAt !== null) return { ok: false, error: 'unknown' };
          const fields = clean(p);
          if (isSkipReport(fields)) return { ok: false, error: 'empty' };
          if (r.feedback === fields.feedback && r.energy === fields.energy && JSON.stringify(r.status) === JSON.stringify(fields.status)) return { ok: true, id: r.id };
          return write({ type: 'report.edited', reportId: r.id, ...fields }) ? { ok: true, id: r.id } : { ok: false, error: 'write' };
        }
        case 'report-dismiss':
        case 'report-undismiss': {
          const r = existing();
          if (!r) return { ok: false, error: 'unknown' };
          const dismiss = action === 'report-dismiss';
          if ((r.dismissedAt !== null) === dismiss) return { ok: true, id: r.id };
          return write({ type: dismiss ? 'report.dismissed' : 'report.undismissed', reportId: r.id }) ? { ok: true, id: r.id } : { ok: false, error: 'write' };
        }
        default:
          return { ok: false, error: `unknown action ${action}` };
      }
    },
  };
}
