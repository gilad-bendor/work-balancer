// `prompt-history` provider (raw; ledger R-INFO-4): the owner's own prompts and answers to agent questions, read from
// Copilot's local history (copilot-history-formats.md). Persists per-minute COUNTS and the times of human interactions
// — never text, never hashes of text (D-16, D-43). Human interactions are activity instants for the `work` digest.
import { join } from 'node:path';
import type { PerMinuteInfoProvider, TimeRangeInfoProvider } from '../../core/registry.ts';
import { addDays, dayKey, dayStart, MINUTE_MS, minuteKey, type MinuteKey } from '../../core/time.ts';
import type { Interval } from '../../core/intervals.ts';
import type { Logger } from '../../core/log.ts';
import type { Store } from '../../store/store.ts';
import { isMinuteRecord, type AnyRecord } from '../../store/records.ts';
import type { WorkSource } from '../work/index.ts';
import { strings } from '../../ui/strings.ts';
import { createCliReader, type CliPrompt } from './cli.ts';
import { createTurnIndex } from './turns.ts';
import { createVsReader } from './vscode.ts';
import { classifyCliAnswer, classifyCliPrompt, classifyVsAnswer, classifyVsPrompt, type Klass, type Verdict } from './classify.ts';

export const PROVIDER = 'prompt-history';
export const POLL_MS = 30_000;

export type Source = 'cli' | 'vscode';

export interface PromptMinute {
  /** Human prompts / human answers to agent questions. */
  prompts: number;
  answers: number;
  /** Not decidable (retries, github/cli, …) — never counted as human. */
  unclassified: number;
  /** Agent/subagent/runner/system traffic (insight only). */
  automated: number;
  /** Offsets (ms from the minute) of the human prompts and answers — activity instants for `work`. */
  at: number[];
  /** Human interactions per store. */
  bySource: Partial<Record<Source, number>>;
}

export interface PromptRange {
  prompts: number;
  answers: number;
  unclassified: number;
  automated: number;
  perHour: number;
  firstAt: number | null;
  lastAt: number | null;
  /** Longest gap between consecutive human interactions inside the range. */
  longestSilenceSeconds: number;
}

declare module '../../core/registry.ts' {
  interface ProviderTypeMap {
    'prompt-history': { minute: PromptMinute; range: PromptRange };
  }
}

interface Item {
  source: Source;
  kind: 'prompt' | 'answer';
  at: number;
  cls: Klass;
  rule: string;
}

export interface PromptHistoryProvider extends PerMinuteInfoProvider<PromptMinute>, TimeRangeInfoProvider<PromptRange> {
  load(records: readonly AnyRecord[]): void;
  /** Scans changed history files (at most every POLL_MS unless forced) and writes changed minute records. */
  poll(now: number, opts?: { force?: boolean; write?: boolean }): void;
  /** Today's diagnostics: counts per source/kind/class/rule (no text). */
  diagnostics(from: number, to: number): Record<string, number>;
  /** A menubar warning when the history formats seem to have drifted (copilot-history-formats.md §7.5), else null. */
  warning(now: number, workedTodaySeconds: number): string | null;
  workSource: WorkSource;
}

export function encodePromptMinute(m: PromptMinute): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (m.prompts) o.prompts = m.prompts;
  if (m.answers) o.answers = m.answers;
  if (m.unclassified) o.unclassified = m.unclassified;
  if (m.automated) o.automated = m.automated;
  if (m.at.length) o.at = m.at;
  if (Object.keys(m.bySource).length) o.bySource = m.bySource;
  return o;
}

export function decodePromptMinute(data: unknown): PromptMinute {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const bySource: Partial<Record<Source, number>> = {};
  if (d.bySource && typeof d.bySource === 'object') {
    for (const [k, v] of Object.entries(d.bySource)) if ((k === 'cli' || k === 'vscode') && typeof v === 'number') bySource[k] = v;
  }
  return {
    prompts: n(d.prompts), answers: n(d.answers), unclassified: n(d.unclassified), automated: n(d.automated),
    at: Array.isArray(d.at) ? d.at.filter((x): x is number => typeof x === 'number') : [],
    bySource,
  };
}

const total = (m: PromptMinute): number => m.prompts + m.answers + m.unclassified + m.automated;

