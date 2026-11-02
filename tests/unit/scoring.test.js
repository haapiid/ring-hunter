import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRiskScore, validateWeights, riskBand, verdictFor, scoreComponents } from '../../src/scoring/riskScoring.js';
import { SCORING_WEIGHTS } from '../../src/config/analysis.js';

const full = {
  originStatus: 'VERIFIED',
  earlyTraderCount: 10,
  earlyComplete: true,
  tradersInFundingClusters: 6,
  tradersInAnyGroup: 8,
  strongClusterCount: 1,
  deployerLinkedToTraders: true,
  fundingCoverage: 'COMPLETE_FOR_TARGETS',
  holderStatus: 'COMPLETE',
  clusterSupplyPct: 35,
  developerSupplyPct: 10,
  top10WalletPct: 70,
  contractScore: 60,
  contractReasons: ['Mint function [STATIC]'],
  liquidityVenue: 'NONE',
};

const clean = {
  ...full,
  tradersInFundingClusters: 0,
  tradersInAnyGroup: 0,
  strongClusterCount: 0,
  deployerLinkedToTraders: false,
  clusterSupplyPct: 0,
  developerSupplyPct: 1,
  top10WalletPct: 12,
  contractScore: 0,
  contractReasons: [],
  liquidityVenue: 'PONS',
};

test('weights sum to 100 & validation rejects wrong weights', () => {
  assert.ok(validateWeights(SCORING_WEIGHTS));
  assert.throws(() => validateWeights({ a: 50, b: 40 }));
});

test('deterministic score: same input → same output', () => {
  assert.deepEqual(computeRiskScore(full), computeRiskScore(full));
});

test('high-risk fixture → HIGH_OBSERVED_RISK', () => {
  const r = computeRiskScore(full);
  assert.ok(r.score >= 70, `score ${r.score}`);
  assert.equal(r.level, 'HIGH_OBSERVED_RISK');
  assert.equal(r.coverage, 1);
  assert.equal(r.confidence, 'HIGH');
  assert.equal(verdictFor(r), 'HIGH_OBSERVED_RISK_AVOID_OR_VERIFY');
});

test('clean fixture → LOWER_OBSERVED_RISK, verdict still DYOR (not SAFE)', () => {
  const r = computeRiskScore(clean);
  assert.ok(r.score < 40, `score ${r.score}`);
  assert.equal(verdictFor(r), 'LOWER_OBSERVED_RISK_STILL_DYOR');
  assert.ok(!JSON.stringify(r).includes('SAFE'));
});

test('missing data is NOT treated as safe: component excluded, coverage drops', () => {
  const partial = { ...full, fundingCoverage: 'NONE_AT_ALL', clusterSupplyPct: null, top10WalletPct: null, developerSupplyPct: null, holderStatus: 'UNAVAILABLE' };
  const r = computeRiskScore(partial);
  assert.equal(r.components.fundingCorrelation.score, null);
  assert.equal(r.components.clusterSupply.score, null);
  assert.equal(r.components.holderConcentration.score, null);
  assert.ok(r.coverage < 0.6);
  // The remaining components are high-risk; the score does not drop just because data is missing.
  assert.ok(r.score >= 50, `score ${r.score}`);
});

test('low coverage → displayLevel INSUFFICIENT_DATA', () => {
  const r = computeRiskScore({ ...full, fundingCoverage: 'NONE_AT_ALL', clusterSupplyPct: null, top10WalletPct: null, earlyTraderCount: 0, liquidityVenue: null });
  assert.equal(r.displayLevel, 'INSUFFICIENT_DATA');
  assert.equal(verdictFor(r), 'INSUFFICIENT_DATA');
});

test('no components at all → null score', () => {
  const r = computeRiskScore({ earlyTraderCount: 0, fundingCoverage: 'NONE_AT_ALL', clusterSupplyPct: null, top10WalletPct: null, contractScore: null, liquidityVenue: null });
  assert.equal(r.score, null);
  assert.equal(r.displayLevel, 'INSUFFICIENT_DATA');
});

test('partial status counts as half in coverage', () => {
  const r = computeRiskScore({ ...full, fundingCoverage: 'NONE', holderStatus: 'PARTIAL' });
  assert.equal(r.components.fundingCorrelation.status, 'partial');
  assert.ok(r.coverage < 1 && r.coverage > 0.5);
});

test('riskBand boundaries 40/70', () => {
  assert.equal(riskBand(39).level, 'LOWER_OBSERVED_RISK');
  assert.equal(riskBand(40).level, 'MODERATE_RISK');
  assert.equal(riskBand(69).level, 'MODERATE_RISK');
  assert.equal(riskBand(70).level, 'HIGH_OBSERVED_RISK');
});

test('components clamped to 0..100', () => {
  const c = scoreComponents({ ...full, clusterSupplyPct: 500, top10WalletPct: 100, contractScore: 999 });
  for (const v of Object.values(c)) if (v.score != null) assert.ok(v.score >= 0 && v.score <= 100);
});
