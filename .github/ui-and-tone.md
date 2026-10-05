# UI and tone — `work-balancer`

**When to read me:** before touching any page (`src/ui/`), any user-facing wording (`src/ui/strings.ts`), any effect
(`src/effects/`) or the window/dim actuators in Lua. **Mandatory reading for M8–M10.** Lua-side details (levels,
behaviours, verified API facts) are in [hammerspoon.md](./hammerspoon.md).

---

## 1. Tone (principle 3 — non-negotiable)

- Kind, neutral, never shaming. The owner already carries "not good enough". No "YOU OVERWORKED!", no exclamation
  marks at him, no guilt. Speak like a friend who is on his side: *"That's today's budget. Friday-you will thank you."*
- Close the loop (principle 1): wherever work stops, offer the context-memory box ("What's the next thing you'd do?
  It will be waiting for you tomorrow.").
- Large, calm type (`style.css`: 22 px body, 30 px headings — owner asked for +50 %). Neutral colours; red only as a **status** colour (menubar) — and for the debug eject label, which is a
  safety instruction, not a judgement.
- Every user-facing string lives in [`src/ui/strings.ts`](../src/ui/strings.ts): `strings` (daemon side: menubar,
  tooltips, warnings) and `pageStrings` (served to pages by `GET /api/ui/strings`). Pages never hard-code text, so
  the tone can be reviewed in one file.
- Shabbat: nothing intrusive, ever (enforced by config validation + evaluator, and by the live gate's `intrusive` flag).

## 2. How a window comes to exist

```
effect.desired(now) ──▶ manager (live gate, opacity, rev) ──▶ reconcile(desired, Lua's actual, R-UI-QUIET, panic)
                                                                   │ commands in the heartbeat reply
Lua: window.open / window.close / dim ──▶ webview loads /ui/<page>.html?token&win&screen&primary
page.ts boot(): GET /api/ui/strings + GET /api/ui/model?win= → render; actions: POST /api/ui/action {win, action, payload}
```

- **Effect** (`src/core/effects.ts`): `name`, `audit` (log `effect.shown`/`effect.closed`), `desired(now)` → windows +
  dims, optional `closed(id, by)`, `model(id)`, `action(id, action, payload)`. Window ids are `<effect>` or
  `<effect>:<suffix>` — the manager routes page calls by that prefix and ignores mis-prefixed ids.
- **Window spec:** `path`, `mode` (`normal` · `floating` · `overlay`), `placement` (`center` · `top-right` ·
  `bottom-right` · `full`), `w`/`h`, `perScreen`, `focus` (take key focus — needed for typing, H-10), `closable`,
  `title`, `intrusive`. The manager adds `opacity` (screen-covering windows, config `overlayOpacity`) and `rev`
  (hash of the spec): a changed rev rebuilds the window; an unchanged one is left alone.
- **`intrusive`** = system-initiated (dialogs, dims, countdown, block, nudges, morning review). Intrusive things are:
  (1) **gated** on the live instance until `liveEffects: true` in `config/policy.ts` (D-48; dev ignores the gate);
  (2) **suppressed** by Lua's panic latch; (3) **deferred** by R-UI-QUIET: a *new* one does not start within
  `quiet.afterInputSec` (10 s) of input, unless it has been due for `quiet.maxDeferSec` (Q-13: 2 min). Updates of a
  window already on screen, closes, and the re-appearance of a window lost *involuntarily* today (reload, fail-open,
  load failure) are never deferred; a window closed on purpose (`user`/`page`/`system`/`panic`) waits again next time.
  User-initiated windows (menu items, M8) are none of these — and therefore **must not cover a screen** (`overlay`
  mode or `full` placement): the manager logs a warning and treats such a window as intrusive.
- **Dims** (`DimSpec`): one-shot gamma pulses (`pulseId`, `level`, `seconds`, `cancelOnInput`). Lua runs a pulse id
  once, caps it at 15 s and level ≥ 0.3, and always restores gamma (end, input if `cancelOnInput`, screens change,
  panic, quit, fail-open, unload).
- **Closing:** the page calls `act('close')` (the effect decides; `close: true` makes the page tell Lua to close at
  once), or the user uses the native close button. Lua reports `closed {id, by}`; `user`/`page` mean *dismissed*;
  `system`/`panic`/`failopen`/`load-failed` do not — the effect decides whether it still wants the window.
- **Fail open:** a page that cannot load shows the kind fallback and asks Lua to close it after 60 s
  (`tellLua('failed')`); a dead daemon makes Lua close every intrusive window; an effect whose `desired()` throws shows
  nothing. A broken UI must never trap the owner (principle 5).

## 3. Pages

- Flat in `src/ui/pages/`: `<name>.html` + `<name>.ts` + shared `style.css` + shared `page.ts` (helpers: `boot`,
  `api`, `act`, `el`, `tellLua`, `token`, `windowId`, `isPrimary`, `inHammerspoon`). Served by `GET /ui/<file>`
  (`src/ui/serve.ts`): names must match `^[a-z0-9][a-z0-9-]*\.(html|ts|css)$`; `.ts` is type-stripped
  (`module.stripTypeScriptTypes`) and cached by mtime — no bundler, no framework, plain DOM. Static files need no
  token; every `/api/*` call does (the page URL carries it).
- Page scripts are **erasable TypeScript** like the rest of the repo, and are type-checked by `npm run typecheck`
  (`lib: dom`). Import siblings with `.ts` extensions (`import … from './page.ts'`).
- The dev instance adds a `DEV` badge (`body.env-dev`). For a look inside a real `hs.webview` use
  `WorkBalancer.preview('http://127.0.0.1:47622/ui/<page>.html?token=…&win=…')` (it focuses the window so typing works).
- Per-screen windows: only the primary instance (`primary=1`) shows inputs; the others show the message only.
- `fixture.html` / `fixture.ts`: the M7 fixture used by the `test` effect (`POST /api/test/window`, `/api/test/dim`,
  `/api/test/clear`). Live test windows need `"live": true` in the request (owner consent), live at most 120 s, are
  exempt from the gate but not from panic/R-UI-QUIET, and are never written to `data/`.

## 4. The debug panic-eject (R-UI-EJECT, D-49)

While ON (default until the owner trusts the blockers): every screen-covering window carries a big red bottom label
"Press Shift+Ctrl+Alt+Cmd+F12 to PANIC-EJECT", and that combo terminates Hammerspoon. Lua-only, independent of the
daemon. Toggle: `hs -c 'return WorkBalancer.debugEject(false)'`. Every new screen-covering effect (M9 pre-warning dim
excluded — gamma only — M10 block, zero-limit explanation) must be checked with the label visible.
