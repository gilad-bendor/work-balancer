// Human vs automated (copilot-history-formats.md §3). Pure. `pending` = decide later (turn row may land late — C9;
// `interactive` corroboration needs its samples — C8).
import type { CliAnswer, CliPrompt } from './cli.ts';
import type { VsAnswer, VsPrompt } from './vscode.ts';

export type Klass = 'human' | 'automated' | 'unclassified' | 'skip';
export interface Verdict {
  cls: Klass;
  rule: string;
}
export type Decision = Verdict | 'pending';

/** Wait this long for an agent-host turn row before giving up (C9). */
export const TURN_ROW_WAIT_MS = 5 * 60_000;
/** Interactive samples arrive within seconds; decide C8 after this delay. */
export const CORROBORATION_DELAY_MS = 2 * 60_000;
/** C8: input this close before a runner-session follow-up means the owner typed it. */
export const CORROBORATION_WINDOW_MS = 60_000;

export interface CliContext {
  /** Turn id from the agent-host index: undefined = session not indexed; null = indexed, row missing (yet). */
  turn: string | null | undefined;
  /** The session's first main prompt was a runner launch (C3/C4); undefined = not decided yet. */
  sessionRunner: boolean | undefined;
  now: number;
  hadInput(from: number, to: number): boolean;
}

export function classifyCliPrompt(p: CliPrompt, ctx: CliContext): Decision {
  if (p.duplicate) return { cls: 'skip', rule: 'C0' };
  if (p.subagent) return { cls: 'automated', rule: 'C1' };
  if (p.system) return { cls: 'automated', rule: 'C2' };
  if (p.runnerMarker) return { cls: 'automated', rule: 'C3' };
  if (typeof ctx.turn === 'string' && !ctx.turn.startsWith('request_')) return { cls: 'automated', rule: 'C4' };
  if (p.retryOfPrev) return { cls: 'unclassified', rule: 'C5' };
  if (typeof ctx.turn === 'string') return { cls: 'human', rule: 'C6' };
  // Owner (Q-14): `github/cli` sessions are headless tool calls launched by other processes — not him.
  if (p.clientName === 'github/cli') return { cls: 'automated', rule: 'C7' };
  if (!p.firstMain && ctx.turn === undefined) {
    if (ctx.sessionRunner === undefined) return 'pending';
    if (ctx.sessionRunner) {
      if (ctx.now - p.at < CORROBORATION_DELAY_MS) return 'pending';
      return ctx.hadInput(p.at - CORROBORATION_WINDOW_MS, p.at) ? { cls: 'human', rule: 'C8' } : { cls: 'unclassified', rule: 'C8' };
    }
  }
  if (p.clientName === 'vscode-agent-host') {
    return ctx.now - p.at < TURN_ROW_WAIT_MS ? 'pending' : { cls: 'unclassified', rule: 'C9' };
  }
  return { cls: 'human', rule: 'C10' };
}

export function classifyCliAnswer(a: CliAnswer): Verdict {
  if (a.duplicate) return { cls: 'skip', rule: 'C0' };
  return a.answered ? { cls: 'human', rule: 'A1' } : { cls: 'unclassified', rule: 'A2' };
}

export function classifyVsPrompt(p: VsPrompt): Verdict {
  if (p.system) return { cls: 'automated', rule: 'V1' };
  if (p.runnerMarker) return { cls: 'automated', rule: 'V2' };
  if (p.retry) return { cls: 'unclassified', rule: 'V3' };
  if (p.blank) return { cls: 'automated', rule: 'V4' };
  return { cls: 'human', rule: 'V5' };
}

export function classifyVsAnswer(_a: VsAnswer): Verdict {
  return { cls: 'human', rule: 'VA1' };
}
