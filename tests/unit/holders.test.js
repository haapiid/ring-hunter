// Synthetic data: fake 0x…a/b/c addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBalances, computeDistribution } from '../../src/scanner/holderAnalysis.js';
import { createLabelRegistry } from '../../src/config/labels.js';
import { A } from '../helpers/mockChain.js';

const ZERO = A(0);
const t = (from, to, value) => ({ from, to, value: BigInt(value) });

test('computeBalances: mint, transfer, burn', () => {
  const r = computeBalances([t(ZERO, A(1), 1000), t(A(1), A(2), 300), t(A(2), ZERO, 100)]);
  assert.equal(r.minted, 1000n);
  assert.equal(r.burnedToZero, 100n);
  assert.equal(r.balances.get(A(1)), 700n);
  assert.equal(r.balances.get(A(2)), 200n);
  assert.equal(r.balances.has(ZERO), false);
  assert.deepEqual(r.negative, []);
});

test('computeBalances: negative balance flags incomplete data', () => {
  const r = computeBalances([t(A(1), A(2), 50)]);
  assert.deepEqual(r.negative, [A(1)]);
});

test('computeDistribution: concentrated supply, LP/burn/contracts separated', () => {
  const labels = createLabelRegistry();
  const curve = A(0xc);
  const balances = new Map([
    [A(1), 600n],
    [A(2), 100n],
    [curve, 200n],
    ['0x000000000000000000000000000000000000dead', 50n],
    [A(0xcc), 50n],
  ]);
  const extra = new Map([[curve, { label: 'curve', kind: 'CURVE' }]]);
  const d = computeDistribution({ balances, totalSupply: 1000n, labels, contracts: new Set([A(0xcc)]), extraLabels: extra });
  assert.equal(d.holderCount, 5);
  assert.equal(d.walletHolderCount, 2);
  assert.equal(d.top10WalletPct, 70);
  assert.equal(d.largestWalletPct, 60);
  assert.equal(d.lpAndCurvePct, 20);
  assert.equal(d.burnPct, 5);
  assert.equal(d.unlabeledContractPct, 5);
  assert.equal(d.holders[0].address.toLowerCase(), A(1));
});
