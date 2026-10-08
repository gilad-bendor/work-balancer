// Policy config: the type the owner's config/policy.ts satisfies, its validation, and a hot-reloading loader with a
// last-good snapshot (instructions §4.2, ledger R-POL-1/2). An invalid config never crashes the daemon.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../core/log.ts';
import { WEEKDAYS, type Weekday } from '../core/time.ts';
import { validReportDay } from '../reports/reports.ts';

export interface DayPolicy {
  /** Show worked time in the menubar. */
  menubar: boolean;
  /** Colour the menubar (Saturday: false). */
  colours: boolean;
  /** Enforced daily budget in minutes, or null (no budget). */
  dailyBudgetMin: number | null;
  /** Colour-only reference on non-enforcing days (e.g. 9 h), or null. */
  referenceMin: number | null;
  /** Warn → countdown → block on this day. Requires dailyBudgetMin. */
  enforce: boolean;
  inactivityDialog: boolean;
  breakNudge: boolean;
  /** Morning review at the 04:00 rollover *into* this day. */
  morningReview: boolean;
}

export interface ReportsConfig {
  /** Days without a report are asked for from this day on (YYYY-MM-DD); null = never. */
  startDay: string | null;
  /** The "How are you doing?" values a report may pick from. */
  statuses: string[];
  /** Stage of a report by its time of day: morning from 04:00, afternoon from `afternoonFrom`, evening from
   * `eveningFrom` to the next 04:00 (HH:MM). A catch-up report for an earlier stage is timed at the middle of its range;
   * an end-of-workday catch-up at `endOfWorkdayAt`. */
  stages: { afternoonFrom: string; eveningFrom: string; endOfWorkdayAt: string };
  /** Manage Reports lists at most this many reports. */
  listMax: number;
  /** Manage Reports shows a stub for each of the last N days (today included) without a report. */
  stubDays: number;
}

