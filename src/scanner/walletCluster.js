// Evidence-based wallet cluster detection. Correlation ≠ ownership: the highest label is
// STRONG_CORRELATION; there is no "same owner" label.
import { getAddress } from 'ethers';
import { lc } from '../utils/validation.js';
import { RELATIONS } from './fundingGraph.js';
import { CLUSTER_THRESHOLDS } from '../config/analysis.js';

export const CLUSTER_LABELS = Object.freeze(['OBSERVED_LINK', 'POSSIBLE_CLUSTER', 'STRONG_CORRELATION', 'UNVERIFIED']);

const FUNDING_INDICATORS = new Set(['SHARED_FUNDER', 'DIRECT_TRANSFER', 'DEPLOYER_LINKED', 'FUNDING_TIME_PROXIMITY', 'SIMILAR_FUNDING_AMOUNTS']);
const BEHAVIOR_INDICATORS = new Set(['FRESH_WALLET_BUY', 'COORDINATED_BUY_TIMING', 'SIMILAR_SELL_PATTERN']);

const ALTERNATIVES = {
  SHARED_FUNDER: 'A shared funding source may be an exchange, bridge, faucet, or payment service that is not yet labeled.',
  DIRECT_TRANSFER: 'A direct transfer may be a payment, gift, OTC deal, or community airdrop.',
  DEPLOYER_LINKED: 'A link to the deployer may be a marketing wallet, a public team, or a transparent service payment.',
  FUNDING_TIME_PROXIMITY: 'Closely timed funding can happen due to the same market moment or exchange batch withdrawals.',
  SIMILAR_FUNDING_AMOUNTS: 'Similar amounts often come from common round numbers (e.g. 0.01 ETH).',
  FRESH_WALLET_BUY: 'Fresh wallets are also commonly used by regular users for security/privacy.',
  COORDINATED_BUY_TIMING: 'Buys in the same block can be caused by public bots, independent snipers, or an announcement.',
  SIMILAR_SELL_PATTERN: 'Closely timed sells may be the same market reaction, not coordination.',
};

/** Small union-find. */
function createUnionFind() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c);
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  return { find, union: (a, b) => parent.set(find(a), find(b)), has: (x) => parent.has(x) };
}

/** Is the funder suspected to be a public service (exchange/hot wallet/contract distribution)? */
export function isSuspectedService(profile, labels, t = CLUSTER_THRESHOLDS) {
  if (!profile) return { suspected: false };
  if (labels.isPublicInfra(profile.address)) return { suspected: true, reason: `labeled ${labels.get(profile.address)?.label}` };
  if (profile.nonce != null && profile.nonce >= t.serviceNonceThreshold) return { suspected: true, reason: `high nonce (${profile.nonce}) — hot wallet/service pattern` };
  if (profile.isContract && profile.fundedInterestWallets >= t.contractFanoutThreshold) return { suspected: true, reason: 'a contract funding many wallets — distribution/service pattern' };
  return { suspected: false };
}

function withinTolerance(values, tol) {
  const nums = values.map(Number).filter((v) => v > 0).sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i++) if ((nums[i] - nums[i - 1]) / nums[i] <= tol) return true;
  return false;
}

function clusterLabel(indicators) {
  const ids = new Set(indicators.map((i) => i.id));
  const hasFunding = [...ids].some((i) => FUNDING_INDICATORS.has(i));
  const hasBehavior = [...ids].some((i) => BEHAVIOR_INDICATORS.has(i));
  if (ids.size >= 3 && hasFunding && hasBehavior) return 'STRONG_CORRELATION';
  if (ids.size >= 2) return 'POSSIBLE_CLUSTER';
  if (ids.size === 1 && (ids.has('DIRECT_TRANSFER') || ids.has('SHARED_FUNDER') || ids.has('DEPLOYER_LINKED'))) return 'OBSERVED_LINK';
  return 'UNVERIFIED';
}

function clusterConfidence(label, indicatorCount) {
  if (label === 'STRONG_CORRELATION') return indicatorCount >= 4 ? 'HIGH' : 'MEDIUM';
  if (label === 'POSSIBLE_CLUSTER') return indicatorCount >= 3 ? 'MEDIUM' : 'LOW';
  return 'LOW';
}

