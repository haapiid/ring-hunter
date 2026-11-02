// Builds the re-auditable JSON report. Contains no API keys / full RPC URLs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { redact } from '../utils/redact.js';

const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'));
export const APP_VERSION = pkg.version;
export const REPORT_SCHEMA_VERSION = 1;

const MAX_EDGES = 500;
const MAX_HOLDERS = 50;

/** Recursively convert bigint → string, Set → array, Map → object. */
export function serializable(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Set) return [...value].map(serializable);
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [k, serializable(v)]));
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializable(v)]));
  return value;
}

/**
 * @param {object} scan result of runTokenScan
 * @param {object} analysis result of assembleAnalysis
 */
export function buildReport(scan, analysis) {
  const dist = scan.holders.distribution;
  const edges = scan.funding.graph.edges;
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    app: { name: 'RING-HUNTER AI', version: APP_VERSION },
    analyzedAt: new Date(scan.meta.finishedAt).toISOString(),
    durationMs: scan.meta.finishedAt - scan.meta.startedAt,
    network: scan.network,
    source: {
      rpc: redact(scan.meta.rpcLabel ?? ''),
      explorer: scan.meta.explorer,
      latestBlock: scan.meta.latestBlock,
      holderBlockRange: scan.holders.scannedRange ?? null,
      rpcStats: scan.meta.rpcStats,
    },
    token: scan.token,
    origin: { ...scan.origin, notes: scan.origin.notes },
    pools: scan.pools,
    poolSelection: scan.poolSelection,
    earlyActivity: { coverage: scan.early.coverage, activities: scan.early.activities, traders: scan.early.buyers },
    holders: {
      status: scan.holders.status,
      reason: scan.holders.reason ?? null,
      transferCount: scan.holders.transferCount ?? 0,
      notes: scan.holders.notes ?? [],
      mismatches: scan.holders.mismatches ?? [],
      summary: dist ? { sampleMode: !!dist.sampleMode, sampleSize: scan.holders.sampleSize ?? null, observedAddressCount: dist.observedAddressCount ?? null, holderCount: dist.holderCount, walletHolderCount: dist.walletHolderCount, top10WalletPct: dist.top10WalletPct, largestWalletPct: dist.largestWalletPct, lpAndCurvePct: dist.lpAndCurvePct, burnPct: dist.burnPct, infraPct: dist.infraPct, unlabeledContractPct: dist.unlabeledContractPct } : null,
      topHolders: dist ? dist.holders.slice(0, MAX_HOLDERS) : [],
    },
    fundingGraph: {
      coverage: scan.funding.coverage,
      nodeCount: scan.funding.graph.nodes.size,
      edgeCount: edges.length,
      edgesTruncated: edges.length > MAX_EDGES,
      nodes: [...scan.funding.graph.nodes.values()].slice(0, MAX_EDGES),
      edges: edges.slice(0, MAX_EDGES),
      funderProfiles: [...scan.funding.funderProfiles.values()],
    },
    clusters: scan.clusters,
    contract: scan.contract,
    scoring: scan.risk,
    scoringFacts: scan.facts,
    analysis,
    limitations: scan.limitations,
    disclaimer:
      'RING-HUNTER AI is a heuristic analysis aid based on on-chain data. Its results are not a formal security audit, not proof of wallet identity/ownership, not a definitive rug-pull prediction, and not financial advice.',
  };
  return serializable(report);
}
