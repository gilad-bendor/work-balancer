// UI effect contracts (instructions §4.3). The daemon computes the *desired* UI; Lua reports the *actual* UI;
// the reconciler (M7) diffs them into idempotent commands. M3/M4 only use the menubar.

export type StatusColour = 'green' | 'orange' | 'red' | 'grey' | 'none';

/** What the menubar should show; sent in every heartbeat reply. */
export interface MenubarSpec {
  title: string;
  colour: StatusColour;
  tooltip: string;
  /** Shown as a warning glyph + tooltip line (config invalid, write error, protocol mismatch …). */
  warning: string | null;
}

/** An idempotent command for Lua; acked by id in the next heartbeat. */
export interface UiCommand {
  id: string;
  op: string;
  [k: string]: unknown;
}

/** Actual UI as reported by Lua. */
export interface ActualUi {
  windows: string[];
  dimmed: boolean;
}

export interface Effect<Input> {
  readonly name: string;
  /** Window ids (and their specs, from M7) this effect wants open for the given input. */
  desired(input: Input): { windows: string[] };
}
