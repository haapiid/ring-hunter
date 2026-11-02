// RING-HUNTER Pro (server/): ETH payment claim by tx hash, token-holder Pro, hosted scans, watchlist, share links,
// launch feed, and the read-only RPC proxy. Everything runs against a MOCK chain (no network).
// Wallets are SYNTHETIC throwaways (Wallet.createRandom); tx hashes, the treasury, and the token are synthetic too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, parseEther, zeroPadValue, toBeHex } from 'ethers';
import { createAccountServer, PRO_LIMITS } from '../../server/app.js';
import { proSettings, verifyPayment, ProError } from '../../server/pro.js';
import { createHostedService } from '../../server/hosted.js';
import { ERC20, PONS_FACTORY, TOPICS } from '../../src/adapters/evm/abis.js';
import { PONS } from '../../src/config/networks.js';

const ORIGIN = 'https://ringhunter.test';
const TREASURY = '0x' + '7e'.repeat(20);
const TOKEN = '0x' + '70'.repeat(20);
const SCANNED = '0x' + '5c'.repeat(20);
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const clock = Date.parse('2026-11-02T12:00:00Z');

// ---- mock chain ----
const txs = new Map();
const receipts = new Map();
const balances = new Map(); // holder (lowercase) → bigint (18 decimals)
function addTx(n, { from, to = TREASURY, value = parseEther('0.01'), status = 1, chainId = 4663, pending = false }) {
  txs.set(hash(n), { hash: hash(n), from, to, value: toBeHex(value), chainId: toBeHex(chainId), blockNumber: pending ? null : '0x10' });
  if (!pending) receipts.set(hash(n), { status: toBeHex(status) });
}
const chainRpc = {
  getTransaction: async (h) => txs.get(h) ?? null,
  getReceipt: async (h) => receipts.get(h) ?? null,
  async call(to, data) {
    assert.equal(to.toLowerCase(), TOKEN);
    const f = ERC20.parseTransaction({ data });
    if (f.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [18]);
    return ERC20.encodeFunctionResult('balanceOf', [balances.get(f.args[0].toLowerCase()) ?? 0n]);
  },
  blockNumber: async () => 1000,
  async getLogsChunked({ address, topics }) {
    assert.equal(address, PONS.factory);
    assert.equal(topics[0], TOPICS.TokenLaunched);
    const ev = PONS_FACTORY.encodeEventLog('TokenLaunched', [SCANNED, '0x' + 'cc'.repeat(20), '0x' + 'dd'.repeat(20), '0x' + '00'.repeat(20), 1n, 2n]);
    return { complete: true, logs: [{ ...ev, blockNumber: '0x3e0', transactionHash: hash(999) }] };
  },
};

// Hosted scans use a stub scanner (the real pipeline is covered by the other integration tests).
const scanned = [];
const fakeScan = async (token) => {
  scanned.push(token);
  if (token.toLowerCase() === '0x' + 'ee'.repeat(20)) throw new Error('boom');
  return { token: { symbol: 'PXT1' }, scoring: { score: 43, level: 'MODERATE_RISK' } };
};

// Upstream RPC for the proxy.
const upstreamCalls = [];
const fakeFetch = async (url, init) => {
  upstreamCalls.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' }), { status: 200 });
};

let app;
let base;
let hosted;
before(async () => {
  app = createAccountServer({
    publicOrigin: ORIGIN,
    now: () => clock,
    pro: proSettings({ RH_TREASURY: TREASURY, RH_PRO_PRICE_ETH: '0.01', RH_PRO_DAYS: '30', RH_PRO_TOKEN: TOKEN, RH_PRO_TOKEN_MIN: '1000' }),
    chainRpc,
    rpcUpstream: 'https://upstream.invalid/rpc',
    fetchImpl: fakeFetch,
    createHosted: (db) => (hosted = createHostedService({ db, scan: fakeScan, now: () => clock, log: () => {} })),
  });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(() => app.close());

function api(path, { method = 'GET', body, cookie, key, headers = {} } = {}) {
  const h = { ...headers };
  if (method === 'POST') Object.assign(h, { 'content-type': 'application/json' }, key ? {} : { origin: ORIGIN }, headers);
  if (cookie) h.cookie = cookie;
  if (key) h.authorization = `Bearer ${key}`;
  return fetch(base + path, { method, headers: h, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body ?? {})) : undefined });
}
async function signIn(wallet) {
  const n = await (await api('/api/auth/nonce', { method: 'POST', body: { address: wallet.address } })).json();
  const res = await api('/api/auth/verify', { method: 'POST', body: { nonce: n.nonce, signature: await wallet.signMessage(n.message) } });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { apiKey } = await (await api('/api/key', { method: 'POST', cookie })).json();
  return { cookie, key: apiKey };
}