export function createPromptHistoryProvider(opts: {
  store: Store;
  log: Logger;
  now: () => number;
  /** The home dir whose ~/.copilot and ~/Library/Application Support are read. */
  home: string;
  /** Input activity from `interactive` (C8 corroboration). */
  inputActivity: (from: number, to: number) => readonly Interval[];
}): PromptHistoryProvider {
  const { store, log } = opts;
  const appSupport = join(opts.home, 'Library', 'Application Support');
  const cli = createCliReader({ dir: join(opts.home, '.copilot', 'session-state') });
  const turns = createTurnIndex({ dir: join(appSupport, 'Code', 'agentSessionData'), log });
  const vs = createVsReader({ appSupport });

  /** Only interactions at/after the day start of the daemon's start are read from history (R-INFO-4). */
  const windowStart = dayStart(dayKey(opts.now()));
  const items = new Map<string, Item>();
  const pending = new Map<string, CliPrompt>();
  const sessionRunner = new Map<string, boolean>();
  const seenCliIds = new Set<string>();
  /** Minute aggregates: loaded records, overwritten by recomputation for minutes with items. */
  const minutes = new Map<MinuteKey, PromptMinute>();
  const written = new Map<MinuteKey, PromptMinute>();
  let lastPoll = -Infinity;
  let version = 0;

  const hadInput = (from: number, to: number): boolean => opts.inputActivity(from, to).length > 0;

  function settle(key: string, source: Source, kind: Item['kind'], at: number, v: Verdict): void {
    if (at < windowStart) return;
    items.set(key, { source, kind, at, cls: v.cls, rule: v.rule });
  }

  function resolvePending(now: number): void {
    // In time order, so a session's first main prompt (which decides "runner-launched") is settled first.
    for (const p of [...pending.values()].sort((a, b) => a.at - b.at)) {
      const d = classifyCliPrompt(p, { turn: turns.turnFor(p.sessionId, p.id), sessionRunner: sessionRunner.get(p.sessionId), now, hadInput });
      if (d === 'pending') continue;
      pending.delete(p.id);
      if (p.firstMain) sessionRunner.set(p.sessionId, d.rule === 'C3' || d.rule === 'C4');
      settle(`cli:${p.id}`, 'cli', 'prompt', p.at, d);
    }
  }

  function aggregate(): Set<MinuteKey> {
    const fresh = new Map<MinuteKey, PromptMinute>();
    for (const it of items.values()) {
      if (it.cls === 'skip') continue;
      const m = minuteKey(it.at);
      const agg = fresh.get(m) ?? { prompts: 0, answers: 0, unclassified: 0, automated: 0, at: [], bySource: {} };
      if (it.cls === 'human') {
        if (it.kind === 'prompt') agg.prompts++;
        else agg.answers++;
        agg.at.push(it.at - m);
        agg.bySource[it.source] = (agg.bySource[it.source] ?? 0) + 1;
      } else if (it.cls === 'unclassified') agg.unclassified++;
      else agg.automated++;
      fresh.set(m, agg);
    }
    const changed = new Set<MinuteKey>();
    for (const [m, agg] of fresh) {
      agg.at.sort((a, b) => a - b);
      const prev = minutes.get(m);
      if (prev && JSON.stringify(encodePromptMinute(prev)) === JSON.stringify(encodePromptMinute(agg))) continue;
      minutes.set(m, agg);
      changed.add(m);
    }
    return changed;
  }

  /** Every minute whose value differs from what was last written (so a failed write is retried next poll). */
  function write(): void {
    for (const m of [...minutes.keys()].sort((a, b) => a - b)) {
      const agg = minutes.get(m)!;
      const prev = written.get(m);
      if (prev && JSON.stringify(encodePromptMinute(prev)) === JSON.stringify(encodePromptMinute(agg))) continue;
      // Never shrink a persisted minute (e.g. its source file was deleted before a restart's re-scan).
      if (prev && total(agg) < total(prev)) continue;
      if (store.append({ type: 'minute', provider: PROVIDER, minute: m, data: encodePromptMinute(agg) })) written.set(m, agg);
    }
  }

  const provider: PromptHistoryProvider = {
    name: PROVIDER,
    dependsOn: ['interactive'],

    load(records) {
      for (const r of records) {
        if (!isMinuteRecord(r) || r.provider !== PROVIDER) continue;
        const d = decodePromptMinute(r.data);
        minutes.set(r.minute, d);
        written.set(r.minute, d);
      }
      version++;
    },

    poll(now, pollOpts) {
      if (!pollOpts?.force && now - lastPoll < POLL_MS) return;
      lastPoll = now;
      try {
        turns.refresh(windowStart);
        const onError = (where: string, e: unknown): void => log.warn('prompt-history: file skipped this poll', { where, error: (e as Error).message });
        for (const c of cli.poll(windowStart, seenCliIds, onError)) {
          // A copy of an already-seen event (continued session, C0) must never replace the original's verdict.
          if (c.duplicate) {
            settle(`cli-dup:${c.sessionId}:${c.id}`, 'cli', c.kind, c.at, { cls: 'skip', rule: 'C0' });
            if (c.kind === 'prompt' && c.firstMain && !sessionRunner.has(c.sessionId)) sessionRunner.set(c.sessionId, false);
          } else if (c.kind === 'answer') settle(`cli:${c.id}`, 'cli', 'answer', c.at, classifyCliAnswer(c));
          else if (c.at >= windowStart || c.firstMain) pending.set(c.id, c);
        }
        for (const c of vs.poll(windowStart, onError)) {
          settle(`vscode:${c.id}`, 'vscode', c.kind, c.at, c.kind === 'prompt' ? classifyVsPrompt(c) : classifyVsAnswer(c));
        }
        resolvePending(now);
        const changed = aggregate();
        if (changed.size) version++;
        if (pollOpts?.write !== false) write();
      } catch (e) {
        log.error('prompt-history poll failed (skipped; retried next poll)', { error: e as Error });
      }
      // Bounded memory: drop items older than yesterday's start.
      const keepFrom = dayStart(addDays(dayKey(now), -1));
      for (const [k, it] of items) if (it.at < keepFrom) items.delete(k);
    },

    getMinuteInfo: (m) => minutes.get(m) ?? null,

    getRangeInfo(start, end) {
      const r: PromptRange = { prompts: 0, answers: 0, unclassified: 0, automated: 0, perHour: 0, firstAt: null, lastAt: null, longestSilenceSeconds: 0 };
      const instants: number[] = [];
      let any = false;
      for (const [m, d] of minutes) {
        if (m < start || m >= end) continue;
        any = true;
        r.prompts += d.prompts;
        r.answers += d.answers;
        r.unclassified += d.unclassified;
        r.automated += d.automated;
        for (const o of d.at) instants.push(m + o);
      }
      if (!any) return null;
      instants.sort((a, b) => a - b);
      r.firstAt = instants[0] ?? null;
      r.lastAt = instants.at(-1) ?? null;
      for (let i = 1; i < instants.length; i++) r.longestSilenceSeconds = Math.max(r.longestSilenceSeconds, (instants[i]! - instants[i - 1]!) / 1000);
      const hours = (Math.min(end, opts.now()) - start) / 3_600_000;
      r.perHour = hours > 0 ? (r.prompts + r.answers) / hours : 0;
      return r;
    },

    diagnostics(from, to) {
      const out: Record<string, number> = {};
      for (const it of items.values()) {
        if (it.at < from || it.at >= to) continue;
        const k = `${it.source}.${it.kind}.${it.cls}.${it.rule}`;
        out[k] = (out[k] ?? 0) + 1;
      }
      out['cli.prompt.pending'] = pending.size;
      return out;
    },

    warning(now, workedTodaySeconds) {
      const from = dayStart(dayKey(now));
      let any = 0;
      let c6 = 0;
      let c9 = 0;
      for (const it of items.values()) {
        if (it.at < from) continue;
        any++;
        if (it.rule === 'C6') c6++;
        if (it.rule === 'C9') c9++;
      }
      if (c9 >= 3 && c6 === 0) return strings.promptHistoryTurnsDrift;
      // Only when history was parsed on earlier days this week: a day without Copilot use is not drift.
      const hadHistoryBefore = [...minutes.keys()].some((m) => m < from);
      if (any === 0 && hadHistoryBefore && workedTodaySeconds >= 3 * 3600) return strings.promptHistoryNothingParsed;
      return null;
    },

    workSource: {
      name: PROVIDER,
      activity(from, to) {
        const out: Interval[] = [];
        for (const [m, d] of minutes) {
          if (m + MINUTE_MS <= from || m >= to) continue;
          for (const o of d.at) out.push([m + o, m + o]);
        }
        return out;
      },
      version: () => version,
    },
  };
  return provider;
}
