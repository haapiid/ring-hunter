// DETERMINISTIC risk scoring engine (no LLM, no random numbers).
// Each component yields a score of 0..100 or null (cannot be assessed). Null components are
// excluded from the weighted average and reduce DATA COVERAGE — never treated as safe.
import { SCORING_WEIGHTS, RISK_BANDS, SCORING_POLICY } from '../config/analysis.js';
import { computeConfidence } from './confidence.js';

const clamp = (v) => Math.max(0, Math.min(100, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** Validate weights: they must sum to 100. */
export function validateWeights(weights = SCORING_WEIGHTS) {
  const sum = Object.values(weights).reduce((s, w) => s + w, 0);
  if (sum !== 100) throw new Error(`Scoring weights must total 100, currently ${sum}`);
  return true;
}

/**
 * Score components. Input is the normalized scan facts.
 * @param {object} f
 */
export function scoreComponents(f) {
  const c = {};

  // 1) Funding correlation: share of early buyers inside funding-based clusters.
  {
    const traders = f.earlyTraderCount ?? 0;
    const fundingAvailable = f.fundingCoverage && f.fundingCoverage !== 'NONE_AT_ALL';
    if (!fundingAvailable || traders === 0) {
      c.fundingCorrelation = { score: null, status: 'not_assessed', reasons: [traders === 0 ? 'No early buyers observed.' : 'No funding data.'] };
    } else {
      const share = f.tradersInFundingClusters / traders;
      let s = share * 100 * 1.25;
      if (f.strongClusterCount > 0) s += 15;
      if (f.deployerLinkedToTraders) s += 20;
      const partial = f.fundingCoverage !== 'COMPLETE_FOR_TARGETS';
      c.fundingCorrelation = {
        score: clamp(round1(s)),
        status: partial ? 'partial' : 'assessed',
        reasons: [
          `${f.tradersInFundingClusters}/${traders} early buyers are in funding/transfer-based clusters.`,
          ...(f.strongClusterCount ? [`${f.strongClusterCount} cluster STRONG_CORRELATION.`] : []),
          ...(f.deployerLinkedToTraders ? ['Deployer is linked to early buyers.'] : []),
          ...(partial ? ['Native-coin funding is not/partially observed — the score may be lower than reality.'] : []),
        ],
      };
    }
  }

  // 2) Cluster-linked supply (≥ POSSIBLE_CLUSTER) + developer-linked supply.
  {
    if (f.clusterSupplyPct == null) {
      c.clusterSupply = { score: null, status: 'not_assessed', reasons: ['Holder distribution unavailable.'] };
    } else {
      const s = Math.max((f.clusterSupplyPct / 30) * 100, ((f.developerSupplyPct ?? 0) / 20) * 100);
      c.clusterSupply = {
        score: clamp(round1(s)),
        status: f.holderStatus === 'COMPLETE' ? 'assessed' : 'partial',
        reasons: [`Estimated cluster-linked supply ${f.clusterSupplyPct.toFixed(2)}%; developer-linked ${f.developerSupplyPct != null ? f.developerSupplyPct.toFixed(2) + '%' : 'unknown'}.`],
      };
    }
  }

  // 3) Early-buyer coordination: share of early buyers in timing groups/clusters.
  {
    const traders = f.earlyTraderCount ?? 0;
    if (traders === 0) {
      c.earlyCoordination = { score: null, status: 'not_assessed', reasons: ['No early buyers observed.'] };
    } else {
      const share = f.tradersInAnyGroup / traders;
      c.earlyCoordination = {
        score: clamp(round1(share * 100)),
        status: f.earlyComplete ? 'assessed' : 'partial',
        reasons: [`${f.tradersInAnyGroup}/${traders} early buyers are in a timing group or cluster.`],
      };
    }
  }

  // 4) Contract privileges.
  c.contractPrivileges =
    f.contractScore == null
      ? { score: null, status: 'not_assessed', reasons: ['Contract analysis did not run.'] }
      : { score: clamp(f.contractScore), status: 'assessed', reasons: f.contractReasons?.length ? f.contractReasons : ['No risky privileges detected heuristically.'] };

  // 5) Liquidity: LP withdrawal rights cannot be proven without a position indexer → usually 'partial'.
  {
    if (f.liquidityVenue === 'PONS') {
      c.liquidity = { score: 25, status: 'partial', reasons: ['Liquidity is managed by Pons contracts (curve / V4 pool with the Pons hook).', 'LP withdrawal rights are not verified by RING-HUNTER.'] };
    } else if (f.liquidityVenue === 'DEX_POOL') {
      const venues = f.liquidityDexes?.length ? f.liquidityDexes.join(', ') : 'DEX';
      c.liquidity = { score: 50, status: 'partial', reasons: [`${venues} pool found; LP ownership and lock status are not traced by RING-HUNTER.`] };
    } else if (f.liquidityVenue === 'NONE') {
      c.liquidity = { score: 70, status: 'assessed', reasons: ['No liquidity found on the verified venues of this network.'] };
    } else {
      c.liquidity = { score: null, status: 'not_assessed', reasons: ['Pool lookup failed.'] };
    }
  }

  // 6) Holder concentration (non-infrastructure wallets).
  {
    if (f.top10WalletPct == null) {
      c.holderConcentration = { score: null, status: 'not_assessed', reasons: ['Holder distribution unavailable.'] };
    } else {
      const s = ((f.top10WalletPct - 10) / 50) * 100;
      c.holderConcentration = {
        score: clamp(round1(s)),
        status: f.holderStatus === 'COMPLETE' ? 'assessed' : 'partial',
        reasons: [`Top 10 wallets (excluding LP/contracts/burn) hold ${f.top10WalletPct.toFixed(2)}% of supply.`],
      };
    }
  }
  return c;
}

export function riskBand(score, bands = RISK_BANDS) {
  return bands.find((b) => score >= b.min) ?? bands[bands.length - 1];
}

/**
 * Compute the final score.
 * @returns {{score:number|null, level:string, label:string, displayLevel:string, coverage:number, components:object, confidence:string, confidenceReasons:string[]}}
 */
export function computeRiskScore(facts, { weights = SCORING_WEIGHTS, policy = SCORING_POLICY } = {}) {
  validateWeights(weights);
  const components = scoreComponents(facts);
  let weighted = 0;
  let usedWeight = 0;
  let coverageWeight = 0;
  const out = {};
  for (const [key, w] of Object.entries(weights)) {
    const comp = components[key] ?? { score: null, status: 'not_assessed', reasons: ['Component unavailable.'] };
    out[key] = { ...comp, weight: w };
    if (comp.score == null) continue;
    weighted += comp.score * w;
    usedWeight += w;
    coverageWeight += comp.status === 'partial' ? w * policy.partialCoverageFactor : w;
  }
  const coverage = round1((coverageWeight / 100) * 100) / 100; // 0..1
  const score = usedWeight > 0 ? Math.round(weighted / usedWeight) : null;
  const band = score == null ? null : riskBand(score);
  const insufficient = score == null || coverage < policy.minCoverageForLevel;
  const { level: confidence, reasons: confidenceReasons } = computeConfidence({ coverage, facts, components: out });
  return {
    score,
    level: band?.level ?? 'INSUFFICIENT_DATA',
    label: band?.label ?? 'INSUFFICIENT DATA',
    displayLevel: insufficient ? 'INSUFFICIENT_DATA' : band.level,
    insufficientData: insufficient,
    coverage,
    components: out,
    confidence,
    confidenceReasons,
    model: 'heuristic-v1',
    disclaimer: 'The score is a heuristic model of observed indicators, not a calibrated rug-pull probability.',
  };
}

/** Score-based verdict (not from the LLM). There is no "SAFE ENTRY". */
export function verdictFor(result) {
  if (result.displayLevel === 'INSUFFICIENT_DATA') return 'INSUFFICIENT_DATA';
  if (result.level === 'HIGH_OBSERVED_RISK') return 'HIGH_OBSERVED_RISK_AVOID_OR_VERIFY';
  if (result.level === 'MODERATE_RISK') return 'BE_CAUTIOUS';
  return 'LOWER_OBSERVED_RISK_STILL_DYOR';
}