/**
 * @param {object} p
 * @param {ReturnType<import('./fundingGraph.js').createGraph>} p.graph
 * @param {Set<string>} p.interest addresses (lowercase) of interest
 * @param {Map<string,object>} p.funderProfiles
 * @param {{address:string, firstBuy:object|null, firstSell:object|null}[]} p.traders
 * @param {string|null} p.deployer
 * @param {Map<string,bigint>} [p.balances] current balances (from holder analysis)
 * @param {bigint|null} [p.totalSupply]
 * @param {any} p.labels
 * @param {object} [p.coverage] funding graph coverage
 */
export function detectClusters({ graph, interest, funderProfiles = new Map(), traders = [], deployer = null, balances = new Map(), totalSupply = null, labels, coverage = {}, thresholds = CLUSTER_THRESHOLDS }) {
  const t = thresholds;
  const uf = createUnionFind();
  const linkEdges = new Map(); // root-agnostic: store edges per pair as evidence
  const excludedFunders = [];
  const traderMap = new Map(traders.map((x) => [lc(x.address), x]));
  const dep = deployer ? lc(deployer) : null;

  const fundingEdges = graph.edges.filter((e) => e.relation === RELATIONS.NATIVE_FUNDING || e.relation === RELATIONS.INTERNAL_FUNDING);

  // a) Direct links between wallets of interest.
  for (const e of graph.edges) {
    const f = lc(e.from);
    const to = lc(e.to);
    if (interest.has(f) && interest.has(to) && f !== to) {
      uf.union(f, to);
      const key = [f, to].sort().join('|');
      if (!linkEdges.has(key)) linkEdges.set(key, []);
      linkEdges.get(key).push(e);
    }
  }

  // b) Shared funders (not public services) → their recipient wallets are merged with the funder.
  const byFunder = new Map();
  for (const e of fundingEdges) {
    if (!interest.has(lc(e.to))) continue;
    const f = lc(e.from);
    if (!byFunder.has(f)) byFunder.set(f, []);
    byFunder.get(f).push(e);
  }
  const sharedFunders = new Map();
  for (const [f, edges] of byFunder) {
    const recips = new Set(edges.map((e) => lc(e.to)));
    if (recips.size < 2) continue;
    const svc = isSuspectedService(funderProfiles.get(f) ?? { address: f }, labels, t);
    if (svc.suspected) {
      excludedFunders.push({ address: getAddress(f), reason: svc.reason, fundedWallets: recips.size });
      continue;
    }
    sharedFunders.set(f, edges);
    for (const r of recips) uf.union(f, r);
  }

  // c) Group.
  const groups = new Map();
  const members = new Set([...interest, ...sharedFunders.keys()]);
  for (const a of members) {
    if (!uf.has(a)) continue;
    const r = uf.find(a);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(a);
  }

  const clusters = [];
  let n = 0;
  for (const set of groups.values()) {
    if (set.size < 2) continue;
    const wallets = [...set];
    const inCluster = (a) => set.has(lc(a));
    const evidence = [];
    const indicators = [];
    const add = (id, detail) => indicators.push({ id, detail });

    const direct = graph.edges.filter((e) => inCluster(e.from) && inCluster(e.to) && e.relation !== RELATIONS.NATIVE_FUNDING && e.relation !== RELATIONS.INTERNAL_FUNDING);
    const directFunding = fundingEdges.filter((e) => inCluster(e.from) && inCluster(e.to) && !sharedFunders.has(lc(e.from)));
    if (direct.length || directFunding.length) add('DIRECT_TRANSFER', `${direct.length + directFunding.length} direct transfers between members`);
    evidence.push(...direct, ...directFunding);

    const funders = [...sharedFunders.keys()].filter((f) => set.has(f));
    if (funders.length) {
      add('SHARED_FUNDER', `${funders.length} shared funding source(s) funded ≥2 members`);
      for (const f of funders) evidence.push(...sharedFunders.get(f));
    }
    if (dep && set.has(dep)) add('DEPLOYER_LINKED', 'cluster includes the deployer address');

    const inFunding = fundingEdges.filter((e) => inCluster(e.to));
    const times = inFunding.map((e) => e.timestamp).filter((x) => x != null).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] <= t.fundingWindowSeconds) {
        add('FUNDING_TIME_PROXIMITY', `≥2 fundings within ${Math.round(t.fundingWindowSeconds / 3600)} hours`);
        break;
      }
    }
    const fromShared = inFunding.filter((e) => sharedFunders.has(lc(e.from)));
    if (fromShared.length >= 2 && withinTolerance(fromShared.map((e) => e.amount), t.similarAmountTolerance)) {
      add('SIMILAR_FUNDING_AMOUNTS', `similar funding amounts (tolerance ${t.similarAmountTolerance * 100}%)`);
    }

    // Members' trading behavior.
    const memberTraders = wallets.map((a) => traderMap.get(a)).filter(Boolean);
    const fresh = memberTraders.filter((tr) => {
      if (!tr.firstBuy?.timestamp) return false;
      const funded = inFunding.filter((e) => lc(e.to) === lc(tr.address) && e.timestamp != null && e.timestamp <= tr.firstBuy.timestamp);
      if (!funded.length) return false;
      const firstFunding = Math.min(...funded.map((e) => e.timestamp));
      return tr.firstBuy.timestamp - firstFunding <= t.freshWalletSeconds;
    });
    if (fresh.length >= 1) add('FRESH_WALLET_BUY', `${fresh.length} member(s) bought ≤${Math.round(t.freshWalletSeconds / 3600)} hours after the first observed funding`);

    const buyBlocks = memberTraders.filter((x) => x.firstBuy).map((x) => x.firstBuy.blockNumber).sort((a, b) => a - b);
    for (let i = 1; i < buyBlocks.length; i++) {
      if (buyBlocks[i] - buyBlocks[i - 1] <= t.coordinatedBlockSpan) {
        add('COORDINATED_BUY_TIMING', `≥2 members bought within ${t.coordinatedBlockSpan} blocks`);
        break;
      }
    }
    const sellBlocks = memberTraders.filter((x) => x.firstSell).map((x) => x.firstSell.blockNumber).sort((a, b) => a - b);
    for (let i = 1; i < sellBlocks.length; i++) {
      if (sellBlocks[i] - sellBlocks[i - 1] <= t.coordinatedBlockSpan * 5) {
        add('SIMILAR_SELL_PATTERN', '≥2 members made their first sell within a close block range');
        break;
      }
    }

    const label = clusterLabel(indicators);
    const supply = clusterSupply(wallets, balances, totalSupply, labels);
    const limitations = [];
    if (coverage.nativeFunding === 'NONE') limitations.push('Native-coin funding not observed (no explorer API).');
    if (coverage.nativeFunding === 'PARTIAL') limitations.push('Part of the funding history failed/was not fetched.');
    limitations.push('On-chain correlation does not prove identity or shared ownership.');

    clusters.push({
      id: `C${++n}`,
      label,
      confidence: clusterConfidence(label, indicators.length),
      basis: 'FUNDING_AND_TRANSFERS',
      wallets: wallets.map((a) => ({ address: getAddress(a), roles: [...(graph.nodes.get(a)?.roles ?? [])], isSharedFunder: sharedFunders.has(a) })),
      indicators,
      reason: indicators.map((i) => i.detail).join('; '),
      evidence: dedupeEvidence(evidence),
      alternatives: [...new Set(indicators.map((i) => ALTERNATIVES[i.id]).filter(Boolean))],
      limitations,
      supply,
      containsDeployer: !!(dep && set.has(dep)),
    });
  }

  // d) Timing-only groups: buyers with no funding link who bought in nearby blocks. Informational only.
  const timingGroups = detectTimingGroups(traders, t).filter((grp) => !grp.every((a) => clusters.some((c) => c.wallets.some((w) => lc(w.address) === a))));
  for (const grp of timingGroups) {
    clusters.push({
      id: `T${++n}`,
      label: 'UNVERIFIED',
      confidence: 'LOW',
      basis: 'TIMING_ONLY',
      wallets: grp.map((a) => ({ address: getAddress(a), roles: ['EARLY_TRADER'], isSharedFunder: false })),
      indicators: [{ id: 'COORDINATED_BUY_TIMING', detail: `${grp.length} distinct buyers within ${t.coordinatedBlockSpan} blocks` }],
      reason: 'Buy timing proximity only; no funding link observed.',
      evidence: grp.map((a) => traderMap.get(a)?.firstBuy).filter(Boolean).map((b) => ({ txHash: b.txHash, blockNumber: b.blockNumber, relation: 'BUY', source: 'rpc-log' })),
      alternatives: [ALTERNATIVES.COORDINATED_BUY_TIMING],
      limitations: ['A timing pattern alone is not enough to conclude coordination.'],
      supply: clusterSupply(grp, balances, totalSupply, labels),
      containsDeployer: false,
    });
  }

  return { clusters, excludedFunders, summary: summarizeClusters(clusters, balances, totalSupply, dep, labels) };
}

