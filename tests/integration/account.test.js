// Account server (server/): SIWE sign-in, sessions, API keys, CLI whoami. In-memory SQLite, no network.
// The signing wallet is a SYNTHETIC throwaway created per run (ethers Wallet.createRandom) — never stored.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { request } from 'node:http';
import { createAccountServer, API_KEY_RE } from '../../server/app.js';
import { buildSiweMessage, signatureMatches } from '../../server/siwe.js';

const ORIGIN = 'https://ringhunter.test';
let app;
let base;
let clock = Date.parse('2026-11-02T12:00:00Z');

before(async () => {
  app = createAccountServer({ publicOrigin: ORIGIN, now: () => clock });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});
after(() => app.close());

/** fetch sends Host 127.0.0.1:<port> (allowed, like a local health check); POST adds the site's Origin. */
function api(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (method === 'POST') Object.assign(h, { origin: ORIGIN, 'content-type': 'application/json' }, headers);
  if (cookie) h.cookie = cookie;
  return fetch(base + path, { method, headers: h, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
}

async function signIn(wallet) {
  const n = await (await api('/api/auth/nonce', { method: 'POST', body: { address: wallet.address } })).json();
  const signature = await wallet.signMessage(n.message);
  const res = await api('/api/auth/verify', { method: 'POST', body: { nonce: n.nonce, signature } });
  return { res, n, signature, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

test('SIWE message: EIP-4361 fields, bound to the site domain and Robinhood Chain', () => {
  const w = Wallet.createRandom();
  const m = buildSiweMessage({ origin: ORIGIN, address: w.address.toLowerCase(), nonce: 'a'.repeat(32), issuedAt: clock, expiresAt: clock + 600_000 });
  const lines = m.split('\n');
  assert.equal(lines[0], 'ringhunter.test wants you to sign in with your Ethereum account:');
  assert.equal(lines[1], w.address, 'checksummed address');
  for (const l of [`URI: ${ORIGIN}`, 'Version: 1', 'Chain ID: 4663', `Nonce: ${'a'.repeat(32)}`, 'Issued At: 2026-11-02T12:00:00.000Z', 'Expiration Time: 2026-11-02T12:10:00.000Z']) assert.ok(lines.includes(l), l);
  assert.match(m, /not a transaction/);
  assert.equal(signatureMatches(m, '0x1234', w.address), false);
});

test('sign-in → session cookie → API key shown once → CLI whoami with the key', async () => {
  const w = Wallet.createRandom();
  const { res, cookie } = await signIn(w);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).address, w.address);
  const setCookie = res.headers.get('set-cookie');
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(setCookie.includes(attr), attr);

  let me = await (await api('/api/me', { cookie })).json();
  assert.deepEqual(me, { address: w.address, apiKey: null, admin: false });

  const created = await (await api('/api/key', { method: 'POST', cookie })).json();
  assert.match(created.apiKey, API_KEY_RE);
  assert.equal(created.prefix, created.apiKey.slice(0, 10));
  me = await (await api('/api/me', { cookie })).json();
  assert.equal(me.apiKey.prefix, created.prefix);
  assert.ok(!JSON.stringify(me).includes(created.apiKey), 'full key is never shown again');
  // Only hashes are stored.
  assert.equal(app.db.findKey(created.apiKey), null, 'raw key is not a lookup key');

  const who = await api('/api/cli/whoami', { headers: { authorization: `Bearer ${created.apiKey}` } });
  assert.equal(who.status, 200);
  assert.equal((await who.json()).address, w.address);

  // Rotate: the old key stops working.
  const rotated = await (await api('/api/key', { method: 'POST', cookie })).json();
  assert.notEqual(rotated.apiKey, created.apiKey);
  assert.equal((await api('/api/cli/whoami', { headers: { authorization: `Bearer ${created.apiKey}` } })).status, 401);
  assert.equal((await api('/api/cli/whoami', { headers: { authorization: `Bearer ${rotated.apiKey}` } })).status, 200);

  // Revoke, then logout ends the session.
  assert.deepEqual(await (await api('/api/key/revoke', { method: 'POST', cookie })).json(), { revoked: true });
  assert.equal((await api('/api/cli/whoami', { headers: { authorization: `Bearer ${rotated.apiKey}` } })).status, 401);
  assert.equal((await api('/api/logout', { method: 'POST', cookie })).status, 200);
  assert.equal((await api('/api/me', { cookie })).status, 401);
});

test('nonce is single use, expires, and a signature from another wallet is rejected', async () => {
  const w = Wallet.createRandom();
  const { res, n, signature } = await signIn(w);
  assert.equal(res.status, 200);
  const replay = await api('/api/auth/verify', { method: 'POST', body: { nonce: n.nonce, signature } });
  assert.equal(replay.status, 401, 'replay refused');

  const other = Wallet.createRandom();
  const n2 = await (await api('/api/auth/nonce', { method: 'POST', body: { address: w.address } })).json();
  const bad = await api('/api/auth/verify', { method: 'POST', body: { nonce: n2.nonce, signature: await other.signMessage(n2.message) } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  const n3 = await (await api('/api/auth/nonce', { method: 'POST', body: { address: w.address } })).json();
  clock += 11 * 60 * 1000;
  const late = await api('/api/auth/verify', { method: 'POST', body: { nonce: n3.nonce, signature: await w.signMessage(n3.message) } });
  assert.equal(late.status, 401, 'expired');
});

test('CSRF & input guards: wrong Origin, non-JSON body, bad address, foreign Host, unknown routes', async () => {
  const w = Wallet.createRandom();
  assert.equal((await api('/api/auth/nonce', { method: 'POST', body: { address: w.address }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await api('/api/auth/nonce', { method: 'POST', body: { address: w.address }, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await api('/api/auth/nonce', { method: 'POST', body: { address: 'not-an-address' } })).status, 400);
  // fetch cannot override Host, so this one goes through node:http (DNS-rebinding guard).
  const withHost = (host, path) =>
    new Promise((ok, bad) => {
      const u = new URL(base);
      request({ host: u.hostname, port: u.port, path, headers: { Host: host } }, (r) => (r.resume(), ok(r.statusCode))).on('error', bad).end();
    });
  assert.equal(await withHost('evil.example', '/api/me'), 421);
  assert.equal(await withHost('ringhunter.test', '/index.html'), 200, 'the public host (via the reverse proxy) is accepted');
  assert.equal((await api('/api/me')).status, 401);
  assert.equal((await api('/api/cli/whoami', { headers: { authorization: 'Bearer rh_short' } })).status, 401);
  assert.equal((await api('/api/nope', { method: 'POST' })).status, 404);
  assert.equal((await api('/api/scan', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403, 'cross-origin cookie POST refused');
  assert.equal((await api('/api/me', { method: 'POST' })).status, 405);
  assert.equal((await api('/index.html')).status, 200, 'static pages are still served');
});

test('rate limit on sign-in endpoints', async () => {
  const w = Wallet.createRandom();
  clock += 61_000; // fresh window
  const codes = [];
  for (let i = 0; i < 22; i++) codes.push((await api('/api/auth/nonce', { method: 'POST', body: { address: w.address } })).status);
  assert.ok(codes.slice(0, 20).every((c) => c === 200));
  assert.equal(codes.at(-1), 429);
  clock += 61_000;
});
