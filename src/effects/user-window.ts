// User-initiated windows (menu items, D-32): opened on request, closed by the owner. Never intrusive, never covering a
// screen, so neither the live gate, R-UI-QUIET nor panic applies (ui-and-tone.md §2). Floating on purpose:
// Hammerspoon has no Dock icon, so a normal window that slipped behind VS Code could not be brought back.
import type { ActionResult, Effect, WindowInput } from '../core/effects.ts';

export type WindowLook = Pick<WindowInput, 'path' | 'title' | 'w' | 'h'>;

export interface UserWindowOptions {
  name: string;
  look: WindowLook;
  model(now: number): unknown;
  actions?: Record<string, (payload: unknown, now: number) => ActionResult>;
}

export function userWindowEffect(o: UserWindowOptions): Effect & { isOpen(): boolean } {
  let open = false;
  let focus = false;
  /** The window is on its way out (the page closes it, or will right after "Saved."): a menu click now = reopen. */
  let closing = false;
  let reopen = false;
  const settle = (keep: boolean): void => {
    open = keep;
    closing = false;
    reopen = false;
  };
  return {
    name: o.name,
    audit: true,
    isOpen: () => open,
    desired() {
      if (!open) return { windows: [], dims: [] };
      return {
        windows: [{ id: o.name, ...o.look, mode: 'floating', placement: 'center', focus: true, closable: true, intrusive: false }],
        dims: [],
      };
    },
    request() {
      if (open && !closing) {
        focus = true; // already open: raise it
        return;
      }
      if (closing) reopen = true; // decided by order, not by time (review M8#5)
      open = true;
    },
    adopt(ids) {
      if (ids.includes(o.name)) open = true;
    },
    focusRequests() {
      if (!focus) return [];
      focus = false;
      return [o.name];
    },
    closed(_id, by) {
      // Any loss (closed by the owner, a Hammerspoon reload, a load failure) ends the request — unless he clicked the
      // menu item again while it was closing.
      settle(reopen && by !== 'load-failed');
    },
    model: (_id, now) => o.model(now),
    action(_id, action, payload, now) {
      if (action === 'close') {
        closing = true;
        open = reopen;
        return { ok: true, close: true };
      }
      const fn = o.actions?.[action];
      if (!fn) return { ok: false, error: `unknown action ${action}` };
      const r = fn(payload, now);
      if (r.close) {
        closing = true;
        open = reopen;
      } else if (r.closing === true) closing = true; // the page closes itself in a moment
      return r;
    },
  };
}
