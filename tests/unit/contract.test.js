// Synthetic bytecode & state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSelectors, detectMinimalProxy, analyzeContract, EIP1967 } from '../../src/scanner/contractRisk.js';
import { createRpcClient } from '../../src/adapters/evm/rpcClient.js';
import { createMockChain, A, H } from '../helpers/mockChain.js';
import { OWNABLE } from '../../src/adapters/evm/abis.js';
import { selectPrimaryPools } from '../../src/adapters/evm/dexAdapter.js';

// PUSH4 (0x63) + selector
const MINT = '6340c10f19'; // mint(address,uint256)
const PAUSE = '638456cb59'; // pause()
const SETFEE = '6369fe0e2d'; // setFee(uint256)

test('scanSelectors: detects mint / pause / fee setter from PUSH4', () => {
  const hits = scanSelectors('0x6080' + MINT + PAUSE + SETFEE).map((h) => h.id);
  assert.ok(hits.includes('MINT'));
  assert.ok(hits.includes('PAUSE'));
  assert.ok(hits.includes('FEE_SETTER'));
  assert.deepEqual(scanSelectors('0x6080604052'), []);
});

test('detectMinimalProxy: EIP-1167', () => {
  const impl = 'bebebebebebebebebebebebebebebebebebebebe';
  assert.equal(detectMinimalProxy(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`).toLowerCase(), '0x' + impl);
  assert.equal(detectMinimalProxy('0x6080'), null);
});

test('analyzeContract: token with mint + active owner', async () => {
  const chain = createMockChain();
  const T = A(0x71);
  chain.setCode(T, '0x6080' + MINT);
  chain.setCall(T, OWNABLE, 'owner', [A(0xd1)]);
  const r = await analyzeContract({ rpc: createRpcClient(chain.transport), address: T, code: '0x6080' + MINT });
  assert.equal(r.ownerStatus, 'ACTIVE');
  const mint = r.findings.find((f) => f.id === 'MINT');
  assert.equal(mint.level, 'STATIC');
  assert.equal(mint.severity, 30);
  assert.ok(r.findings.some((f) => f.id === 'OWNER_ACTIVE' && f.level === 'ONCHAIN_STATE'));
  assert.ok(r.score >= 40);
});

test('analyzeContract: owner renounced → owner-gated severity reduced, still reported', async () => {
  const chain = createMockChain();
  const T = A(0x72);
  chain.setCode(T, '0x6080' + MINT);
  chain.setCall(T, OWNABLE, 'owner', [A(0)]);
  const r = await analyzeContract({ rpc: createRpcClient(chain.transport), address: T, code: '0x6080' + MINT });
  assert.equal(r.ownerStatus, 'RENOUNCED');
  assert.equal(r.findings.find((f) => f.id === 'MINT').severity, 15);
  assert.ok(r.positives.some((p) => /does not guarantee/.test(p)));
});

test('analyzeContract: EIP-1967 proxy detected from storage', async () => {
  const chain = createMockChain();
  const T = A(0x73);
  const IMPL = A(0x74);
  chain.setCode(T, '0x6080');
  chain.setCode(IMPL, '0x6080' + PAUSE);
  chain.setStorage(T, EIP1967.implementation, '0x' + IMPL.slice(2).padStart(64, '0'));
  const r = await analyzeContract({ rpc: createRpcClient(chain.transport), address: T, code: '0x6080' });
  assert.ok(r.findings.some((f) => f.id === 'UPGRADEABLE_PROXY' && f.level === 'ONCHAIN_STATE'));
  assert.ok(r.findings.some((f) => f.id === 'PAUSE'), 'implementation selectors are scanned too');
  assert.equal(r.ownerStatus, 'UNKNOWN');
});

test('analyzeContract: no-sells indication is only an indication, not a honeypot claim', async () => {
  const chain = createMockChain();
  const T = A(0x75);
  chain.setCode(T, '0x6080');
  const r = await analyzeContract({ rpc: createRpcClient(chain.transport), address: T, code: '0x6080', tradeStats: { buys: 12, sells: 0 } });
  const f = r.findings.find((x) => x.id === 'NO_SELLS_OBSERVED');
  assert.match(f.detail, /not proof of a honeypot/);
  assert.ok(r.checks.some((c) => c.id === 'HONEYPOT_SIMULATION' && c.status === 'NOT_CHECKED'));
});

// --- Primary pool selection (synthetic data) ---

test('selectPrimaryPools: Pons token → Pons-hooked pool with pair = pairToken', () => {
  const T = A(0xa1);
  const PAIR = A(0xb1);
  const pool = (id, block, other, isPonsPool) => ({ poolId: H(id), blockNumber: block, currency0: T, currency1: other, tokenIsCurrency0: true, isPonsPool });
  const pools = [pool(1, 50, A(0xcc), false), pool(2, 120, A(0xdd), true), pool(3, 110, PAIR, true), pool(4, 200, PAIR, true)];
  const r = selectPrimaryPools(pools, { blockNumber: 100, pairToken: PAIR, pairIsNative: false });
  assert.deepEqual(r.primary.map((p) => p.poolId), [H(3)]);
  assert.equal(r.others.length, 3);
  assert.equal(r.method, 'PONS_HOOK_AND_PAIR_TOKEN');
});

test('selectPrimaryPools: Pons not graduated → no primary pool; non-Pons → earliest pool', () => {
  const T = A(0xa1);
  const pools = Array.from({ length: 8 }, (_, i) => ({ poolId: H(i), blockNumber: 100 - i, currency0: T, currency1: A(0xc0 + i), tokenIsCurrency0: true, isPonsPool: false }));
  assert.equal(selectPrimaryPools(pools, { blockNumber: 1, pairToken: A(0), pairIsNative: true }).method, 'NOT_GRADUATED_OR_NOT_FOUND');
  const r = selectPrimaryPools(pools, null);
  assert.equal(r.primary.length, 5);
  assert.equal(r.primary[0].blockNumber, 93);
});
