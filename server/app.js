// RING-HUNTER account server: serves the web/ pages and a small account API (orex-style flow):
//   connect wallet → sign a SIWE message → dashboard shows an API key → `ring-hunter login <KEY>` in the CLI.
// The account is OPTIONAL: every scan feature of the CLI works without it.
//
// Security:
//   - Listens on 127.0.0.1 only; meant to sit behind a TLS reverse proxy (nginx/Caddy) on the VPS.
//   - Host must be the public host (or 127.0.0.1/localhost:port); POST needs Origin = RH_PUBLIC_ORIGIN and a JSON
//     body (CSRF), bodies are capped at 4 KB, auth endpoints are rate limited per IP.
//   - Session cookie: random 32 bytes, HttpOnly, SameSite=Strict, Secure on https; only its sha256 is stored.
//   - API keys: "rh_" + 32 random bytes (base64url); only the sha256 is stored, the key is shown once.
//   - No transactions, approvals, or typed-data signatures — only a plain-text SIWE message.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { isAddress, getAddress } from 'ethers';
import { send, serveStatic, PUBLIC_DIR } from '../src/web/server.js';
import { openDb } from './db.js';
import { buildSiweMessage, newNonce, signatureMatches, NONCE_TTL_MS } from './siwe.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const API_KEY_RE = /^rh_[A-Za-z0-9_-]{43}$/;
const COOKIE = 'rh_session';
const MAX_BODY = 4096;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const json = (res, status, obj, headers) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', headers);
const fail = (res, status, error) => json(res, status, { error });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Fixed-window per-key counter (in memory; resets on restart — fine for a single VPS process). */
function createRateLimiter({ limit, windowMs, now }) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { start: t, n: 1 });
      return true;
    }
    return ++h.n <= limit;
  };
}

