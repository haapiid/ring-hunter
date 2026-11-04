// Official token panel: GET /api/token (public) and POST /api/admin/token (admin wallet session only, checked
// read-only on a MOCK chain). Wallets are SYNTHETIC throwaways (Wallet.createRandom); token addresses are synthetic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { createAccountServer } from '../../server/app.js';
import { ERC20 } from '../../src/adapters/evm/abis.js';

const ORIGIN = 'https://ringhunter.test';
const TOKEN = '0x' + '7a'.repeat(20);
const NOT_ERC20 = '0x' + '7b'.repeat(20);
const EOA = '0x' + '7c'.repeat(20);
const admin = Wallet.createRandom();
const other = Wallet.createRandom();

const chainRpc = {
  getCode: async (a) => (a.toLowerCase() === EOA ? '0x' : '0x6080'),
  async call(to, data) {
    if (to.toLowerCase() !== TOKEN) throw new Error('execution reverted');
    const f = ERC20.parseTransaction({ data });
    return ERC20.encodeFunctionResult(f.name, [{ name: 'Ring Hunter <b>', symbol: 'RH', decimals: 18 }[f.name]]);
  },
};

let app;
let base;
before(async () => {
  app = createAccountServer({ publicOrigin: ORIGIN, now: () => Date.parse('2026-11-04T08:00:00Z'), chainRpc, admins: [admin.address] });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(() => app.close());

const post = (path, body, cookie, origin = ORIGIN) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
async function signIn(w) {
  const n = await (await post('/api/auth/nonce', { address: w.address })).json();
  const res = await post('/api/auth/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) });
  return res.headers.get('set-cookie').split(';')[0];
}
const publicToken = async () => (await (await fetch(base + '/api/token')).json()).token;

test('no official token until the admin sets one', async () => {
  assert.equal(await publicToken(), null);
});

test('only the admin wallet can set the token; /api/me says who is admin', async () => {
  assert.equal((await post('/api/admin/token', { address: TOKEN })).status, 401);
  const c = await signIn(other);
  assert.equal((await (await fetch(base + '/api/me', { headers: { cookie: c } })).json()).admin, false);
  const r = await post('/api/admin/token', { address: TOKEN }, c);
  assert.equal(r.status, 403);
  assert.equal(await publicToken(), null);
});

test('the admin sets a verified ERC-20; bad addresses are refused and change nothing', async () => {
  const c = await signIn(admin);
  assert.equal((await (await fetch(base + '/api/me', { headers: { cookie: c } })).json()).admin, true);
  assert.equal((await post('/api/admin/token', { address: TOKEN }, c, 'https://evil.test')).status, 403);
  for (const [address, status] of [['0x1234', 400], [EOA, 400], [NOT_ERC20, 400]]) {
    assert.equal((await post('/api/admin/token', { address }, c)).status, status, address);
  }
  assert.equal(await publicToken(), null);

  const r = await post('/api/admin/token', { address: TOKEN.toUpperCase().replace('0X', '0x') }, c);
  assert.equal(r.status, 200);
  const t = await publicToken();
  assert.equal(t.address.toLowerCase(), TOKEN);
  assert.equal(t.symbol, 'RH');
  assert.equal(t.name, 'Ring Hunter <b>'); // raw on-chain text; the page renders it with textContent
  assert.equal(t.setAt, '2026-11-04T08:00:00.000Z');

  assert.equal((await post('/api/admin/token', { address: null }, c)).status, 200);
  assert.equal(await publicToken(), null);
});
