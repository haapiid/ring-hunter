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
import { proSettings, publicProInfo, verifyPayment, createTokenChecker, ProError } from './pro.js';
import { REPORT_ID_RE } from './hosted.js';
import { READ_METHODS } from '../src/adapters/evm/rpcClient.js';

// Pro limits ("higher limits / batch"): free accounts get the CLI (unlimited, local); Pro adds hosted features.
export const PRO_LIMITS = Object.freeze({ batch: 5, scansPerDay: 50, watchlist: 20, rpcPerMinute: 600, rpcBatch: 20 });
const RPC_MAX_BODY = 16 * 1024;

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

function readJson(req, maxBody = MAX_BODY) {
  return new Promise((ok, bad) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return bad(new HttpError(415, 'Content-Type must be application/json'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBody) {
        bad(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        ok(v && typeof v === 'object' ? v : {}); // arrays pass through (JSON-RPC batches)
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
 * @param {object} opts
 * @param {string} opts.publicOrigin
 * @param {string} [opts.dbFile]
 * @param {string} [opts.publicDir]
 * @param {boolean} [opts.trustProxy]
 * @param {()=>number} [opts.now]
 * @param {object} [opts.pro] proSettings() result (default: everything off)
 * @param {object} [opts.chainRpc] read-only RPC client (payment checks, token balances)
 * @param {string} [opts.rpcUpstream] JSON-RPC URL the Pro RPC proxy forwards to (null = proxy off)
 * @param {(db:object)=>object} [opts.createHosted] builds the hosted scan service (null = hosted scans off)
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createAccountServer({
  publicOrigin,
  dbFile = ':memory:',
  publicDir = PUBLIC_DIR,
  trustProxy = false,
  now = () => Date.now(),
  pro = proSettings({}),
  chainRpc = null,
  rpcUpstream = null,
  createHosted = null,
  fetchImpl = globalThis.fetch,
}) {
  const origin = new URL(publicOrigin).origin;
  const secure = origin.startsWith('https:');
  const publicHost = new URL(origin).host;
  const db = openDb(dbFile);
  const hosted = createHosted ? createHosted(db) : null;
  const holderStatus = chainRpc ? createTokenChecker(chainRpc, pro, { now }) : async () => null;
  const limits = {
    auth: createRateLimiter({ limit: 20, windowMs: 60_000, now }),
    cli: createRateLimiter({ limit: 60, windowMs: 60_000, now }),
    api: createRateLimiter({ limit: 120, windowMs: 60_000, now }),
    rpc: createRateLimiter({ limit: PRO_LIMITS.rpcPerMinute, windowMs: 60_000, now }),
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
  const iso = (t) => (t ? new Date(t).toISOString() : null);

  /** Bearer API key → address (CLI / scripts). */
  function keyAddress(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!m || !API_KEY_RE.test(m[1])) throw new HttpError(401, 'Missing or malformed API key');
    const hash = sha256(m[1]);
    const k = db.findKey(hash);
    if (!k) throw new HttpError(401, 'Unknown or revoked API key — create a new one on the dashboard');
    db.touchKey(hash, now());
    return k;
  }
  /** Website session cookie, or an API key when an Authorization header is present (never both). */
  const requireUser = (req) => (req.headers.authorization ? keyAddress(req).address : requireSession(req));

  async function proStatus(address) {
    const until = db.getProUntil(address);
    const paid = until > now();
    const holder = await holderStatus(address);
    return { active: paid || !!holder?.qualifies, paidUntil: paid ? iso(until) : null, tokenHolder: holder, ...publicProInfo(pro), limits: PRO_LIMITS };
  }
  async function requirePro(address) {
    const s = await proStatus(address);
    if (!s.active) throw new HttpError(402, 'This is a RING-HUNTER Pro feature — activate Pro on the dashboard');
    return s;
  }
  function requireHosted() {
    if (!hosted) throw new HttpError(503, 'Hosted scans are not enabled on this server');
    return hosted;
  }
  const tokenParam = (v) => {
    if (typeof v !== 'string' || !isAddress(v)) throw new HttpError(400, `Not a valid token address: ${String(v).slice(0, 60)}`);
    return getAddress(v);
  };
  const reportRow = (r) => ({ id: r.id, token: r.token, symbol: r.symbol, status: r.status, error: r.error, score: r.score, level: r.level, createdAt: iso(r.created_at), finishedAt: iso(r.finished_at) });

  /** Pro RPC proxy: only read methods (same allow-list as the CLI client), forwarded to rpcUpstream. */
  async function proxyRpc(req, res) {
    if (!rpcUpstream) throw new HttpError(503, 'The hosted RPC is not enabled on this server');
    const k = keyAddress(req);
    await requirePro(k.address);
    if (!limits.rpc(k.address)) throw new HttpError(429, `Hosted RPC limit is ${PRO_LIMITS.rpcPerMinute} requests per minute`);
    const body = await readJson(req, RPC_MAX_BODY);
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > PRO_LIMITS.rpcBatch) throw new HttpError(400, `A JSON-RPC batch must have 1–${PRO_LIMITS.rpcBatch} calls`);
    const clean = calls.map((c) => {
      if (!c || typeof c.method !== 'string' || !READ_METHODS.has(c.method)) throw new HttpError(403, `Method ${String(c?.method).slice(0, 40)} is not allowed: the hosted RPC is read-only`);
      if (c.params !== undefined && !Array.isArray(c.params)) throw new HttpError(400, 'params must be an array');
      const id = typeof c.id === 'number' || typeof c.id === 'string' ? c.id : null;
      return { jsonrpc: '2.0', id, method: c.method, params: c.params ?? [] };
    });
    let up;
    try {
      up = await fetchImpl(rpcUpstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Array.isArray(body) ? clean : clean[0]), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new HttpError(502, 'Upstream RPC unreachable');
    }
    const text = await up.text();
    send(res, up.ok ? 200 : 502, up.ok ? text : JSON.stringify({ error: `Upstream RPC HTTP ${up.status}` }), 'application/json; charset=utf-8');
  }

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
      const k = keyAddress(req);
      const p = await proStatus(k.address);
      json(res, 200, { address: k.address, keyCreatedAt: iso(k.created_at), pro: { active: p.active, paidUntil: p.paidUntil, tokenHolder: !!p.tokenHolder?.qualifies } });
    },

    // ---- RING-HUNTER Pro ----
    'GET /api/pro': async (req, res) => {
      const address = requireUser(req);
      json(res, 200, { ...(await proStatus(address)), paymentHistory: db.listPayments(address).map((p) => ({ txHash: p.tx_hash, valueWei: p.value_wei, days: p.days, at: iso(p.created_at) })) });
    },
    // The user paid from their own wallet app; we only read the transaction.
    'POST /api/pro/claim': async (req, res) => {
      const address = requireSession(req);
      const { txHash } = await readJson(req);
      if (!chainRpc) throw new HttpError(503, 'Pro payments are not open yet');
      const owner = typeof txHash === 'string' ? db.paymentOwner(txHash.toLowerCase()) : null;
      if (owner) throw new HttpError(409, owner === address ? 'This payment was already credited to your account' : 'This payment was already used');
      let v;
      try {
        v = await verifyPayment(chainRpc, pro, { txHash, payer: address });
      } catch (e) {
        if (e instanceof ProError) throw new HttpError(e.status, e.message);
        throw new HttpError(502, 'Robinhood Chain RPC is unreachable right now — try again in a minute');
      }
      const until = db.creditPayment({ txHash: txHash.toLowerCase(), address, valueWei: v.valueWei, block: v.block, days: v.days, now: now() });
      if (until == null) throw new HttpError(409, 'This payment was already used');
      json(res, 200, { credited: true, days: v.days, ...(await proStatus(address)) });
    },
    // Hosted scan: { tokens: [addr, …] } (batch ≤ PRO_LIMITS.batch). Returns report ids; poll GET /api/scans.
    'POST /api/scan': async (req, res) => {
      const address = requireUser(req);
      const h = requireHosted();
      await requirePro(address);
      const { tokens } = await readJson(req);
      const list = [...new Set((Array.isArray(tokens) ? tokens : [tokens]).map(tokenParam))];
      if (!list.length || list.length > PRO_LIMITS.batch) throw new HttpError(400, `Send 1–${PRO_LIMITS.batch} token addresses`);
      const used = db.countReportsSince(address, now() - 86_400_000);
      if (used + list.length > PRO_LIMITS.scansPerDay) throw new HttpError(429, `Daily hosted-scan limit is ${PRO_LIMITS.scansPerDay} (used ${used})`);
      json(res, 202, { queued: list.map((token) => ({ id: h.enqueue(address, token), token })) });
    },
    'GET /api/scans': async (req, res) => {
      const address = requireUser(req);
      json(res, 200, { scans: db.listReports(address).map(reportRow), queueLength: hosted?.queueLength() ?? 0 });
    },
    // Share link: anyone with the unguessable id can read the report (it holds public on-chain analysis only).
    'GET /api/report': async (req, res) => {
      const id = new URL(req.url, 'http://x').searchParams.get('id') ?? '';
      if (!REPORT_ID_RE.test(id)) throw new HttpError(400, 'Invalid report id');
      const r = db.getReport(id);
      if (!r) throw new HttpError(404, 'Report not found');
      json(res, 200, { ...reportRow(r), report: r.json ? JSON.parse(r.json) : null });
    },
    'GET /api/watch': async (req, res) => {
      const address = requireUser(req);
      json(res, 200, {
        watchlist: db.listWatch(address).map((w) => ({
          token: w.token,
          addedAt: iso(w.added_at),
          lastReportId: w.last_report_id,
          score: w.last_score,
          level: w.last_level,
          previousScore: w.prev_score,
          previousLevel: w.prev_level,
          changed: w.prev_score != null && (w.prev_score !== w.last_score || w.prev_level !== w.last_level),
          scannedAt: iso(w.scanned_at),
        })),
      });
    },
    'POST /api/watch': async (req, res) => {
      const address = requireUser(req);
      const h = requireHosted();
      await requirePro(address);
      const token = tokenParam((await readJson(req)).token);
      if (db.countWatch(address) >= PRO_LIMITS.watchlist) throw new HttpError(429, `A watchlist holds up to ${PRO_LIMITS.watchlist} tokens`);
      if (db.addWatch(address, token, now())) h.watchTick();
      json(res, 200, { watching: token });
    },
    'POST /api/watch/remove': async (req, res) => {
      const address = requireUser(req);
      const token = tokenParam((await readJson(req)).token);
      json(res, 200, { removed: db.removeWatch(address, token) });
    },
    'GET /api/launches': async (req, res) => {
      const address = requireUser(req);
      await requirePro(address);
      json(res, 200, { launches: db.listLaunches(100).map((l) => ({ token: l.token, deployer: l.deployer, block: l.block, txHash: l.tx_hash })) });
    },
    'POST /api/rpc': proxyRpc,
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
      // CSRF: browser POSTs (cookie auth) must come from our origin. Bearer-key requests carry no cookie authority.
      if (req.method === 'POST' && !req.headers.authorization && req.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request refused');
      const bucket = pathname === '/api/rpc' ? null : pathname.startsWith('/api/cli/') ? limits.cli : pathname.startsWith('/api/auth/') ? limits.auth : limits.api;
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
    hosted,
    /** Listen on 127.0.0.1. port 0 → random port (tests). */
    listen(p) {
      return new Promise((ok, bad) => {
        server.once('error', bad);
        server.listen(p, '127.0.0.1', () => ok((port = server.address().port)));
      });
    },
    // A scan still running is not awaited: on the next start it is marked failed ("run it again").
    close: () => new Promise((ok) => (hosted?.stop(), server.close(() => (db.close(), ok())))),
  };
}
