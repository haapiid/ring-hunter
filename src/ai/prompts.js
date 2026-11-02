// LLM input builder: normalized facts only, size-limited, no secrets/RPC URLs.
import { toJson } from '../utils/format.js';

const MAX_PROMPT_CHARS = 14_000;

/** Condense the scan result into facts for the LLM (pure function). */
export function buildAiFacts(scan) {
  const comp = Object.fromEntries(Object.entries(scan.risk.components).map(([k, c]) => [k, { score: c.score, status: c.status, weight: c.weight, reasons: c.reasons.slice(0, 3) }]));
  const dist = scan.holders.distribution;
  return {
    token: { name: scan.token.name, symbol: scan.token.symbol, address: scan.token.address },
    network: `${scan.network.name} (chain ID ${scan.network.chainId})`,
    engine_score: {
      dev_risk_score: scan.risk.score,
      risk_level: scan.risk.displayLevel,
      data_coverage_pct: Math.round(scan.risk.coverage * 100),
      confidence: scan.risk.confidence,
      components: comp,
      verdict: scan.verdict,
    },
    origin: { status: scan.origin.status, method: scan.origin.method, creator: scan.origin.creator, launched_via_pons: !!scan.origin.launch },
    early_activity: { trades: scan.early.trades.length, traders: scan.early.buyers.length, buys: scan.early.trades.filter((t) => t.side === 'BUY').length, sells: scan.early.trades.filter((t) => t.side === 'SELL').length },
    holders: dist ? { status: scan.holders.status, holder_count: dist.holderCount, top10_wallet_pct: round2(dist.top10WalletPct), lp_and_curve_pct: round2(dist.lpAndCurvePct), burn_pct: round2(dist.burnPct) } : { status: scan.holders.status },
    clusters: scan.clusters.clusters.slice(0, 6).map((c) => ({
      id: c.id,
      label: c.label,
      confidence: c.confidence,
      basis: c.basis,
      wallet_count: c.wallets.length,
      indicators: c.indicators.map((i) => i.id),
      supply_pct: round2(c.supply?.pct),
      sample_tx: c.evidence.slice(0, 2).map((e) => e.txHash),
    })),
    cluster_summary: {
      meaningful_clusters: scan.clusters.summary.meaningfulCount,
      wallets_in_meaningful_clusters: scan.clusters.summary.meaningfulWalletCount,
      estimated_cluster_associated_supply_pct: round2(scan.clusters.summary.estimatedClusterSupplyPct),
      estimated_developer_associated_supply_pct: round2(scan.clusters.summary.estimatedDeveloperSupplyPct),
      excluded_service_funders: scan.clusters.excludedFunders.length,
    },
    contract: { owner_status: scan.contract.ownerStatus, proxy: scan.contract.proxy?.type ?? null, findings: scan.contract.findings.slice(0, 8).map((f) => `${f.title} [${f.level}]`), positives: scan.contract.positives },
    funding_coverage: scan.funding.coverage.nativeFunding,
    limitations: scan.limitations.slice(0, 10),
  };
}

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

export const SYSTEM_PROMPT = `You are an on-chain risk analyst for RING-HUNTER AI. Write in English.
Mandatory rules:
- Use ONLY the facts in the input JSON. Do not add addresses, transaction hashes, numbers, scores, or percentages that are not in the input.
- Scores and percentages are already computed by the deterministic engine; do not change or recompute them.
- Wallet correlation is NOT proof of shared ownership. Use words like "correlated", "indicated", "observed". Never say a wallet "definitely belongs to" someone.
- Do not call this analysis a formal security audit, and do not state that the token is safe or a certain rug pull.
- Explain possible false positives and where data is insufficient.
Reply with ONLY one JSON object (no markdown) with exactly these fields:
{"summary": string, "risk_factors": string[], "positive_signals": string[], "false_positive_notes": string[], "limitations": string[]}`;

/** User prompt with a size limit. If too large, the cluster section is trimmed. */
export function buildUserPrompt(facts) {
  let f = facts;
  let text = toJson(f, 0);
  while (text.length > MAX_PROMPT_CHARS && f.clusters.length > 1) {
    f = { ...f, clusters: f.clusters.slice(0, Math.max(1, Math.floor(f.clusters.length / 2))) };
    text = toJson(f, 0);
  }
  if (text.length > MAX_PROMPT_CHARS) text = text.slice(0, MAX_PROMPT_CHARS);
  return `Scan facts (JSON):\n${text}\n\nWrite a risk summary based on the facts above.`;
}

export function buildRepairPrompt(previousError) {
  return `The previous response was rejected because: ${previousError}. Resend ONLY a valid JSON object in the required format, without adding addresses/hashes/numbers that are not in the input.`;
}