export interface PolicyConfig {
  reports: ReportsConfig;
  /** Weekly budget in worked minutes (week = Sun 04:00 → Sun 04:00; all days count). */
  weeklyBudgetMin: number;
  /** R-INFO-3: a moment is busy if there was input in the preceding N minutes; also the inactivity threshold. */
  busyGraceMin: number;
  ladder: {
    /** `orange` at ≥ this fraction of the effective limit. */
    orangeAtFraction: number;
    /** `warn` at limit − N worked minutes. */
    warnBeforeMin: number;
    /** `countdown` at limit − N worked minutes. */
    countdownBeforeMin: number;
  };
  /** Postpone tokens per enforcing day, wall-clock minutes each. */
  tokensMin: number[];
  bypass: { minutes: number; phrase: string };
  breakNudge: { afterMin: number; snoozeMin: number };
  days: Record<Weekday, DayPolicy>;
  /**
   * Live gate (ledger D-48): system-initiated effects (dialogs, dims, countdown, block, nudges, morning review) run on
   * the live instance only when true. The owner flips it once he approves enforcement (M10). The dev instance ignores
   * it. Default false.
   */
  liveEffects?: boolean;
  /** R-UI-QUIET (D-34, Q-13): no effect starts within `afterInputSec` of input, unless due for `maxDeferSec`. */
  quiet?: { afterInputSec: number; maxDeferSec: number };
  /** Opacity (0.2–1) of every window that covers a whole screen (overlay mode or full placement). Default 1. */
  overlayOpacity?: number;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type ValidationResult = { ok: true; config: PolicyConfig } | { ok: false; errors: string[] };

export function validatePolicy(x: unknown): ValidationResult {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const num = (v: unknown, path: string, min: number, max: number): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) errors.push(`${path} must be a number in [${min}, ${max}], got ${JSON.stringify(v)}`);
  };
  const bool = (v: unknown, path: string): void => {
    if (typeof v !== 'boolean') errors.push(`${path} must be true or false, got ${JSON.stringify(v)}`);
  };
  const nullableMin = (v: unknown, path: string): void => {
    if (v !== null) num(v, path, 0, 24 * 60);
  };
  if (!isObj(x)) return { ok: false, errors: ['the default export must be an object'] };
  if (!isObj(x.reports)) errors.push('reports must be an object');
  else {
    const r = x.reports;
    if (r.startDay !== null && !validReportDay(r.startDay)) errors.push('reports.startDay must be a real YYYY-MM-DD date or null');
    if (!Array.isArray(r.statuses) || Array.from(r.statuses).some((c) => typeof c !== 'string' || !c.trim())) {
      errors.push('reports.statuses must be an array of non-empty strings');
    }
    num(r.listMax, 'reports.listMax', 1, 100_000);
    num(r.stubDays, 'reports.stubDays', 0, 366);
    if (!isObj(r.stages)) errors.push('reports.stages must be an object');
    else {
      const { afternoonFrom: a, eveningFrom: e, endOfWorkdayAt: w } = r.stages;
      for (const [k, v] of [['afternoonFrom', a], ['eveningFrom', e], ['endOfWorkdayAt', w]] as const) {
        if (typeof v !== 'string' || !HHMM.test(v)) errors.push(`reports.stages.${k} must be HH:MM`);
      }
      if (typeof a === 'string' && typeof e === 'string' && HHMM.test(a) && HHMM.test(e) && !('04:00' < a && a < e)) {
        errors.push('reports.stages must satisfy 04:00 < afternoonFrom < eveningFrom');
      }
    }
  }

  num(x.weeklyBudgetMin, 'weeklyBudgetMin', 0, 7 * 24 * 60);
  num(x.busyGraceMin, 'busyGraceMin', 1, 60);
  if (!isObj(x.ladder)) errors.push('ladder must be an object');
  else {
    num(x.ladder.orangeAtFraction, 'ladder.orangeAtFraction', 0, 1);
    num(x.ladder.warnBeforeMin, 'ladder.warnBeforeMin', 0, 24 * 60);
    num(x.ladder.countdownBeforeMin, 'ladder.countdownBeforeMin', 0, 24 * 60);
    if (typeof x.ladder.warnBeforeMin === 'number' && typeof x.ladder.countdownBeforeMin === 'number' && x.ladder.countdownBeforeMin > x.ladder.warnBeforeMin) {
      errors.push('ladder.countdownBeforeMin must be ≤ ladder.warnBeforeMin');
    }
  }
  if (!Array.isArray(x.tokensMin)) errors.push('tokensMin must be an array of minutes');
  else for (let i = 0; i < x.tokensMin.length; i++) num(x.tokensMin[i], `tokensMin[${i}]`, 1, 240); // also catches holes
  if (!isObj(x.bypass)) errors.push('bypass must be an object');
  else {
    num(x.bypass.minutes, 'bypass.minutes', 1, 240);
    if (typeof x.bypass.phrase !== 'string' || x.bypass.phrase.trim().length < 20) errors.push('bypass.phrase must be a string of at least 20 characters');
  }
  if (!isObj(x.breakNudge)) errors.push('breakNudge must be an object');
  else {
    num(x.breakNudge.afterMin, 'breakNudge.afterMin', 1, 24 * 60);
    num(x.breakNudge.snoozeMin, 'breakNudge.snoozeMin', 1, 24 * 60);
  }
  if (x.liveEffects !== undefined) bool(x.liveEffects, 'liveEffects');
  if (x.overlayOpacity !== undefined) num(x.overlayOpacity, 'overlayOpacity', 0.2, 1);
  if (x.quiet !== undefined) {
    if (!isObj(x.quiet)) errors.push('quiet must be an object');
    else {
      num(x.quiet.afterInputSec, 'quiet.afterInputSec', 0, 120);
      num(x.quiet.maxDeferSec, 'quiet.maxDeferSec', 0, 3600);
    }
  }
  if (!isObj(x.days)) errors.push('days must be an object with sun..sat');
  else {
    for (const wd of WEEKDAYS) {
      const d = x.days[wd];
      const p = `days.${wd}`;
      if (!isObj(d)) {
        errors.push(`${p} is missing`);
        continue;
      }
      for (const k of ['menubar', 'colours', 'enforce', 'inactivityDialog', 'breakNudge', 'morningReview'] as const) bool(d[k], `${p}.${k}`);
      nullableMin(d.dailyBudgetMin, `${p}.dailyBudgetMin`);
      nullableMin(d.referenceMin, `${p}.referenceMin`);
      if (d.enforce === true && d.dailyBudgetMin === null) errors.push(`${p}.enforce needs a dailyBudgetMin`);
    }
    for (const k of Object.keys(x.days)) if (!(WEEKDAYS as readonly string[]).includes(k)) errors.push(`days.${k} is not a weekday (use sun..sat)`);
    // Shabbat: tracking only, no popups at all (principle 6 — not configurable).
    const sat = x.days.sat;
    if (isObj(sat)) for (const k of ['enforce', 'inactivityDialog', 'breakNudge', 'morningReview'] as const) if (sat[k] === true) errors.push(`days.sat.${k} must be false (Shabbat: nothing intrusive)`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: x as unknown as PolicyConfig };
}

