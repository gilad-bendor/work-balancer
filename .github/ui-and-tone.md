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
- **Shared page modules:** `feedback.ts` (the R-UI-FB form — reuse it in countdown / block, M10), `notes-view.ts`
  (a note card with edit / dismiss / bring back), `format.ts` (`hm`, `dayLabel`, `timeLabel`). `page.ts` helpers added in
  M8: `topBar(title)` (static top bar + big ✕, for the large windows), `closeOnEscape()` (every dismissible page — never
  the countdown / block), `submitOnCmdEnter(box, fn)` (every text box), `focusOnInteract()` (windows opened without
  focus get it on the owner's click), `closeWindow()`.
- **Owner's UI conventions (2026-10-05):** Esc closes any dismissible window (an open note editor takes Esc first);
  Cmd+Enter in a text box submits; large windows (summary, notes) are 90 % of the screen with a static top bar (title
  + big ✕, no Close button at the bottom) and a box 20 px from every side that scrolls inside.
- `fixture.html` / `fixture.ts`: the M7 fixture used by the `test` effect (`POST /api/test/window`, `/api/test/dim`,
  `/api/test/clear`). Live test windows need `"live": true` in the request (owner consent), live at most 120 s, are
  exempt from the gate but not from panic/R-UI-QUIET, and are never written to `data/`.

## 4. The M8 windows

| Window id | Opened by | Mode / size | Page | Notes |
|---|---|---|---|---|
| `quick` | menu *Quick note…* | floating, focus, 900×860 | `quick` | context-memory + feedback → `context` and/or `feedback` note (`source: quick`) |
| `notes` | menu *Show status notes* | floating, focus, 90 % | `notes` | waiting first, then dismissed; add / edit / dismiss / bring back |
| `summary` | menu *Show activity summary* | floating, focus, 90 % | `summary` | refreshes every minute; 4-week trend via `src/daemon/history.ts` |
| `quit` | menu *Quit work-balancer…* | floating, focus | `quit` | confirm → page tells Lua `quit` (only honoured from window `quit`) |
| `review` | `day.rollover` with `review: true` | floating, **no focus**, intrusive | `review` | gated live until `liveEffects`; "Let's start this day!" or ✕ = done for today |
| `inactivity` (M9) | a gap (5 min idle + uncancelled 10 s pre-warning dim) | **overlay, full, per screen**, focus, intrusive | `inactivity` | **no Esc, no timeout** (D-56) — ends only by Submit (or the escape hatches / fail-open / 04:00); one gap; live timer with seconds; slider "Worked N min of M" + presets (highlighted iff the slider is at their value); the presets submit at once (D-68), the slider enables Submit; other screens: "Please answer on the main screen." |

The menu itself comes from the daemon (`strings.menu`, sent in every menubar spec); a click posts
`/bridge/ui-request {open}`; a second click on an open window raises it (`window.focus`). A restarted daemon adopts the
open menu windows; a Hammerspoon reload ends them.

## 4a. The M10 windows (enforcement — `src/enforcement/enforcement.ts`)

All intrusive (live gate, R-UI-QUIET, panic) and audited. Levels come from the policy state; a level *entry* is today's
latest `policy.transition` into it.

| Window id | When | Mode / size | Page | Notes |
|---|---|---|---|---|
| `warn` | level `warn` (≈ 30 worked min left), until dismissed for this entry | floating center 860×400, **no focus** | `warn` | + one 3 s dim pulse (0.6) with its first appearance; Got it / ✕ / Esc |
| `countdown` | level `countdown` (≈ 10 min left) | floating center 960×820, no focus, **not closable** | `countdown` | "≈ N min of work left today"; park the thought; **Save = done for today** (`budget.forfeited` → block, D-60); "Make it small" → the pill (`?pill=1`, top right 420×150, in memory per entry); its typed text is a draft that reappears in the block |
| `block` | `blockActive` (blocked, no grant) — and the store can write | **overlay, full, per screen**, focus | `block` | not dismissible; numbers + week strip; park the thought; tokens (two-step: the confirm appears elsewhere, enabled after 0.8 s, disarms after 20 s); emergency bypass (sentence retyped with paste/drop blocked + reason + two-step); zero limit → an explanation first ("I understand"); other screens: message + numbers |
| `nudge` | ≥ 90 min continuous work on a `breakNudge` day, not at countdown/block | floating top-right 640×330, no focus | `nudge` | "Taking a break now" = quiet for this stretch (memory); ✕ / Esc / "Remind me in 15 min" = snooze (from the `effect.closed` record) |

Once a token or the bypass was used today, the block's return is `immediate` (no R-UI-QUIET deferral). While the
countdown or the block is due (live, enforcing day), the menu has no *Quit* and the quit page refuses (D-61).
Shared page module `park.ts`: context box + feedback form + Save (action `save`, notes with source `countdown`/`block`) +
debounced `draft`. Strings use `{n}`/`{m}`/`{k}`/`{t}` placeholders filled by `page.ts` `fill()`.
**Trial mode:** `POST /api/test/window {"live": true, "page": "block" | "countdown" | "warn" | "nudge" | "inactivity"}`
(+ `"zeroLimit": true` for the block) shows the real page over synthetic numbers; answers are logged (never their text),
nothing reaches `data/`.
**Titled windows** (every non-overlay window): Lua uses `fullSizeContentView` and adds `titled=1` to the page URL; the
page pads its top by 28 px so its own background fills the title bar (owner 2026-10-05: the plain title bar was
see-through and hard to drag — hammerspoon.md H-15).

## 5. The debug panic-eject (R-UI-EJECT, D-49)

While ON (default until the owner trusts the blockers): every screen-covering window carries a big red bottom label
"Press Shift+Ctrl+Alt+Cmd+F12 to PANIC-EJECT", and that combo terminates Hammerspoon. Lua-only, independent of the
daemon. Toggle: `hs -c 'return WorkBalancer.debugEject(false)'`. Every new screen-covering effect (M9 pre-warning dim
excluded — gamma only; the M9 inactivity dialog checked live 2026-10-05; the M10 block trial checked live 2026-10-05 —
2 labels) must be checked with the label visible.
- **Trying a product page live without touching data:** `POST /api/test/window {"live": true, "page": "inactivity",
  "gapMinutes": 12}` shows the real inactivity dialog over a synthetic gap (TTL ≤ 120 s); the answer goes to the daemon
  log only. `WorkBalancer.preview(url, true)` = a full-screen DEV PREVIEW at the overlay opacity.
