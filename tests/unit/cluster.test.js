// Synthetic data. Tests the funding graph & cluster detection, including false-positive handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, RELATIONS, buildFundingGraph } from '../../src/scanner/fundingGraph.js';
import { detectClusters, detectTimingGroups, clusterSupply, isSuspectedService } from '../../src/scanner/walletCluster.js';
import { createLabelRegistry } from '../../src/config/labels.js';
import { A, H, createMockChain, createMockExplorer, nativeTx } from '../helpers/mockChain.js';
import { toJson } from '../../src/utils/format.js';

const labels = () => createLabelRegistry();
const fund = (g, n, from, to, eth, ts) =>
  g.addEdge({ from, to, txHash: H(n), blockNumber: 100 + n, timestamp: ts, asset: 'ETH', amount: BigInt(Math.round(eth * 1e6)) * 10n ** 12n, relation: RELATIONS.NATIVE_FUNDING, source: 'test' });
const trader = (a, block, ts, sellBlock = null) => ({ address: a, firstBuy: { blockNumber: block, timestamp: ts, txHash: H(block) }, firstSell: sellBlock ? { blockNumber: sellBlock, txHash: H(sellBlock + 1) } : null });

test('graph: duplicate edges ignored and evidence kept', () => {
  const g = createGraph();
  fund(g, 1, A(0xf), A(1), 0.5, 1000);
  fund(g, 1, A(0xf), A(1), 0.5, 1000);
  assert.equal(g.edges.length, 1);
  const e = g.edges[0];
  for (const k of ['from', 'to', 'txHash', 'blockNumber', 'timestamp', 'asset', 'amount', 'relation', 'source', 'verification']) assert.ok(k in e, `edge memuat ${k}`);
});

test('cluster: single funder + similar amounts + close timing + coordinated buys → STRONG_CORRELATION', () => {
  const g = createGraph();
  const F = A(0xf);
  const [B1, B2] = [A(1), A(2)];
  fund(g, 1, F, B1, 0.5, 1000);
  fund(g, 2, F, B2, 0.51, 1300);
  const interest = new Set([B1, B2]);
  const r = detectClusters({ graph: g, interest, traders: [trader(B1, 500, 2000), trader(B2, 501, 2010)], labels: labels(), coverage: { nativeFunding: 'COMPLETE_FOR_TARGETS' } });
  const c = r.clusters.find((x) => x.basis === 'FUNDING_AND_TRANSFERS');
  assert.ok(c);
  assert.equal(c.label, 'STRONG_CORRELATION');
  const ids = c.indicators.map((i) => i.id);
  for (const id of ['SHARED_FUNDER', 'FUNDING_TIME_PROXIMITY', 'SIMILAR_FUNDING_AMOUNTS', 'FRESH_WALLET_BUY', 'COORDINATED_BUY_TIMING']) assert.ok(ids.includes(id), id);
  assert.ok(c.wallets.some((w) => w.address.toLowerCase() === F && w.isSharedFunder));
  assert.ok(c.evidence.length >= 2);
  assert.ok(c.alternatives.length > 0);
  assert.ok(c.limitations.some((l) => /does not prove/.test(l)));
});

test('cluster: no "same owner" label', () => {
  const g = createGraph();
  fund(g, 1, A(0xf), A(1), 0.5, 1000);
  fund(g, 2, A(0xf), A(2), 0.5, 1001);
  const r = detectClusters({ graph: g, interest: new Set([A(1), A(2)]), traders: [], labels: labels() });
  for (const c of r.clusters) assert.ok(['OBSERVED_LINK', 'POSSIBLE_CLUSTER', 'STRONG_CORRELATION', 'UNVERIFIED'].includes(c.label));
  assert.ok(!toJson(r).includes('SAME_OWNER'));
});

test('false positive: funder labeled EXCHANGE is excluded', () => {
  const EX = A(0xe);
  const reg = createLabelRegistry([{ address: EX, label: 'Exchange Hot Wallet (synthetic)', kind: 'EXCHANGE', source: 'test' }]);
  const g = createGraph();
  fund(g, 1, EX, A(1), 1, 1000);
  fund(g, 2, EX, A(2), 1, 1001);
  const r = detectClusters({ graph: g, interest: new Set([A(1), A(2)]), traders: [], labels: reg });
  assert.equal(r.clusters.length, 0);
  assert.equal(r.excludedFunders.length, 1);
});

test('false positive: labeled BRIDGE funder is excluded', () => {
  const BR = A(0xb4);
  const reg = createLabelRegistry([{ address: BR, label: 'Bridge (synthetic)', kind: 'BRIDGE', source: 'test' }]);
  const g = createGraph();
  fund(g, 1, BR, A(1), 1, 1000);
  fund(g, 2, BR, A(2), 1, 1001);
  assert.equal(detectClusters({ graph: g, interest: new Set([A(1), A(2)]), traders: [], labels: reg }).clusters.length, 0);
});

