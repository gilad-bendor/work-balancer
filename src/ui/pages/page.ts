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

/** Tells Lua: `close` this window now (it reports `by: page`), `push` a heartbeat now, `failed` (fail open),
 * `ready` (rendered — without it Lua treats the page as failed after 15 s), `focus` (the owner clicked into a window
 * that did not take focus when it opened — let him type), or `quit` (only honoured from the quit window). */
export function tellLua(op: 'close' | 'push' | 'failed' | 'ready' | 'focus' | 'quit'): void {
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
export async function act<T = Record<string, unknown>>(action: string, payload?: unknown): Promise<T & { ok: boolean; close?: boolean; error?: string }> {
  try {
    const r = await api<T & { ok: boolean; close?: boolean; error?: string }>('/api/ui/action', { win: windowId, action, payload });
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

/** For windows opened without focus (they must not steal keystrokes): the owner's own click gives them focus. */
export function focusOnInteract(): void {
  document.addEventListener('pointerdown', () => {
    if (!document.hasFocus()) tellLua('focus');
  }, true);
}

/** Closes the window through the daemon; if it cannot be reached, closes it anyway (fail open). */
export function closeWindow(): void {
  void act('close').catch(() => tellLua('close'));
}

/** A static top bar (stays put while the page scrolls): the title and a large close icon. */
export function topBar(title: string, closeLabel: string): HTMLElement {
  const x = el('button', { class: 'close-x', 'aria-label': closeLabel, title: closeLabel }, '✕');
  x.addEventListener('click', closeWindow);
  return el('header', { class: 'topbar' }, el('h1', {}, title), x);
}

/** Cmd+Enter in a text box submits (like the button next to it). */
export function submitOnCmdEnter(box: HTMLElement, submit: () => void): void {
  box.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
}

/**
 * Esc closes a dismissible window (never used by the countdown / block). An open note editor takes Esc first. With
 * unsaved text in a box, the first Esc only says so; a second Esc within 3 s closes (review M8#4: never lose his words
 * to a stray key).
 */
export function closeOnEscape(unsavedHint: string): void {
  let armedAt = -Infinity;
  let hint: HTMLElement | null = null;
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    e.preventDefault();
    const unsaved = [...document.querySelectorAll('textarea, input[type=text]')].some((b) => (b as HTMLTextAreaElement).value.trim() !== '' && !(b as HTMLElement).dataset.saved);
    if (unsaved && performance.now() - armedAt > 3000) {
      armedAt = performance.now();
      hint?.remove();
      hint = el('div', { class: 'esc-hint', role: 'status' }, unsavedHint);
      document.body.append(hint);
      setTimeout(() => hint?.remove(), 3000);
      return;
    }
    closeWindow();
  });
}