/** Distinct buyers (≥ coordinatedMinBuyers) whose first buys fall within the same block span. */
export function detectTimingGroups(traders, t = CLUSTER_THRESHOLDS) {
  const buys = traders.filter((x) => x.firstBuy).map((x) => ({ a: lc(x.address), b: x.firstBuy.blockNumber })).sort((x, y) => x.b - y.b);
  const groups = [];
  let i = 0;
  while (i < buys.length) {
    let j = i;
    while (j + 1 < buys.length && buys[j + 1].b - buys[i].b <= t.coordinatedBlockSpan) j++;
    if (j - i + 1 >= t.coordinatedMinBuyers) {
      groups.push(buys.slice(i, j + 1).map((x) => x.a));
      i = j + 1;
    } else i++;
  }
  return groups;
}

/** Current supply held by members (each address counted once; infrastructure excluded). */
export function clusterSupply(wallets, balances, totalSupply, labels) {
  let sum = 0n;
  let counted = 0;
  for (const a of new Set(wallets.map(lc))) {
    if (labels.isPublicInfra(a)) continue;
    const b = balances.get(a);
    if (b != null && b > 0n) {
      sum += b;
      counted++;
    }
  }
  const pct = totalSupply && totalSupply > 0n ? Number((sum * 100_000_000n) / totalSupply) / 1_000_000 : null;
  return { balance: sum, pct, holdersWithBalance: counted };
}

