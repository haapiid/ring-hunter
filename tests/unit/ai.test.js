// Synthetic data. Tests AI output validation, anti-hallucination, and fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLoose, guardNarrative, runAiAnalysis, assembleAnalysis } from '../../src/ai/aiEngine.js';
import { AiNarrativeSchema } from '../../src/ai/schema.js';
import { buildFallbackNarrative } from '../../src/ai/fallbackAnalysis.js';
import { buildUserPrompt } from '../../src/ai/prompts.js';
import { buildConfig } from '../../src/config/env.js';
import { AiError } from '../../src/utils/errors.js';
import { A, H } from '../helpers/mockChain.js';

const facts = {
  token: { name: 'Synthetic', symbol: 'SYN', address: A(0xa1) },
  network: 'Robinhood Chain (chain ID 4663)',
  engine_score: { dev_risk_score: 62, risk_level: 'MODERATE_RISK', data_coverage_pct: 70, confidence: 'MEDIUM', verdict: 'BE_CAUTIOUS', components: { fundingCorrelation: { score: 80, status: 'partial', weight: 25, reasons: ['3/5 early buyers are in a cluster.'] } } },
  origin: { status: 'VERIFIED', method: 'PONS_TOKEN_LAUNCHED', creator: A(0xd1), launched_via_pons: true },
  early_activity: { trades: 5, traders: 5, buys: 5, sells: 0 },
  holders: { status: 'COMPLETE', holder_count: 12, top10_wallet_pct: 41.5 },
  clusters: [{ id: 'C1', label: 'POSSIBLE_CLUSTER', confidence: 'LOW', basis: 'FUNDING_AND_TRANSFERS', wallet_count: 3, indicators: ['SHARED_FUNDER'], supply_pct: 18.25, sample_tx: [H(0x55)] }],
  cluster_summary: { meaningful_clusters: 1, wallets_in_meaningful_clusters: 3, estimated_cluster_associated_supply_pct: 18.25, estimated_developer_associated_supply_pct: 4, excluded_service_funders: 0 },
  contract: { owner_status: 'RENOUNCED', proxy: null, findings: [], positives: ['owner() = 0x0'] },
  funding_coverage: 'NONE',
  limitations: ['Native ETH funding not observed.'],
};

const goodNarrative = {
  summary: `Token SYN has a score of 62/100 with one correlated cluster holding about 18.25% of supply. Deployer ${A(0xd1)} verified.`,
  risk_factors: ['One cluster based on a shared funding source (POSSIBLE_CLUSTER).'],
  positive_signals: ['owner() is already renounced.'],
  false_positive_notes: ['A shared funding source may be an exchange.'],
  limitations: ['Native ETH funding not observed.'],
};

const cfg = buildConfig({});

test('parseJsonLoose: handles markdown fences & surrounding text', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here: {"a":2} done'), { a: 2 });
  assert.throws(() => parseJsonLoose(''), AiError);
  assert.throws(() => parseJsonLoose('no json here'), AiError);
  assert.throws(() => parseJsonLoose('{rusak'), AiError);
});

test('narrative schema: required fields & strict', () => {
  assert.ok(AiNarrativeSchema.safeParse(goodNarrative).success);
  assert.ok(!AiNarrativeSchema.safeParse({ summary: 'pendek' }).success);
  assert.ok(!AiNarrativeSchema.safeParse({ ...goodNarrative, dev_risk_score: 99 }).success, 'extra field rejected');
});

test('guard: valid narrative passes', () => {
  assert.equal(guardNarrative(goodNarrative, facts), null);
});

test('guard: made-up address rejected', () => {
  const bad = { ...goodNarrative, summary: goodNarrative.summary + ` Wallet ${A(0x999999)} terlibat.` };
  assert.match(guardNarrative(bad, facts), /address/);
});

test('guard: made-up tx hash rejected', () => {
  const bad = { ...goodNarrative, risk_factors: [`Bukti tx ${H(0xbad)}`] };
  assert.match(guardNarrative(bad, facts), /hash/);
});

test('guard: made-up score rejected', () => {
  const bad = { ...goodNarrative, summary: 'This token gets a score of 91/100 according to our in-depth analysis.' };
  assert.match(guardNarrative(bad, facts), /score/);
});

