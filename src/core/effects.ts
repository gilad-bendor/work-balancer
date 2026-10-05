// UI effect contracts (instructions §4.3). The daemon computes the *desired* UI; Lua reports the *actual* UI; the
// reconciler (src/effects/reconcile.ts) diffs them into idempotent commands. Lua is a dumb actuator: it only knows
// window modes, placements and the panic/quit latches — never why a window exists.

export type StatusColour = 'green' | 'orange' | 'red' | 'grey' | 'none';

/** What the menubar should show; sent in every heartbeat reply. */
export interface MenubarSpec {
  title: string;
  colour: StatusColour;
  tooltip: string;
  /** Shown as a warning glyph + tooltip line (config invalid, write error, protocol mismatch …). */
  warning: string | null;
  /** The menu any click opens (D-32); a click on an item posts `/bridge/ui-request {open: id}`. Lua keeps the last
   * one it received (and its own minimal fallback while the daemon is down). */
  menu?: MenuItem[];
}

export interface MenuItem {
  /** Effect name to request (`quick`, `summary`, `notes`, `quit`), or `-` for a separator. */
  id: string;
  title: string;
}

/**
 * normal   — an ordinary window (title bar, joins the current space).
 * floating — above normal windows, on every space and over full-screen apps; never steals focus unless `focus`.
 * overlay  — above everything incl. the menubar and full-screen apps, borderless (the block).
 */
export type WindowMode = 'normal' | 'floating' | 'overlay';
export type Placement = 'center' | 'top-right' | 'bottom-right' | 'full';

/** A window as an effect describes it. Ids are `<effect>` or `<effect>:<suffix>`. */
export interface WindowInput {
  id: string;
  /** Page path on the daemon, e.g. `/ui/fixture.html?mode=overlay`; Lua appends token, window id and screen. */
  path: string;
  mode: WindowMode;
  placement: Placement;
  /** Size in points; a value in (0, 1] is a fraction of the screen's usable frame (0.9 = 90 %). */
  w?: number;
  h?: number;
  /** One instance per screen (overlays); the page gets `primary=1` on the primary screen. */
  perScreen?: boolean;
  /** Take keyboard focus when shown (text entry). Otherwise the window never steals focus. */
  focus?: boolean;
  /** Native close button (normal/floating only). */
  closable?: boolean;
  title: string;
  /**
   * System-initiated (dialogs, dims, countdown, block, nudges, review): gated in `live` until the owner enables
   * effects, suppressed by Lua's panic latch, and deferred by R-UI-QUIET. User-initiated windows (opened from the
   * menu) are not.
   */
  intrusive: boolean;
  /** Window opacity 0.2–1 (set by the manager for screen-covering windows from `overlayOpacity`). */
  opacity?: number;
}

/** A window with its revision (hash of the spec): a different rev means Lua must rebuild the window. */
export interface WindowSpec extends WindowInput {
  rev: string;
}

/** A one-shot gamma dim pulse; Lua restores gamma after `seconds` (hard-capped in Lua) and never runs a pulse twice. */
export interface DimSpec {
  pulseId: string;
  /** Screen brightness factor during the pulse (1 = no dim). */
  level: number;
  seconds: number;
  /** Any input ends the pulse early (the inactivity pre-warning, D-33). */
  cancelOnInput?: boolean;
}

export interface DesiredUi {
  windows: WindowSpec[];
  dims: DimSpec[];
}

/** How a window went away (reported by Lua). */
/** `reload` is inferred by the daemon: an audited window vanished without a close report (Lua reloaded). */
export type CloseBy = 'user' | 'page' | 'system' | 'panic' | 'failopen' | 'load-failed' | 'reload';

export interface ClosedWindow {
  id: string;
  by: CloseBy;
  at: number;
}

/** Actual UI as reported by Lua in every heartbeat. */
export interface ActualUi {
  /** Window id → rev of what is on screen. */
  windows: Record<string, string>;
  dimmed: boolean;
  closed: ClosedWindow[];
}

/** An idempotent command for Lua; acked by id in the next heartbeat. */
export type UiCommand =
  | { id: string; op: 'window.open'; window: WindowSpec }
  | { id: string; op: 'window.close'; windowId: string }
  /** Bring an open window to the front with key focus (a menu item clicked again). */
  | { id: string; op: 'window.focus'; windowId: string }
  | { id: string; op: 'dim'; dim: DimSpec };

/** Result of a page action (`POST /api/ui/action`). */
export interface ActionResult {
  ok: boolean;
  /** The page should close its window right away (it tells Lua; the reconciler would close it a beat later). */
  close?: boolean;
  error?: string;
  [k: string]: unknown;
}

/** An effect = a named UI behaviour. Window ids are prefixed with the effect name. */
export interface Effect {
  readonly name: string;
  /** Log `effect.shown` / `effect.closed` into data/ (false for test windows). */
  readonly audit: boolean;
  /** Explicitly requested test windows bypass the live gate (still subject to panic and R-UI-QUIET). */
  readonly gateExempt?: boolean;
  desired(now: number): { windows: WindowInput[]; dims: DimSpec[] };
  /** The owner asked for this effect's window (menu click, `POST /bridge/ui-request`). User-initiated effects only. */
  request?(now: number): void;
  /** First heartbeat after a daemon start: this effect's windows Lua still shows (a restart must not close them). */
  adopt?(windowIds: string[], now: number): void;
  /** Windows to raise with key focus (drained every heartbeat; ignored for windows not on screen). */
  focusRequests?(): string[];
  /** Lua reported the window gone. `user`/`page` mean dismissed; other causes leave the decision to the effect. */
  closed?(windowId: string, by: CloseBy, now: number): void;
  /** JSON model the page renders (`GET /api/ui/model?win=`). */
  model?(windowId: string, now: number): unknown;
  action?(windowId: string, action: string, payload: unknown, now: number): ActionResult;
}
