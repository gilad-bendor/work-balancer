// Test windows and dim pulses (M7): explicitly requested, time-limited fixtures that exercise every window mode.
// Dev: free to use. Live: only with `live: true` in the request — reserved for tests the owner consented to in the
// session (instructions §10); they bypass the live gate but not panic or R-UI-QUIET, and are never logged to data/.
import type { DimSpec, Effect, Placement, WindowInput, WindowMode } from '../core/effects.ts';
import type { Route } from '../bridge/server.ts';

const MODES: readonly WindowMode[] = ['normal', 'floating', 'overlay'];
const PLACEMENTS: readonly Placement[] = ['center', 'top-right', 'bottom-right', 'full'];
const MAX_TTL_S = 120;
const MAX_WINDOWS = 4;

export function createTestEffect(deps: { env: 'live' | 'dev'; now: () => number }): { effect: Effect; routes: Route[] } {
  const windows = new Map<string, { input: WindowInput; until: number }>();
  let dims: { spec: DimSpec; until: number }[] = [];
  let n = 0;

  const effect: Effect = {
    name: 'test',
    audit: false,
    gateExempt: true,
    desired(now) {
      for (const [id, w] of windows) if (w.until <= now) windows.delete(id);
      dims = dims.filter((d) => d.until > now);
      return { windows: [...windows.values()].map((w) => w.input), dims: dims.map((d) => d.spec) };
    },
    closed(id, by) {
      if (by === 'user' || by === 'page') windows.delete(id);
    },
    model(id, now) {
      const w = windows.get(id);
      if (!w) return null;
      return { mode: w.input.mode, perScreen: !!w.input.perScreen, focus: !!w.input.focus, secondsLeft: Math.max(0, Math.round((w.until - now) / 1000)) };
    },
    action(id, action, payload) {
      if (action === 'close') {
        windows.delete(id);
        return { ok: true, close: true };
      }
      if (action === 'echo') {
        const text = payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string' ? (payload as { text: string }).text : '';
        return { ok: true, echo: text };
      }
      return { ok: false, error: `unknown action ${action}` };
    },
  };

  type Body = Record<string, unknown>;
  const asBody = (b: unknown): Body => (b && typeof b === 'object' ? (b as Body) : {});
  const liveRefused = (b: Body) => deps.env === 'live' && b.live !== true;
  const ttl = (b: Body): number => Math.min(MAX_TTL_S, Math.max(1, typeof b.ttlSeconds === 'number' ? b.ttlSeconds : 30)) * 1000;

  const routes: Route[] = [
    {
      method: 'POST', path: '/api/test/window', auth: true,
      handle: ({ body }) => {
        const b = asBody(body);
        if (liveRefused(b)) return { status: 403, json: { error: 'live test windows need "live": true (owner consent)' } };
        effect.desired(deps.now()); // drop expired ones before counting
        if (windows.size >= MAX_WINDOWS) return { status: 429, json: { error: `at most ${MAX_WINDOWS} test windows` } };
        const mode = MODES.includes(b.mode as WindowMode) ? (b.mode as WindowMode) : 'normal';
        const placement = PLACEMENTS.includes(b.placement as Placement) ? (b.placement as Placement) : mode === 'overlay' ? 'full' : 'center';
        const id = `test:${++n}`;
        const input: WindowInput = {
          // `broken`: a page that never loads (HTTP 404) — exercises the readiness handshake / fail-open.
          id, path: b.broken === true ? '/ui/missing-page.html' : `/ui/fixture.html?mode=${mode}`, mode, placement, title: `work-balancer test (${mode})`,
          perScreen: b.perScreen === true, focus: b.focus === true, closable: mode !== 'overlay',
          // Screen-covering windows are always intrusive (the manager enforces it too).
          intrusive: b.intrusive !== false || mode === 'overlay' || placement === 'full',
          ...(typeof b.w === 'number' ? { w: b.w } : {}), ...(typeof b.h === 'number' ? { h: b.h } : {}),
        };
        windows.set(id, { input, until: deps.now() + ttl(b) });
        return { json: { ok: true, id } };
      },
    },
    {
      method: 'POST', path: '/api/test/dim', auth: true,
      handle: ({ body }) => {
        const b = asBody(body);
        if (liveRefused(b)) return { status: 403, json: { error: 'live test dims need "live": true (owner consent)' } };
        const spec: DimSpec = {
          pulseId: `test-${deps.now()}-${++n}`,
          level: typeof b.level === 'number' ? b.level : 0.6,
          seconds: typeof b.seconds === 'number' ? b.seconds : 3,
          cancelOnInput: b.cancelOnInput === true,
        };
        dims.push({ spec, until: deps.now() + ttl(b) });
        return { json: { ok: true, pulseId: spec.pulseId } };
      },
    },
    {
      method: 'POST', path: '/api/test/clear', auth: true,
      handle: () => {
        windows.clear();
        dims = [];
        return { json: { ok: true } };
      },
    },
  ];
  return { effect, routes };
}
