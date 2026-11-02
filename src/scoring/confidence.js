// Analysis confidence level: separate from the score. Confidence drops when data is partial or key sources are missing.

/**
 * @param {{coverage:number, facts:object, components:object}} p
 * @returns {{level:'HIGH'|'MEDIUM'|'LOW', reasons:string[]}}
 */
export function computeConfidence({ coverage, facts, components }) {
  const reasons = [];
  let points = 0;
  if (coverage >= 0.8) points += 2;
  else if (coverage >= 0.5) points += 1;
  else reasons.push(`Low data coverage (${Math.round(coverage * 100)}%).`);

  if (facts.fundingCoverage === 'COMPLETE_FOR_TARGETS') points += 1;
  else reasons.push('Native-coin funding is incomplete/not observed.');

  if (facts.holderStatus === 'COMPLETE') points += 1;
  else reasons.push(`Holder data ${facts.holderStatus ?? 'unavailable'}.`);

  if (facts.originStatus === 'VERIFIED') points += 1;
  else reasons.push(`Creator ${facts.originStatus === 'INDICATIVE' ? 'only indicative' : 'unknown'}.`);

  if ((facts.earlyTraderCount ?? 0) < 5) reasons.push('Small early-buyer sample (<5).');
  else points += 1;

  const notAssessed = Object.entries(components).filter(([, c]) => c.score == null).map(([k]) => k);
  if (notAssessed.length) reasons.push(`Components not assessed: ${notAssessed.join(', ')}.`);

  let level = points >= 5 ? 'HIGH' : points >= 3 ? 'MEDIUM' : 'LOW';
  // ETH funding is the core of ring detection: without that data, confidence must not be HIGH.
  if (level === 'HIGH' && facts.fundingCoverage !== 'COMPLETE_FOR_TARGETS') {
    level = 'MEDIUM';
    reasons.push('Confidence capped at MEDIUM because native-coin funding is incomplete.');
  }
  if (!reasons.length) reasons.push('All main data sources are available.');
  return { level, reasons };
}