function dedupeEvidence(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const k = `${e.txHash}|${e.relation}|${e.from}|${e.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** Summary for scoring & tables. Estimated supply only from clusters ≥ POSSIBLE_CLUSTER. */
export function summarizeClusters(clusters, balances, totalSupply, dep, labels) {
  const meaningful = clusters.filter((c) => c.label === 'POSSIBLE_CLUSTER' || c.label === 'STRONG_CORRELATION');
  const allWallets = new Set(meaningful.flatMap((c) => c.wallets.map((w) => lc(w.address))));
  const supply = clusterSupply([...allWallets], balances, totalSupply, labels);
  const devCluster = clusters.find((c) => c.containsDeployer);
  const devWallets = new Set(devCluster ? devCluster.wallets.map((w) => lc(w.address)) : dep ? [dep] : []);
  const devSupply = clusterSupply([...devWallets], balances, totalSupply, labels);
  const byLabel = Object.fromEntries(CLUSTER_LABELS.map((l) => [l, clusters.filter((c) => c.label === l).length]));
  return {
    total: clusters.length,
    meaningfulCount: meaningful.length,
    meaningfulWalletCount: allWallets.size,
    byLabel,
    strongest: clusters.some((c) => c.label === 'STRONG_CORRELATION') ? 'STRONG_CORRELATION' : meaningful.length ? 'POSSIBLE_CLUSTER' : clusters.some((c) => c.label === 'OBSERVED_LINK') ? 'OBSERVED_LINK' : clusters.length ? 'UNVERIFIED' : null,
    estimatedClusterSupplyPct: totalSupply ? supply.pct : null,
    estimatedDeveloperSupplyPct: totalSupply && devWallets.size ? devSupply.pct : null,
    developerClusterId: devCluster?.id ?? null,
  };
}
