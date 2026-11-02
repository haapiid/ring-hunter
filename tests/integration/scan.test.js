// Integration test of the full scan flow on a SYNTHETIC mock chain (no network, no API key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTokenScan } from '../../src/scanner/tokenScanner.js';
import { createRpcClient } from '../../src/adapters/evm/rpcClient.js';
import { createLabelRegistry } from '../../src/config/labels.js';
import { buildConfig } from '../../src/config/env.js';
import { buildAiFacts } from '../../src/ai/prompts.js';
import { runAiAnalysis, assembleAnalysis } from '../../src/ai/aiEngine.js';
import { buildReport } from '../../src/reports/reportBuilder.js';
import { AnalysisReportSchema } from '../../src/ai/schema.js';
import { NetworkMismatchError, InputError, RpcError, CancelledError } from '../../src/utils/errors.js';
import { toJson } from '../../src/utils/format.js';
import { SCAN_STAGES } from '../../src/scanner/stages.js';
import { buildPonsScenario, ADDR, synthetic } from '../fixtures/ponsScenario.js';
import { createMockChain, A } from '../helpers/mockChain.js';

const SECRET_RPC = 'https://mock-rpc.invalid/v2/SECRETKEY123456';
const config = buildConfig({ ROBINHOOD_CHAIN_RPC: SECRET_RPC, ROBINHOOD_CHAIN_ID: '4663', GROQ_API_KEY: 'gsk_SYNTHETICKEYSHOULDNEVERLEAK000' });
const lc = (a) => a.toLowerCase();

async function scan(opts = {}) {
  const { chain, explorer } = buildPonsScenario(opts.scenario);
  const stages = [];
  const result = await runTokenScan({
    address: opts.address ?? ADDR.T,
    config: opts.config ?? config,
    rpc: createRpcClient(chain.transport, { minIntervalMs: 0, sleepFn: async () => {} }),
    explorer: opts.noExplorer ? null : explorer,
    labels: createLabelRegistry(),
    onStage: (id, status) => stages.push([id, status]),
    signal: opts.signal,
  });
  return { result, stages };
}

test('fixture is marked synthetic', () => {
  assert.equal(synthetic, true);
});

test('full scan: origin, trades, holders, clusters, score, report', async () => {
  const { result: r, stages } = await scan();

  // Progress follows the real stages, in order, all finished.
  const doneIds = stages.filter(([, s]) => s !== 'start').map(([id]) => id);
  assert.deepEqual(doneIds, SCAN_STAGES.map((s) => s.id));

  assert.equal(r.origin.status, 'VERIFIED');
  assert.equal(r.origin.method, 'PONS_TOKEN_LAUNCHED');
  assert.equal(lc(r.origin.creator), lc(ADDR.D));
  assert.equal(lc(r.origin.launch.curve), lc(ADDR.CV));

  // Buys are attributed to wallets, not routers.
  assert.equal(r.early.trades.length, 6);
  assert.ok(r.early.trades.every((t) => t.side === 'BUY' && lc(t.trader) !== lc(ADDR.ROUTER)));

  // Holders complete & matching balanceOf.
  assert.equal(r.holders.status, 'COMPLETE');
  assert.equal(r.holders.mismatches.length, 0);
  const curveHolder = r.holders.distribution.holders.find((h) => lc(h.address) === lc(ADDR.CV));
  assert.equal(curveHolder.category, 'CURVE');

  // Cluster: D + B1 + B2 + funder F; exchange EX excluded; B3/B4/B5 are not part of the funding cluster.
  const fundingCluster = r.clusters.clusters.find((c) => c.basis === 'FUNDING_AND_TRANSFERS');
  assert.ok(fundingCluster, 'funding-based cluster found');
  const members = fundingCluster.wallets.map((w) => lc(w.address));
  for (const a of [ADDR.D, ADDR.B1, ADDR.B2, ADDR.F]) assert.ok(members.includes(lc(a)), `member: ${a}`);
  for (const a of [ADDR.EX, ADDR.B3, ADDR.B4, ADDR.B5]) assert.ok(!members.includes(lc(a)), `not a member: ${a}`);
  assert.equal(fundingCluster.label, 'STRONG_CORRELATION');
  assert.ok(fundingCluster.containsDeployer);
  assert.ok(r.clusters.excludedFunders.some((f) => lc(f.address) === lc(ADDR.EX)));

  // Cluster supply = D 60M + B1 20M + B2 30M = 110M of 1B = 11%.
  assert.equal(r.clusters.summary.estimatedClusterSupplyPct, 11);

  // Score is deterministic & repeatable.
  assert.equal(typeof r.risk.score, 'number');
  const again = await scan();
  assert.equal(again.result.risk.score, r.risk.score);

  // Report: AI fallback, valid schema, no secrets.
  const facts = buildAiFacts(r);
  const ai = await runAiAnalysis(facts, buildConfig({}));
  const analysis = assembleAnalysis(r, facts, ai);
  assert.ok(AnalysisReportSchema.safeParse(analysis).success);
  const report = buildReport(r, analysis);
  const text = toJson(report);
  assert.ok(!text.includes('SECRETKEY123456'), 'private RPC URL does not leak');
  assert.ok(!text.includes('gsk_SYNTHETIC'), 'API key does not leak');
  assert.ok(report.fundingGraph.edges.every((e) => /^0x[0-9a-f]{64}$/i.test(e.txHash)), 'every edge has a tx hash');
  assert.equal(report.network.chainId, 4663);
  assert.ok(report.app.version);
});

