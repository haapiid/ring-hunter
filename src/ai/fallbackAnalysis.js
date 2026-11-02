// Local analysis without an LLM: a template narrative built directly from the engine facts.
// Used when AI_PROVIDER=none, the provider fails, or the AI response is invalid.

const LEVEL_TEXT = {
  HIGH_OBSERVED_RISK: 'high',
  MODERATE_RISK: 'moderate',
  LOWER_OBSERVED_RISK: 'lower',
  INSUFFICIENT_DATA: 'not yet determinable (insufficient data)',
};

/** @returns {{summary:string, risk_factors:string[], positive_signals:string[], false_positive_notes:string[], limitations:string[]}} */
export function buildFallbackNarrative(facts) {
  const s = facts.engine_score;
  const cs = facts.cluster_summary;
  const name = facts.token.symbol || facts.token.name || facts.token.address;
  const parts = [];
  parts.push(
    s.dev_risk_score == null
      ? `The risk score for ${name} could not be computed because the data is insufficient.`
      : `The deterministic engine gave ${name} a score of ${s.dev_risk_score}/100 with a ${LEVEL_TEXT[s.risk_level] ?? s.risk_level} observed risk level; data coverage ${s.data_coverage_pct}% and confidence ${s.confidence}.`,
  );
  if (facts.origin.creator) parts.push(`Creator ${facts.origin.status === 'VERIFIED' ? 'verified' : 'indicated'} via ${facts.origin.method}.`);
  else parts.push('The token creator could not be proven from the available data.');
  if (cs.meaningful_clusters > 0) {
    parts.push(
      `Detected ${cs.meaningful_clusters} correlated cluster(s) (≥ POSSIBLE_CLUSTER) with ${cs.wallets_in_meaningful_clusters} wallet(s)` +
        (cs.estimated_cluster_associated_supply_pct != null ? `, estimated cluster-associated supply ${cs.estimated_cluster_associated_supply_pct}%.` : '.'),
    );
  } else {
    parts.push('No strongly correlated clusters were observed in the available data.');
  }
  parts.push('On-chain correlation is not proof of shared ownership.');

  const risk_factors = [];
  for (const [key, c] of Object.entries(s.components)) {
    if (c.score != null && c.score >= 40) risk_factors.push(`${COMPONENT_NAMES[key] ?? key}: ${c.score}/100 — ${c.reasons[0] ?? ''}`.trim());
  }
  for (const f of facts.contract.findings.slice(0, 5)) risk_factors.push(`Contract: ${f}`);

  const positive_signals = [...facts.contract.positives];
  for (const [key, c] of Object.entries(s.components)) {
    if (c.score != null && c.score < 20 && c.status === 'assessed') positive_signals.push(`${COMPONENT_NAMES[key] ?? key} is low (${c.score}/100).`);
  }

  const false_positive_notes = [
    'A shared funding source may be an exchange, bridge, or public service that is not yet labeled.',
    'Buys in nearby blocks can be caused by public bots or the same announcement.',
  ];
  if (cs.excluded_service_funders > 0) false_positive_notes.push(`${cs.excluded_service_funders} funder(s) suspected to be public services were excluded from grouping.`);

  const limitations = facts.limitations.length ? [...facts.limitations] : ['No specific limitations were recorded.'];
  return { summary: parts.join(' '), risk_factors, positive_signals, false_positive_notes, limitations };
}

export const COMPONENT_NAMES = {
  fundingCorrelation: 'Funding correlation',
  clusterSupply: 'Cluster-linked supply',
  earlyCoordination: 'Early-buyer coordination',
  contractPrivileges: 'Contract privileges',
  liquidity: 'Liquidity risk',
  holderConcentration: 'Holder concentration',
};