export function configHash(config: PolicyConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);
}

export type ConfigSource = 'file' | 'snapshot' | 'none';

export interface ConfigState {
  /** null = tracking-only (no valid config and no snapshot). */
  config: PolicyConfig | null;
  source: ConfigSource;
  hash: string | null;
  /** Errors of the latest load attempt (non-empty = the file is currently invalid). */
  errors: string[];
}

export type ConfigEvent = { type: 'config.loaded'; hash: string; source: ConfigSource } | { type: 'config.invalid'; errors: string[] };

export interface PolicyLoader {
  state(): ConfigState;
  /** Re-imports the file when its mtime changed (or on the first call). Returns true when the state changed. */
  refresh(): Promise<boolean>;
}

export function createPolicyLoader(opts: { path: string; snapshotPath: string; log: Logger; onEvent?: (e: ConfigEvent) => void }): PolicyLoader {
  let state: ConfigState = { config: null, source: 'none', hash: null, errors: [] };
  let seenMtime: number | null = null;

  async function importFile(mtime: number): Promise<ValidationResult> {
    try {
      const mod = (await import(`${pathToFileURL(opts.path).href}?v=${mtime}`)) as { default?: unknown };
      return validatePolicy(mod.default);
    } catch (e) {
      return { ok: false, errors: [`cannot load ${opts.path}: ${(e as Error).message.split('\n')[0]}`] };
    }
  }

  function readSnapshot(): PolicyConfig | null {
    try {
      const r = validatePolicy(JSON.parse(readFileSync(opts.snapshotPath, 'utf8')));
      return r.ok ? r.config : null;
    } catch {
      return null;
    }
  }

  function writeSnapshot(config: PolicyConfig): void {
    try {
      mkdirSync(dirname(opts.snapshotPath), { recursive: true });
      const tmp = `${opts.snapshotPath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
      renameSync(tmp, opts.snapshotPath);
    } catch (e) {
      opts.log.warn('cannot write policy snapshot', { error: e as Error });
    }
  }

  return {
    state: () => state,
    async refresh() {
      let mtime: number;
      try {
        mtime = statSync(opts.path).mtimeMs;
      } catch {
        mtime = -1; // missing file → treated as invalid below
      }
      if (seenMtime === mtime) return false;
      seenMtime = mtime;
      let r: ValidationResult = mtime < 0 ? { ok: false, errors: [`${opts.path} does not exist`] } : await importFile(mtime);
      let hash = '';
      if (r.ok) {
        try {
          hash = configHash(r.config); // e.g. a circular extra field passes validation but cannot be hashed
        } catch (e) {
          r = { ok: false, errors: [`cannot use ${opts.path}: ${(e as Error).message}`] };
        }
      }
      if (r.ok) {
        const changed = hash !== state.hash || state.source !== 'file' || state.errors.length > 0;
        state = { config: r.config, source: 'file', hash, errors: [] };
        writeSnapshot(r.config);
        if (changed) {
          opts.log.info('policy loaded', { hash });
          opts.onEvent?.({ type: 'config.loaded', hash, source: 'file' });
        }
        return changed;
      }
      opts.log.warn('policy invalid', { errors: r.errors });
      opts.onEvent?.({ type: 'config.invalid', errors: r.errors });
      if (state.config) {
        state = { ...state, errors: r.errors }; // keep the previous config
      } else {
        const snap = readSnapshot();
        state = snap
          ? { config: snap, source: 'snapshot', hash: configHash(snap), errors: r.errors }
          : { config: null, source: 'none', hash: null, errors: r.errors };
        if (snap) opts.onEvent?.({ type: 'config.loaded', hash: configHash(snap), source: 'snapshot' });
      }
      return true;
    },
  };
}
