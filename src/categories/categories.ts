// App categories (owner, 2026-10-05, D-67): the owner's `config/categories.ts` maps the focused app to a category
// ("Work", "WhatsApp", …) and a category to its look on daily timelines. Categories are recorded per minute (insight
// only) and have NO effect on time logic: worked time, budgets, the ladder, the block and the inactivity dialog never
// read them. This module loads the owner's file (hot-reloaded on save, like the policy) and wraps it so that a broken
// or throwing function can never break tracking: anything invalid counts as "Work".
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../core/log.ts';

/** What the categorizer sees. The window title is read in memory only — never stored or logged (it can hold chat
 * names, document names …). */
export interface AppContext {
  /** Bundle id, e.g. `net.whatsapp.WhatsApp` (or the app name when the app has none). */
  bundleId: string;
  /** The app's display name. May carry invisible marks (WhatsApp's is "\u200eWhatsApp") — prefer `bundleId`. */
  appName: string;
  /** Title of the app's focused window, or null when unknown (no window, not readable, the app did not answer). */
  windowTitle: string | null;
}

/** How a category looks on a daily timeline. */
export interface CategoryStyle {
  /** A CSS colour. */
  color: string;
  /** Line thickness in px. */
  thickness: number;
  /** Shown in tooltips / legends. */
  label: string;
}

export const DEFAULT_CATEGORY = 'Work';
/** Not app categories: states of a timeline segment (the categorizer may not return them). */
export const BUILTIN_CATEGORIES = ['Inactive', 'Blocked', 'Future'] as const;
export type BuiltinCategory = (typeof BUILTIN_CATEGORIES)[number];
export const MAX_CATEGORY_LENGTH = 40;
const LOAD_TIMEOUT_MS = 3000;

export interface CategoriesModule {
  categorize(app: AppContext): string;
  categoryStyle(category: string): CategoryStyle;
}

const FALLBACK_STYLE: CategoryStyle = { color: '#8a8780', thickness: 4, label: '' };

/** Used while the owner's file is missing or broken: everything is work, a plain look. */
export const fallbackModule: CategoriesModule = {
  categorize: () => DEFAULT_CATEGORY,
  categoryStyle: (category) => ({ ...FALLBACK_STYLE, label: category }),
};

export interface Categories {
  /** Never throws; always a valid app category (invalid answers → "Work"). */
  categorize(app: AppContext): string;
  /** Never throws; always a usable style. */
  style(category: string): CategoryStyle;
  /** Re-imports the file when its mtime changed. */
  refresh(): Promise<void>;
  /** Errors of the latest load (non-empty = the file is broken and the fallback runs). */
  errors(): string[];
}

export function createCategories(opts: { path: string; log: Logger }): Categories {
  let mod: CategoriesModule = fallbackModule;
  let errors: string[] = [];
  let seenMtime: number | null = null;
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string, fields: Record<string, unknown> = {}): void => {
    if (warned.has(key) || warned.size > 200) return;
    warned.add(key);
    opts.log.warn(msg, fields);
  };

  return {
    categorize(app) {
      // Nothing the owner's function does (throw, return a hostile object) may escape: tracking depends on it.
      try {
        let c: unknown;
        try {
          c = mod.categorize(app);
        } catch (e) {
          // Never the message: V8 messages quote their input, which may be the window title (review D-67#4).
          let kind = 'error';
          try { kind = e instanceof Error ? String(e.name).slice(0, 40) : typeof e; } catch { /* hostile error object */ }
          warnOnce(`throw:${kind}:${app.bundleId}`, 'categorize() threw — counted as Work', { error: kind, bundleId: app.bundleId });
          return DEFAULT_CATEGORY;
        }
        if (c !== null && (typeof c === 'object' || typeof c === 'function')) {
          // An async categorizer: its promise may reject later — handled here, or the daemon would crash on an
          // unhandled rejection (and log a message that can quote the title). Categories must be synchronous.
          try {
            const then = (c as { then?: unknown }).then;
            if (typeof then === 'function') (then as (a: unknown, b: () => void) => unknown).call(c, undefined, () => {});
          } catch { /* hostile object */ }
        }
        const name = typeof c === 'string' ? c.trim() : '';
        if (!name || name.length > MAX_CATEGORY_LENGTH || (BUILTIN_CATEGORIES as readonly string[]).includes(name)) {
          // Never echo the title; the bundle id is enough to find the case.
          warnOnce(`bad:${app.bundleId}:${typeof c === 'string' ? c.slice(0, 50) : typeof c}`, 'categorize() returned an invalid category — counted as Work', { bundleId: app.bundleId });
          return DEFAULT_CATEGORY;
        }
        return name;
      } catch {
        return DEFAULT_CATEGORY;
      }
    },
    style(category) {
      try {
        const s = mod.categoryStyle(category) as Partial<CategoryStyle> | null | undefined;
        if (s && typeof s.color === 'string' && typeof s.thickness === 'number' && Number.isFinite(s.thickness) && s.thickness > 0) {
          return { color: s.color, thickness: s.thickness, label: typeof s.label === 'string' ? s.label : category };
        }
        warnOnce(`style:${category}`, 'categoryStyle() returned an invalid style — using the fallback', { category });
      } catch (e) {
        let kind = 'error';
        try { kind = e instanceof Error ? String(e.name).slice(0, 40) : typeof e; } catch { /* hostile error object */ }
        warnOnce(`style-throw:${category}`, 'categoryStyle() threw — using the fallback', { category, error: kind });
      }
      return fallbackModule.categoryStyle(category);
    },
    async refresh() {
      let mtime: number;
      try {
        mtime = statSync(opts.path).mtimeMs;
      } catch {
        mtime = -1;
      }
      if (seenMtime === mtime) return;
      seenMtime = mtime;
      if (mtime < 0) {
        mod = fallbackModule;
        errors = [`${opts.path} does not exist`];
        opts.log.warn('categories file missing — everything counts as Work', { path: opts.path });
        return;
      }
      try {
        // Bounded: a module that never finishes loading (a top-level await) must not stall the daemon (review D-67#7).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const m = (await Promise.race([
          import(`${pathToFileURL(opts.path).href}?v=${mtime}`),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`loading took longer than ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer))) as Partial<CategoriesModule>;
        if (typeof m.categorize !== 'function' || typeof m.categoryStyle !== 'function') {
          throw new Error('it must export the functions categorize() and categoryStyle()');
        }
        mod = { categorize: m.categorize, categoryStyle: m.categoryStyle };
        errors = [];
        warned.clear();
        opts.log.info('categories loaded', { path: opts.path });
      } catch (e) {
        // Keep the previous module (like the policy); the very first load falls back to "everything is Work".
        errors = [`cannot load ${opts.path}: ${(e as Error).message.split('\n')[0]}`];
        opts.log.warn('categories file invalid — keeping the previous one', { errors });
      }
    },
    errors: () => errors,
  };
}
