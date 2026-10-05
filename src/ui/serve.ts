// Serves the UI pages from src/ui/pages/ under /ui/<file>. Page scripts are TypeScript, stripped of their types on
// the fly (module.stripTypeScriptTypes, ledger F-ENV-5) and cached by mtime — no bundler. Flat directory, strict
// file-name pattern: nothing outside src/ui/pages/ is reachable.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { Route } from '../bridge/server.ts';

export const PAGES_DIR = join(import.meta.dirname, 'pages');

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  ts: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};
const NAME = /^[a-z0-9][a-z0-9-]*\.(html|ts|css)$/;

export function pagesRoute(dir: string = PAGES_DIR): Route {
  const cache = new Map<string, { mtimeMs: number; body: string }>();
  return {
    method: 'GET', path: '/ui/', prefix: true,
    // Static code and markup only; every data API needs the token.
    auth: false,
    handle: ({ path }) => {
      const name = path.slice('/ui/'.length);
      const m = NAME.exec(name);
      if (!m) return { status: 404, json: { error: 'not found' } };
      const file = join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        return { status: 404, json: { error: 'not found' } };
      }
      let hit = cache.get(name);
      if (!hit || hit.mtimeMs !== mtimeMs) {
        const src = readFileSync(file, 'utf8');
        hit = { mtimeMs, body: m[1] === 'ts' ? stripTypeScriptTypes(src) : src };
        cache.set(name, hit);
      }
      return { body: hit.body, contentType: TYPES[m[1]!] };
    },
  };
}