test('guard: made-up percentage rejected', () => {
  const bad = { ...goodNarrative, summary: 'The cluster holds 73.4% of supply, very dangerous and should be avoided.' };
  assert.match(guardNarrative(bad, facts), /percentage/);
});

test('runAiAnalysis: AI_PROVIDER=none → local fallback', async () => {
  const r = await runAiAnalysis(facts, cfg);
  assert.equal(r.source, 'fallback');
  assert.match(r.fallbackReason, /none/);
  assert.ok(AiNarrativeSchema.safeParse(r.narrative).success);
});

test('runAiAnalysis: valid response accepted', async () => {
  const provider = { name: 'mock', model: 'mock-1', generate: async () => JSON.stringify(goodNarrative) };
  const r = await runAiAnalysis(facts, cfg, { provider });
  assert.equal(r.source, 'ai');
  assert.equal(r.attempts, 1);
});

test('runAiAnalysis: invalid response repaired once', async () => {
  let n = 0;
  const provider = { name: 'mock', model: 'm', generate: async () => (++n === 1 ? 'this is not json' : JSON.stringify(goodNarrative)) };
  const r = await runAiAnalysis(facts, cfg, { provider });
  assert.equal(r.source, 'ai');
  assert.equal(r.attempts, 2);
});

test('runAiAnalysis: still invalid → fallback (max 2 attempts)', async () => {
  let n = 0;
  const provider = { name: 'mock', model: 'm', generate: async () => (n++, '{"summary":"x"}') };
  const r = await runAiAnalysis(facts, cfg, { provider });
  assert.equal(r.source, 'fallback');
  assert.equal(n, 2);
  assert.match(r.fallbackReason, /Invalid AI response/);
});

test('runAiAnalysis: provider failure (quota/timeout) → fallback without a retry prompt', async () => {
  let n = 0;
  const provider = {
    name: 'mock',
    model: 'm',
    generate: async () => {
      n++;
      throw new AiError('mock: quota/rate limit reached');
    },
  };
  const r = await runAiAnalysis(facts, cfg, { provider });
  assert.equal(r.source, 'fallback');
  assert.equal(n, 1);
  assert.match(r.fallbackReason, /quota/);
});

test('prompt contains no secrets & is size-limited', () => {
  const p = buildUserPrompt({ ...facts, clusters: Array.from({ length: 400 }, () => facts.clusters[0]) });
  assert.ok(p.length < 16_000);
  assert.ok(!/apikey|GEMINI_API_KEY|GROQ_API_KEY/i.test(p));
});

test('fallback narrative is consistent with engine numbers', () => {
  const n = buildFallbackNarrative(facts);
  assert.match(n.summary, /62\/100/);
  assert.equal(guardNarrative(n, facts), null);
});

test('assembleAnalysis: numbers always come from the engine, not the LLM', () => {
  const scan = {
    risk: { score: 62, displayLevel: 'MODERATE_RISK', confidence: 'MEDIUM', coverage: 0.7 },
    clusters: { summary: { meaningfulCount: 1, meaningfulWalletCount: 3, strongest: 'POSSIBLE_CLUSTER', estimatedClusterSupplyPct: 18.25, estimatedDeveloperSupplyPct: 120 }, clusters: [{ id: 'C1', label: 'POSSIBLE_CLUSTER', evidence: [{ txHash: H(0x55), relation: 'NATIVE_FUNDING' }] }] },
    origin: { deployTxHash: H(0x1), method: 'PONS_TOKEN_LAUNCHED' },
    limitations: ['x'],
    verdict: 'BE_CAUTIOUS',
  };
  const a = assembleAnalysis(scan, facts, { source: 'ai', provider: 'mock', model: 'm', narrative: goodNarrative });
  assert.equal(a.dev_risk_score, 62);
  assert.equal(a.estimated_cluster_associated_supply_pct, 18.25);
  assert.equal(a.estimated_developer_associated_supply_pct, 100, 'capped at 100');
  assert.equal(a.verdict, 'BE_CAUTIOUS');
  assert.equal(a.evidence[0].txHash, H(0x1));
});
