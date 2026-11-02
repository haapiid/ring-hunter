import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveReport, listReports, loadReport, deleteReport } from '../../src/reports/exportJson.js';
import { serializable } from '../../src/reports/reportBuilder.js';
import { renderSummaryTable } from '../../src/cli/reportTable.js';
import { InputError } from '../../src/utils/errors.js';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const sampleReport = () => ({
  token: { name: 'Synthetic', symbol: 'SYN', address: '0x00000000000000000000000000000000000a0001', decimals: 18 },
  network: { name: 'Robinhood Chain', chainId: 4663, explorerUrl: 'https://robinhoodchain.blockscout.com' },
  origin: { status: 'VERIFIED', method: 'PONS_TOKEN_LAUNCHED', creator: '0x00000000000000000000000000000000000d0001' },
  scoring: { score: 72, level: 'HIGH_OBSERVED_RISK', displayLevel: 'HIGH_OBSERVED_RISK', coverage: 0.8, confidence: 'MEDIUM' },
  clusters: { summary: { meaningfulCount: 1, meaningfulWalletCount: 4, total: 2, estimatedClusterSupplyPct: 12.5, estimatedDeveloperSupplyPct: 6 }, clusters: [] },
  holders: { status: 'COMPLETE' },
  fundingGraph: { coverage: { nativeFunding: 'COMPLETE_FOR_TARGETS' } },
  analyzedAt: '2026-10-27T00:00:00.000Z',
});

test('serializable: bigint/Set/Map are JSON-safe', () => {
  const s = serializable({ a: 1n, b: new Set([2n]), c: new Map([['k', 3n]]) });
  assert.deepEqual(s, { a: '1', b: ['2'], c: { k: '3' } });
});

test('saveReport: unique names, never overwrites old reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rh-'));
  try {
    const now = new Date('2026-10-27T01:02:03.000Z');
    const f1 = saveReport(sampleReport(), dir, now);
    const f2 = saveReport(sampleReport(), dir, now);
    assert.notEqual(f1, f2);
    assert.equal(readdirSync(dir).length, 2);
    const list = listReports(dir);
    assert.equal(list.length, 2);
    assert.equal(list[0].score, 72);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteReport: requires explicit confirmation; loadReport is safe from path traversal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rh-'));
  try {
    const f = saveReport(sampleReport(), dir);
    assert.throws(() => deleteReport(f, {}, dir), InputError);
    writeFileSync(join(dir, 'x.json'), '{"ok":true}');
    assert.deepEqual(loadReport('../../x.json', dir), { ok: true }, 'basename is used, never leaves the folder');
    deleteReport(f, { confirmed: true }, dir);
    assert.equal(listReports(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderSummaryTable: contains required fields & width ≤ 100 columns', () => {
  const out = stripAnsi(renderSummaryTable(sampleReport()));
  for (const k of ['Token', 'Contract', 'Network', 'Creator', 'DEV RISK SCORE', 'Risk Level', 'Cluster Count', 'Related Wallets', 'Est. Cluster Supply', 'Confidence', 'Data Coverage']) assert.ok(out.includes(k), k);
  assert.ok(out.includes('HIGH OBSERVED RISK'), 'level is written as text, not only color');
  assert.ok(out.includes('ESTIMATED CLUSTER-ASSOCIATED'));
  for (const line of out.split('\n')) assert.ok(line.length <= 100, `baris terlalu lebar (${line.length})`);
});

test('renderSummaryTable: null score & INSUFFICIENT DATA shown honestly', () => {
  const r = sampleReport();
  r.scoring = { score: null, level: 'INSUFFICIENT_DATA', displayLevel: 'INSUFFICIENT_DATA', coverage: 0.1, confidence: 'LOW' };
  r.clusters.summary.estimatedClusterSupplyPct = null;
  const out = stripAnsi(renderSummaryTable(r));
  assert.ok(out.includes('cannot be computed'));
  assert.ok(out.includes('INSUFFICIENT DATA'));
  assert.ok(out.includes('not available'));
});