test('proSettings: nothing is guessed — features stay off without env values; bad values throw', () => {
  const off = proSettings({});
  assert.equal(off.treasury, null);
  assert.equal(off.priceWei, null);
  assert.equal(off.token, null);
  assert.throws(() => proSettings({ RH_TREASURY: 'nope' }));
  assert.throws(() => proSettings({ RH_PRO_PRICE_ETH: '0' }));
  assert.throws(() => proSettings({ RH_PRO_TOKEN_MIN: '1e9' }));
});

test('verifyPayment rejects wrong recipient, wrong payer, failed, pending, underpaid, other chain', async () => {
  const s = proSettings({ RH_TREASURY: TREASURY, RH_PRO_PRICE_ETH: '0.01' });
  const payer = Wallet.createRandom().address;
  addTx(101, { from: payer, to: '0x' + '11'.repeat(20) });
  addTx(102, { from: Wallet.createRandom().address });
  addTx(103, { from: payer, status: 0 });
  addTx(104, { from: payer, pending: true });
  addTx(105, { from: payer, value: parseEther('0.009') });
  addTx(106, { from: payer, chainId: 1 });
  addTx(107, { from: payer, value: parseEther('1') }); // 100 periods → capped at 12
  const err = async (n) => (await verifyPayment(chainRpc, s, { txHash: hash(n), payer }).catch((e) => e)).message;
  assert.match(await err(101), /treasury/);
  assert.match(await err(102), /different wallet/);
  assert.match(await err(103), /failed/);
  assert.match(await err(104), /pending/);
  assert.match(await err(105), /below the Pro price/);
  assert.match(await err(106), /Robinhood Chain/);
  assert.match(await err(404), /not found/);
  await assert.rejects(verifyPayment(chainRpc, s, { txHash: '0x12', payer }), ProError);
  assert.equal((await verifyPayment(chainRpc, s, { txHash: hash(107), payer })).days, 12 * 30);
  await assert.rejects(verifyPayment(chainRpc, proSettings({}), { txHash: hash(107), payer }), /not open/);
});

test('free account: Pro features answer 402; payment claim credits 30 days once; whoami shows Pro', async () => {
  const w = Wallet.createRandom();
  const { cookie, key } = await signIn(w);
  let pro = await (await api('/api/pro', { cookie })).json();
  assert.equal(pro.active, false);
  assert.deepEqual(pro.paymentHistory, []);
  assert.equal(pro.tokenHolder.qualifies, false);
  assert.deepEqual(pro.limits, PRO_LIMITS);
  assert.equal(pro.payments.treasury.toLowerCase(), TREASURY);
  assert.equal(pro.payments.priceEth, '0.01');
  for (const [path, opts] of [
    ['/api/scan', { method: 'POST', body: { tokens: [SCANNED] }, key }],
    ['/api/watch', { method: 'POST', body: { token: SCANNED }, key }],
    ['/api/launches', { key }],
    ['/api/rpc', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, key }],
  ]) assert.equal((await api(path, opts)).status, 402, path);

  addTx(201, { from: w.address });
  let r = await api('/api/pro/claim', { method: 'POST', cookie, body: { txHash: hash(201) } });
  assert.equal(r.status, 200);
  pro = await r.json();
  assert.equal(pro.active, true);
  assert.equal(pro.days, 30);
  assert.equal(pro.paidUntil, new Date(clock + 30 * 86_400_000).toISOString());

  r = await api('/api/pro/claim', { method: 'POST', cookie, body: { txHash: hash(201) } });
  assert.equal(r.status, 409, 'the same payment cannot be credited twice');
  const other = await signIn(Wallet.createRandom());
  r = await api('/api/pro/claim', { method: 'POST', cookie: other.cookie, body: { txHash: hash(201) } });
  assert.equal(r.status, 409, 'nor claimed by another account');
  r = await api('/api/pro/claim', { method: 'POST', key, body: { txHash: hash(201) } });
  assert.equal(r.status, 401, 'claims need the website session, not an API key');

  const who = await (await api('/api/cli/whoami', { key })).json();
  assert.deepEqual(who.pro, { active: true, paidUntil: pro.paidUntil, tokenHolder: false });
});

test('token-holder Pro: balanceOf ≥ RH_PRO_TOKEN_MIN activates Pro without paying', async () => {
  const w = Wallet.createRandom();
  balances.set(w.address.toLowerCase(), parseEther('1000'));
  const { cookie } = await signIn(w);
  const pro = await (await api('/api/pro', { cookie })).json();
  assert.equal(pro.active, true);
  assert.equal(pro.paidUntil, null);
  assert.deepEqual(pro.tokenHolder, { balance: '1000.0', qualifies: true });
  assert.equal(pro.token.address.toLowerCase(), TOKEN);
  assert.equal(pro.token.minBalance, '1000');
});

