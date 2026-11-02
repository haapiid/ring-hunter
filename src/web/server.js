// Static server for the RING-HUNTER AI info page (web/ folder).
// The page is only a guide & demo — all analysis functions stay in the CLI.
// Security: listens on 127.0.0.1 only, checks the Host header (prevents DNS rebinding),
// GET/HEAD only, only files inside web/ with known extensions.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { PROJECT_ROOT } from '../config/paths.js';

export const PUBLIC_DIR = resolve(PROJECT_ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // Archivo font from Google Fonts; everything else is a local asset.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function send(res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache', ...extraHeaders });
  res.end(body);
}

/** Serve a GET/HEAD request from publicDir: only files inside it with a known extension. */
export async function serveStatic(req, res, publicDir = PUBLIC_DIR) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'Invalid URL');
  }
  const full = resolve(publicDir, pathname === '/' ? 'index.html' : pathname.slice(1));
  const type = MIME[extname(full).toLowerCase()];
  if (!full.startsWith(publicDir + sep) || !type) return send(res, 404, 'Not found');
  try {
    send(res, 200, await readFile(full), type);
  } catch {
    send(res, 404, 'Not found');
  }
}

export function createWebServer({ publicDir = PUBLIC_DIR } = {}) {
  let port = 0;
  const server = createServer(async (req, res) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, 'Host not allowed');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not supported');
    return serveStatic(req, res, publicDir);
  });
  return {
    server,
    /** Listen on 127.0.0.1. port 0 → random port (for tests). */
    listen(p = 3000) {
      return new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(p, '127.0.0.1', () => ok((port = server.address().port)));
      });
    },
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
