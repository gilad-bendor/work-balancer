// HTTP bridge on 127.0.0.1 only. Every route except /health needs the token (header X-WB-Token, or ?token= for
// pages). The Host header is checked against 127.0.0.1/localhost to block DNS-rebinding from web pages.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Logger } from '../core/log.ts';

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  /** Match every path that starts with `path` (static pages). */
  prefix?: boolean;
  auth: boolean;
  handle(req: { body: unknown; query: URLSearchParams; path: string }): Promise<RouteResult> | RouteResult;
}

export interface RouteResult {
  status?: number;
  json?: unknown;
  html?: string;
  /** Raw body with its content type (static assets). */
  body?: string;
  contentType?: string;
}

const MAX_BODY = 1024 * 1024;

export function createBridgeServer(opts: { token: string; log: Logger; routes: Route[] }): Server {
  const tokenBuf = Buffer.from(opts.token);
  const tokenOk = (given: string | null): boolean => {
    if (!given) return false;
    const b = Buffer.from(given);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
      const route = opts.routes.find((r) => r.method === req.method && (r.prefix ? url.pathname.startsWith(r.path) : r.path === url.pathname));
      if (!route) return send(res, 404, { error: 'not found' });
      if (route.auth && !tokenOk((req.headers['x-wb-token'] as string | undefined) ?? url.searchParams.get('token'))) {
        return send(res, 401, { error: 'bad token' });
      }
      let body: unknown = null;
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
      }
      const result = await route.handle({ body, query: url.searchParams, path: url.pathname });
      if (result.html !== undefined || result.body !== undefined) {
        const type = result.html !== undefined ? 'text/html; charset=utf-8' : (result.contentType ?? 'text/plain; charset=utf-8');
        res.writeHead(result.status ?? 200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(result.html ?? result.body);
      } else send(res, result.status ?? 200, result.json ?? {});
    } catch (e) {
      opts.log.error('request failed', { url: req.url, error: e as Error });
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

function send(res: ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(json));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