test('without explorer: funding PARTIAL, token links still detected, limitations stated', async () => {
  const { result: r } = await scan({ noExplorer: true });
  assert.equal(r.funding.coverage.nativeFunding, 'NONE');
  assert.ok(r.limitations.some((l) => /BLOCK_EXPLORER_API_KEY/.test(l)));
  const c = r.clusters.clusters.find((x) => x.basis === 'FUNDING_AND_TRANSFERS');
  assert.ok(c && c.wallets.some((w) => lc(w.address) === lc(ADDR.B1)) && c.containsDeployer, 'transfer B1→D is still observed from logs');
  assert.ok(!c.wallets.some((w) => lc(w.address) === lc(ADDR.F)), 'ETH funder is not visible without the explorer');
  assert.equal(r.risk.components.fundingCorrelation.status, 'partial');
  assert.notEqual(r.risk.confidence, 'HIGH');
});

test('network mismatch → stops with NetworkMismatchError', async () => {
  await assert.rejects(scan({ scenario: { chainId: 1 } }), NetworkMismatchError);
});

test('invalid input address → InputError', async () => {
  await assert.rejects(scan({ address: '0x1234' }), InputError);
});

test('address is not a contract → InputError', async () => {
  await assert.rejects(scan({ address: A(0x123456) }), /is not a contract/);
});

test('contract is not an ERC-20 token → InputError', async () => {
  await assert.rejects(scan({ address: ADDR.ROUTER }), /ERC-20/);
});

test('RPC timeout → RpcError after bounded retries', async () => {
  const chain = createMockChain();
  chain.failMethod('eth_blockNumber');
  await assert.rejects(
    runTokenScan({ address: ADDR.T, config, rpc: createRpcClient(chain.transport, { retries: 1, sleepFn: async () => {}, minIntervalMs: 0 }), labels: createLabelRegistry() }),
    RpcError,
  );
});

test('token with mint + active owner → contract findings & higher contract score', async () => {
  const { result: r } = await scan({ scenario: { withOwnerMint: true } });
  assert.equal(r.contract.ownerStatus, 'ACTIVE');
  assert.ok(r.contract.findings.some((f) => f.id === 'MINT'));
  assert.ok(r.risk.components.contractPrivileges.score >= 40);
});

test('incomplete holder data (deadline) → PARTIAL, not a definitive claim', async () => {
  const { result: r } = await scan({ config: { ...config, holderScanMaxSeconds: -1 } });
  assert.equal(r.holders.status, 'PARTIAL');
  assert.equal(r.holders.distribution.sampleMode, true, 'distribution from a balanceOf sample');
  assert.equal(r.holders.distribution.holderCount, null, 'total holder count is not claimed');
  assert.ok(r.limitations.some((l) => /berhenti|parsial|PARTIAL/i.test(l)));
  assert.notEqual(r.risk.components.holderConcentration.status, 'assessed');
});

test('AI returns invalid data in the full flow → fallback, report stays valid', async () => {
  const { result: r } = await scan();
  const facts = buildAiFacts(r);
  const provider = { name: 'mock', model: 'mock', generate: async () => `{"summary":"Score 99/100, wallet ${A(0xdead99)} definitely belongs to the dev.","risk_factors":[],"positive_signals":[],"false_positive_notes":[],"limitations":[]}` };
  const ai = await runAiAnalysis(facts, config, { provider });
  assert.equal(ai.source, 'fallback');
  const analysis = assembleAnalysis(r, facts, ai);
  assert.equal(analysis.dev_risk_score, r.risk.score);
  assert.ok(!analysis.summary.includes('99/100'));
});

test('cancellation (AbortSignal) → CancelledError', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(scan({ signal: ac.signal }), CancelledError);
});