test('hosted scan (batch), history, share link, daily limit, watchlist, launch feed', async () => {
  const w = Wallet.createRandom();
  balances.set(w.address.toLowerCase(), parseEther('5000'));
  const { cookie, key } = await signIn(w);

  assert.equal((await api('/api/scan', { method: 'POST', key, body: { tokens: Array(6).fill(0).map((_, i) => '0x' + String(i + 1).repeat(40)) } })).status, 400, 'batch is capped');
  assert.equal((await api('/api/scan', { method: 'POST', key, body: { tokens: ['0x123'] } })).status, 400);
  const r = await api('/api/scan', { method: 'POST', key, body: { tokens: [SCANNED, '0x' + 'ee'.repeat(20)] } });
  assert.equal(r.status, 202);
  const { queued } = await r.json();
  assert.equal(queued.length, 2);
  await hosted.drain();

  const { scans } = await (await api('/api/scans', { cookie })).json();
  const ok = scans.find((s) => s.id === queued[0].id);
  assert.equal(ok.status, 'done');
  assert.equal(ok.score, 43);
  assert.equal(ok.symbol, 'PXT1');
  assert.equal(scans.find((s) => s.id === queued[1].id).status, 'failed');

  // Share link: readable without signing in; no owner address inside.
  const shared = await (await api(`/api/report?id=${queued[0].id}`)).json();
  assert.equal(shared.report.scoring.score, 43);
  assert.ok(!JSON.stringify(shared).includes(w.address));
  assert.equal((await api('/api/report?id=../../etc')).status, 400);
  assert.equal((await api(`/api/report?id=${'A'.repeat(22)}`)).status, 404);

  // Watchlist: adding queues a scan; a second scan with a different score is flagged as changed.
  assert.equal((await api('/api/watch', { method: 'POST', key, body: { token: SCANNED } })).status, 200);
  await hosted.drain();
  let { watchlist } = await (await api('/api/watch', { key })).json();
  assert.equal(watchlist.length, 1);
  assert.equal(watchlist[0].score, 43);
  assert.equal(watchlist[0].changed, false);
  app.db.recordWatchScan(watchlist[0].token, watchlist[0].lastReportId, 70, 'HIGH_OBSERVED_RISK', clock);
  ({ watchlist } = await (await api('/api/watch', { key })).json());
  assert.equal(watchlist[0].changed, true);
  assert.equal(hosted.watchTick(), 0, 'recently scanned tokens are not re-queued');
  assert.equal((await api('/api/watch/remove', { method: 'POST', key, body: { token: SCANNED } })).status, 200);
  assert.equal((await (await api('/api/watch', { key })).json()).watchlist.length, 0);

  // Launch feed from Pons TokenLaunched logs.
  assert.equal(await hosted.launchesTick(chainRpc), 1);
  const { launches } = await (await api('/api/launches', { key })).json();
  assert.equal(launches[0].token.toLowerCase(), SCANNED);
  assert.equal(launches[0].block, 0x3e0);

  // Daily limit.
  for (let i = scans.length; i < PRO_LIMITS.scansPerDay; i++) app.db.addReport(`x${String(i).padStart(21, '0')}`, w.address, SCANNED, clock);
  assert.equal((await api('/api/scan', { method: 'POST', key, body: { tokens: [SCANNED] } })).status, 429);
});

test('RPC proxy: Pro key only, read methods only, no cookies, forwards a clean request', async () => {
  const w = Wallet.createRandom();
  balances.set(w.address.toLowerCase(), parseEther('1000'));
  const { cookie, key } = await signIn(w);
  upstreamCalls.length = 0;
  let r = await api('/api/rpc', { method: 'POST', key, body: { jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [], extra: 'dropped' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result, '0x1237');
  assert.deepEqual(upstreamCalls[0].body, { jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] });

  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'debug_traceTransaction']) {
    r = await api('/api/rpc', { method: 'POST', key, body: { jsonrpc: '2.0', id: 1, method, params: ['0x00'] } });
    assert.equal(r.status, 403, method);
  }
  r = await api('/api/rpc', { method: 'POST', key, body: [{ method: 'eth_blockNumber' }, { method: 'eth_sendRawTransaction', params: ['0x00'] }] });
  assert.equal(r.status, 403, 'one write call blocks the whole batch');
  r = await api('/api/rpc', { method: 'POST', cookie, body: { method: 'eth_chainId' } });
  assert.equal(r.status, 401, 'the RPC proxy takes API keys only');
  assert.equal(upstreamCalls.length, 1, 'nothing blocked reached the upstream');
});
