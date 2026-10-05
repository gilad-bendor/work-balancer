// Shared helper for every page (served type-stripped by src/ui/serve.ts). The page URL carries `token`, `win`
// (window id), `screen` and `primary` (Lua adds them; in a browser add them by hand).

type Strings = Record<string, string>;

interface WbHandler {
  postMessage(msg: unknown): void;
}

const q = new URLSearchParams(location.search);
export const token = q.get('token') ?? '';
export const windowId = q.get('win') ?? '';
export const isPrimary = q.get('primary') !== '0';

function luaPort(): WbHandler | null {
  const w = window as unknown as { webkit?: { messageHandlers?: { wb?: WbHandler } } };
  return w.webkit?.messageHandlers?.wb ?? null;
}

/** True inside a Hammerspoon webview (Lua can close the window right away). */
export const inHammerspoon = luaPort() !== null;

/** Tells Lua: `close` this window now (it reports `by: page`), `push` a heartbeat now, `failed` (fail open), or
 * `ready` (rendered — without it Lua treats the page as failed after 15 s). */
export function tellLua(op: 'close' | 'push' | 'failed' | 'ready'): void {
  try {
    luaPort()?.postMessage({ op, win: windowId });
  } catch {
    // no Lua: a browser preview
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-wb-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Runs a page action; if the daemon says so (or cannot be reached), the window closes right away. */
export async function act<T = Record<string, unknown>>(action: string, payload?: unknown): Promise<T & { ok: boolean; close?: boolean }> {
  try {
    const r = await api<T & { ok: boolean; close?: boolean }>('/api/ui/action', { win: windowId, action, payload });
    if (r.close) tellLua('close');
    return r;
  } catch (e) {
    // Fail open: a page that cannot talk to the daemon must never keep the owner stuck.
    if (action === 'close') tellLua('close');
    throw e;
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

/**
 * Loads strings + model and renders. Any failure shows the kind fallback text and asks Lua to fail open (close after a
 * minute, ledger R-UI-ESC / principle 5).
 */
export async function boot<M>(render: (ctx: { strings: Strings; model: M; env: string }) => void | Promise<void>): Promise<void> {
  let strings: Strings = {};
  try {
    const s = await api<{ env: string; strings: Strings }>('/api/ui/strings');
    strings = s.strings;
    const m = await api<{ env: string; model: M }>(`/api/ui/model?win=${encodeURIComponent(windowId)}`);
    if (m.env !== 'live') document.body.classList.add('env-dev');
    document.body.dataset.badge = strings.devBadge ?? 'DEV';
    await render({ strings, model: m.model, env: m.env });
    tellLua('ready');
  } catch (e) {
    console.error(e);
    document.body.replaceChildren(el('main', { class: 'card' }, el('p', {}, strings.loadFailed ?? "This window couldn't load. It will close by itself in a minute.")));
    tellLua('failed');
  }
}