function readJson(req) {
  return new Promise((ok, bad) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return bad(new HttpError(415, 'Content-Type must be application/json'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        bad(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        ok(v && typeof v === 'object' ? v : {});
      } catch {
        bad(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', () => bad(new HttpError(400, 'Request aborted')));
  });
}

function cookieValue(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/**
 * @param {{publicOrigin:string, dbFile?:string, publicDir?:string, trustProxy?:boolean, now?:()=>number}} opts
 */
export function createAccountServer({ publicOrigin, dbFile = ':memory:', publicDir = PUBLIC_DIR, trustProxy = false, now = () => Date.now() }) {
  const origin = new URL(publicOrigin).origin;
  const secure = origin.startsWith('https:');
  const publicHost = new URL(origin).host;
  const db = openDb(dbFile);
  const limits = {
    auth: createRateLimiter({ limit: 20, windowMs: 60_000, now }),
    cli: createRateLimiter({ limit: 60, windowMs: 60_000, now }),
  };
  let port = 0;

  const clientIp = (req) => (trustProxy && typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : req.socket.remoteAddress) ?? '?';

  function sessionAddress(req) {
    const token = cookieValue(req, COOKIE);
    if (!token || token.length > 100) return null;
    const s = db.getSession(sha256(token));
    return s && s.expires_at > now() ? s.address : null;
  }
  function requireSession(req) {
    const a = sessionAddress(req);
    if (!a) throw new HttpError(401, 'Not signed in');
    return a;
  }
  const cookie = (value, maxAgeSec) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  const keyInfo = (address) => {
    const k = db.getKeyInfo(address);
    return k ? { prefix: k.prefix, createdAt: new Date(k.created_at).toISOString(), lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null } : null;
  };

  const routes = {
    'POST /api/auth/nonce': async (req, res) => {
      const { address } = await readJson(req);
      if (typeof address !== 'string' || !isAddress(address)) throw new HttpError(400, 'A valid 0x wallet address is required');
      const t = now();
      db.prune(t);
      const nonce = newNonce();
      const message = buildSiweMessage({ origin, address, nonce, issuedAt: t, expiresAt: t + NONCE_TTL_MS });
      db.addNonce(nonce, getAddress(address), message, t + NONCE_TTL_MS);
      json(res, 200, { nonce, message });
    },
    'POST /api/auth/verify': async (req, res) => {
      const { nonce, signature } = await readJson(req);
      if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) throw new HttpError(400, 'Invalid nonce');
      const row = db.takeNonce(nonce); // consumed even if the signature is wrong: one attempt per nonce
      if (!row || row.expires_at < now()) throw new HttpError(401, 'Sign-in request expired or already used — start again');
      if (!signatureMatches(row.message, signature, row.address)) throw new HttpError(401, 'Signature does not match the wallet address');
      const t = now();
      db.addUser(row.address, t);
      const token = randomBytes(32).toString('base64url');
      db.addSession(sha256(token), row.address, t + SESSION_TTL_MS);
      json(res, 200, { address: row.address }, { 'Set-Cookie': cookie(token, SESSION_TTL_MS / 1000) });
    },
    'GET /api/me': async (req, res) => {
      const address = requireSession(req);
      json(res, 200, { address, apiKey: keyInfo(address) });
    },
    'POST /api/key': async (req, res) => {
      const address = requireSession(req);
      await readJson(req);
      const key = 'rh_' + randomBytes(32).toString('base64url');
      db.replaceKey(address, sha256(key), key.slice(0, 10), now());
      // The only time the full key leaves the server.
      json(res, 200, { apiKey: key, ...keyInfo(address) });
    },
    'POST /api/key/revoke': async (req, res) => {
      const address = requireSession(req);
      await readJson(req);
      json(res, 200, { revoked: db.revokeKey(address) });
    },
    'POST /api/logout': async (req, res) => {
      await readJson(req);
      const token = cookieValue(req, COOKIE);
      if (token) db.deleteSession(sha256(token));
      json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    },
    // Used by `ring-hunter login` / `whoami`. Bearer key, no cookie, no Origin (not a browser).
    'GET /api/cli/whoami': async (req, res) => {
      const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      if (!m || !API_KEY_RE.test(m[1])) throw new HttpError(401, 'Missing or malformed API key');
      const hash = sha256(m[1]);
      const k = db.findKey(hash);
      if (!k) throw new HttpError(401, 'Unknown or revoked API key — create a new one on the dashboard');
      db.touchKey(hash, now());
      json(res, 200, { address: k.address, keyCreatedAt: new Date(k.created_at).toISOString() });
    },
  };

  const server = createServer(async (req, res) => {
    const host = req.headers.host;
    if (host !== publicHost && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, 'Host not allowed');
    let pathname;
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      return send(res, 400, 'Invalid URL');
    }
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not supported');
      return serveStatic(req, res, publicDir);
    }
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) return fail(res, Object.keys(routes).some((r) => r.endsWith(' ' + pathname)) ? 405 : 404, 'Not found');
    try {
      if (req.method === 'POST' && req.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request refused');
      const bucket = pathname.startsWith('/api/cli/') ? limits.cli : pathname.startsWith('/api/auth/') ? limits.auth : null;
      if (bucket && !bucket(clientIp(req))) throw new HttpError(429, 'Too many requests — try again in a minute');
      await handler(req, res);
    } catch (e) {
      if (e instanceof HttpError) return fail(res, e.status, e.message);
      process.stderr.write(`account server error: ${e?.message}\n`);
      fail(res, 500, 'Internal error');
    }
  });

  return {
    server,
    db,
    /** Listen on 127.0.0.1. port 0 → random port (tests). */
    listen(p) {
      return new Promise((ok, bad) => {
        server.once('error', bad);
        server.listen(p, '127.0.0.1', () => ok((port = server.address().port)));
      });
    },
    close: () => new Promise((ok) => server.close(() => (db.close(), ok()))),
  };
}