test('false positive: high-nonce funder (hot wallet) is excluded', () => {
  const g = createGraph();
  const F = A(0xf);
  fund(g, 1, F, A(1), 1, 1000);
  fund(g, 2, F, A(2), 1, 1001);
  const profiles = new Map([[F, { address: F, fundedInterestWallets: 2, nonce: 99_999, isContract: false }]]);
  const r = detectClusters({ graph: g, interest: new Set([A(1), A(2)]), funderProfiles: profiles, traders: [], labels: labels() });
  assert.equal(r.clusters.length, 0);
  assert.match(r.excludedFunders[0].reason, /nonce/);
  assert.equal(isSuspectedService({ address: F, nonce: 3, isContract: false, fundedInterestWallets: 2 }, labels()).suspected, false);
});

test('unrelated wallets → no cluster', () => {
  const g = createGraph();
  fund(g, 1, A(0xf1), A(1), 1, 1000);
  fund(g, 2, A(0xf2), A(2), 1, 9_000_000);
  const r = detectClusters({ graph: g, interest: new Set([A(1), A(2)]), traders: [trader(A(1), 10, 2000), trader(A(2), 9000, 9_000_100)], labels: labels() });
  assert.equal(r.clusters.length, 0);
  assert.equal(r.summary.meaningfulCount, 0);
});

test('timing pattern only → UNVERIFIED (TIMING_ONLY), not a meaningful cluster', () => {
  const traders = [trader(A(1), 100, 1), trader(A(2), 100, 1), trader(A(3), 101, 2), trader(A(4), 5000, 3)];
  assert.equal(detectTimingGroups(traders).length, 1);
  const r = detectClusters({ graph: createGraph(), interest: new Set(traders.map((t) => t.address)), traders, labels: labels() });
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].label, 'UNVERIFIED');
  assert.equal(r.clusters[0].basis, 'TIMING_ONLY');
  assert.equal(r.summary.meaningfulCount, 0);
});

test('direct transfer only → OBSERVED_LINK', () => {
  const g = createGraph();
  g.addEdge({ from: A(1), to: A(2), txHash: H(5), blockNumber: 5, asset: 'SYN', amount: 10n, relation: RELATIONS.TOKEN_TRANSFER, source: 'test' });
  const r = detectClusters({ graph: g, interest: new Set([A(1), A(2)]), traders: [], labels: labels() });
  assert.equal(r.clusters[0].label, 'OBSERVED_LINK');
});

test('clusterSupply: each address counted once & infrastructure excluded', () => {
  const reg = labels();
  const balances = new Map([
    [A(1), 100n],
    [A(2), 50n],
    ['0x000000000000000000000000000000000000dead', 500n],
  ]);
  const s = clusterSupply([A(1), A(1), A(2), '0x000000000000000000000000000000000000dEaD'], balances, 1000n, reg);
  assert.equal(s.balance, 150n);
  assert.equal(s.pct, 15);
});

test('buildFundingGraph: EXECUTED_FOR_OTHER, explorer funding, funder profiles', async () => {
  const chain = createMockChain();
  const [B1, B2, F, S] = [A(1), A(2), A(0xf), A(0x5)];
  chain.setNonce(F, 4);
  const explorer = createMockExplorer({ [B1]: [nativeTx(1, F, B1, 0.5, 10)], [B2]: [nativeTx(2, F, B2, 0.5, 11)] });
  const { createRpcClient } = await import('../../src/adapters/evm/rpcClient.js');
  const rpc = createRpcClient(chain.transport);
  const trades = [{ side: 'SELL', trader: B1, txFrom: S, executedForOther: true, txHash: H(77), blockNumber: 20, tokenAmount: '5', logIndex: 1 }];
  const r = await buildFundingGraph({ rpc, traders: [{ address: B1 }, { address: B2 }], trades, transfers: [], deployer: null, explorer, labels: labels() });
  const rel = r.graph.edges.map((e) => e.relation);
  assert.ok(rel.includes('EXECUTED_FOR_OTHER'));
  assert.equal(rel.filter((x) => x === 'NATIVE_FUNDING').length, 2);
  assert.equal(r.coverage.nativeFunding, 'COMPLETE_FOR_TARGETS');
  assert.equal(r.funderProfiles.get(F).nonce, 4);
});

test('buildFundingGraph without explorer → coverage NONE with a note', async () => {
  const { createRpcClient } = await import('../../src/adapters/evm/rpcClient.js');
  const rpc = createRpcClient(createMockChain().transport);
  const r = await buildFundingGraph({ rpc, traders: [{ address: A(1) }], trades: [], transfers: [], deployer: null, explorer: null, labels: labels() });
  assert.equal(r.coverage.nativeFunding, 'NONE');
  assert.match(r.coverage.note, /PARTIAL DATA/);
});
