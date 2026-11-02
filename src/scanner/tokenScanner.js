// Token scan orchestrator. Terminal-independent: progress is reported through the onStage callback
// so it can be tested without a UI. Each stage records its coverage/limitations.
import { NetworkMismatchError, InputError, CancelledError } from '../utils/errors.js';
import { normalizeAddress, lc } from '../utils/validation.js';
import { readTokenInfo } from '../adapters/evm/tokenAdapter.js';
import { findPools, selectPrimaryPools } from '../adapters/evm/dexAdapter.js';
import { detectOrigin } from './creatorDetector.js';
import { scanEarlyActivity, tradeStats } from './transactionScanner.js';
import { analyzeHolders } from './holderAnalysis.js';
import { buildFundingGraph } from './fundingGraph.js';
import { detectClusters } from './walletCluster.js';
import { analyzeContract } from './contractRisk.js';
import { computeRiskScore, verdictFor } from '../scoring/riskScoring.js';
import { SCAN_LIMITS } from '../config/analysis.js';
import { NETWORK } from '../config/networks.js';
import { EXPLORER_KEY_ENV } from '../config/env.js';

/**
 * @param {object} p
 * @param {string} p.address token address (user input)
 * @param {object} p.config result of buildConfig
 * @param {object} p.rpc createRpcClient
 * @param {object|null} p.explorer createExplorerClient
 * @param {object} p.labels createLabelRegistry
 * @param {(id:string, status:'start'|'done'|'warn'|'skip', detail?:string)=>void} [p.onStage]
 * @param {AbortSignal} [p.signal]
 * @param {() => number} [p.now]
 */
export async function runTokenScan({ address, config, rpc, explorer = null, labels, onStage = () => {}, signal, now = () => Date.now(), limits = SCAN_LIMITS }) {
  const token = normalizeAddress(address, 'Token address');
  const isCancelled = () => !!signal?.aborted;
  const checkCancel = () => {
    if (isCancelled()) throw new CancelledError();
  };
  const startedAt = now();
  const limitations = [];
  const stage = async (id, fn) => {
    checkCancel();
    onStage(id, 'start');
    const r = await fn();
    checkCancel();
    onStage(id, r?.__warn ? 'warn' : 'done', r?.__detail);
    return r;
  };

  // 1-2) Connection & network verification. No silent network switching.
  const latestBlock = await stage('connect', async () => rpc.blockNumber());
  const network = await stage('network', async () => {
    const actual = await rpc.chainId();
    if (actual !== config.chainId) throw new NetworkMismatchError(config.chainId, actual);
    const net = config.network ?? NETWORK;
    if (actual !== net.chainId) throw new NetworkMismatchError(net.chainId, actual);
    return { ...net, __detail: `${net.name} (chain ID ${actual}), block ${latestBlock}` };
  });

  // 3) Token.
  const tokenInfo = await stage('token', async () => {
    const info = await readTokenInfo(rpc, token);
    if (!info.isContract) throw new InputError(`Address ${token} is not a contract (no bytecode) on ${network.name}.`);
    if (!info.isErc20Like) throw new InputError(`Contract ${token} does not respond as an ERC-20 token (decimals/totalSupply failed).`);
    return { ...info, __detail: `${info.name ?? '?'} (${info.symbol ?? '?'})` };
  });

  // Each slow stage gets its own time budget, so a long origin search does not starve the holder scan.
  const budget = (seconds) => Date.now() + seconds * 1000;
  const chunkSize = config.logChunkBlocks;

  // 4) Token origin.
  const origin = await stage('origin', async () => {
    const o = await detectOrigin({ rpc, explorer, token, latestBlock, deadline: budget(limits.originSearchSeconds ?? 60), isCancelled });
    if (o.status !== 'VERIFIED') limitations.push(...o.notes);
    return { ...o, __warn: o.status !== 'VERIFIED', __detail: o.creator ? `${o.method} → ${o.creator}` : 'creator unknown' };
  });

  // Dynamic label: this token's Pons curve is infrastructure, not a holder/insider.
  const extraLabels = new Map();
  if (origin.launch?.curve) {
    const item = { address: origin.launch.curve, label: 'Pons bonding curve (this token)', kind: 'CURVE' };
    extraLabels.set(lc(item.address), item);
    labels.add({ ...item, kind: 'PROTOCOL' });
  }

  // 5) Pool. Searched on every verified DEX (Uniswap V4/V3/V2) from the deployment block.
  const poolResult = await stage('pools', async () => {
    if (origin.deployBlock == null) return { pools: [], primary: [], others: [], complete: false, __warn: true, __detail: 'deployment block unknown' };
    try {
      const r = await findPools(rpc, token, network, { fromBlock: origin.deployBlock, toBlock: latestBlock, deadline: budget(config.holderScanMaxSeconds), isCancelled });
      for (const f of r.failures) limitations.push(`Pool lookup failed on ${f}`);
      const sel = selectPrimaryPools(r.pools, origin.launch);
      if (sel.others.length) limitations.push(`${sel.others.length} other pool(s) contain this token (permissionless pools/other token markets); only the primary pools are analyzed.`);
      if (origin.launch && !sel.primary.length) limitations.push('Pons graduation pool not found: the token is probably still on the bonding curve.');
      const dexes = [...new Set(sel.primary.map((p) => dexLabel(network, p.dex)))].join(', ');
      return { ...r, primary: sel.primary, others: sel.others, method: sel.method, __warn: !r.complete, __detail: `${sel.primary.length} primary pool(s)${dexes ? ` on ${dexes}` : ''} (${r.pools.length} total, method ${sel.method})` };
    } catch (e) {
      limitations.push(`Pool lookup failed: ${e.message}`);
      return { pools: [], primary: [], others: [], complete: false, failed: true, __warn: true, __detail: 'failed' };
    }
  });
  // Only the primary pools are used for trades, activity, and the liquidity score.
  const pools = poolResult.primary;
  // V2 pairs / V3 pools are contracts holding liquidity: label them so holders/clusters treat them as infrastructure.
  for (const p of pools) {
    if (p.kind === 'v4') continue;
    const item = { address: p.address, label: `${p.dex} pool (this token)`, kind: 'DEX' };
    extraLabels.set(lc(item.address), item);
    labels.add(item);
  }

  // 6) Early transactions.
  const early = await stage('early', async () => {
    const r = await scanEarlyActivity({ rpc, token, origin, pools, latestBlock, limit: config.maxInitialTx, chunkSize, deadline: null, isCancelled, extraInfra: network.verifiedContracts.map((x) => x.address) });
    limitations.push(...r.coverage.notes);
    return { ...r, __warn: r.trades.length === 0, __detail: `${r.trades.length} trades, ${r.buyers.length} actors` };
  });

  // 7) Holder.
  const holders = await stage('holders', async () => {
    const r = await analyzeHolders({
      rpc,
      token,
      tokenInfo,
      fromBlock: origin.deployBlock,
      latestBlock,
      labels,
      extraLabels,
      chunkSize,
      deadline: budget(config.holderScanMaxSeconds),
      maxLogs: limits.maxTransferLogs,
      crossCheckTop: limits.balanceCrossCheckTop,
      extraCandidates: [...early.buyers.map((b) => b.address), origin.creator].filter(Boolean),
      isCancelled,
    });
    if (r.status !== 'COMPLETE') limitations.push(r.reason ?? 'Partial holder data.', ...(r.notes ?? []));
    return { ...r, __warn: r.status !== 'COMPLETE', __detail: r.distribution ? (r.distribution.sampleMode ? `sample of ${r.sampleSize} addresses (${r.status})` : `${r.distribution.holderCount} holder (${r.status})`) : r.status };
  });

  // 8) Funding graph.
  const topHolders = (holders.distribution?.holders ?? []).filter((h) => h.category === 'WALLET').slice(0, 10).map((h) => h.address);
  const funding = await stage('funding', async () => {
    const r = await buildFundingGraph({
      rpc,
      traders: early.buyers,
      trades: early.trades,
      transfers: holders.transfers ?? [],
      deployer: origin.creator,
      topHolders,
      explorer,
      labels,
      tokenSymbol: tokenInfo.symbol ?? 'TOKEN',
      nativeSymbol: network.nativeSymbol,
      explorerKeyHint: EXPLORER_KEY_ENV,
      maxLookups: limits.maxFundingLookups,
      txPerWallet: limits.explorerTxPerWallet,
      isCancelled,
    });
    if (r.coverage.note) limitations.push(r.coverage.note);
    return { ...r, __warn: r.coverage.nativeFunding !== 'COMPLETE_FOR_TARGETS', __detail: `${r.graph.edges.length} edges, ${network.nativeSymbol}: ${r.coverage.nativeFunding}` };
  });

  // 9) Cluster.
  const clusterResult = await stage('clusters', async () => {
    const r = detectClusters({
      graph: funding.graph,
      interest: funding.interest,
      funderProfiles: funding.funderProfiles,
      traders: early.buyers,
      deployer: origin.creator,
      balances: holders.balances ?? new Map(),
      totalSupply: holders.distribution ? tokenInfo.totalSupply : null,
      labels,
      coverage: funding.coverage,
    });
    return { ...r, __detail: `${r.clusters.length} cluster/group(s) (${r.summary.meaningfulCount} ≥ POSSIBLE)` };
  });

  // 10) Contract.
  const stats = tradeStats(early.trades);
  const contract = await stage('contract', async () => {
    const r = await analyzeContract({ rpc, address: token, code: tokenInfo.code, launch: origin.launch, tradeStats: stats });
    return { ...r, __detail: `${r.findings.length} findings` };
  });

  // 11) Score.
  const facts = buildScoringFacts({ origin, early, holders, funding, clusterResult, contract, pools, poolResult, network });
  const risk = await stage('score', async () => {
    const r = computeRiskScore(facts);
    return { ...r, __detail: r.score == null ? 'cannot be computed' : `${r.score}/100 (${r.label})` };
  });
  const verdict = verdictFor(risk);

  const { code: _omit, ...tokenPublic } = tokenInfo;
  return {
    meta: { startedAt, finishedAt: now(), latestBlock, rpcLabel: config.rpcLabel, rpcStats: { ...rpc.stats }, explorer: explorer?.source ?? null },
    network: { key: network.key, name: network.name, chainId: network.chainId, explorerUrl: network.explorerUrl, nativeSymbol: network.nativeSymbol },
    token: tokenPublic,
    origin,
    pools,
    poolSelection: { method: poolResult.method ?? null, totalFound: poolResult.pools.length, others: (poolResult.others ?? []).slice(0, 20), othersCount: (poolResult.others ?? []).length },
    early,
    holders,
    funding,
    clusters: clusterResult,
    contract,
    facts,
    risk,
    verdict,
    limitations: [...new Set(limitations.filter(Boolean))],
  };
}

const dexLabel = (network, id) => network?.dexes?.find((d) => d.id === id)?.label ?? id;

/** Turn module results into numeric facts for scoring (pure function). */
export function buildScoringFacts({ origin, early, holders, funding, clusterResult, contract, pools, poolResult, network = null }) {
  const fundingClusters = clusterResult.clusters.filter((c) => c.basis === 'FUNDING_AND_TRANSFERS' && c.label !== 'UNVERIFIED');
  const traderSet = new Set(early.buyers.map((b) => lc(b.address)));
  const inFunding = new Set();
  const inAny = new Set();
  for (const c of clusterResult.clusters) {
    for (const w of c.wallets) {
      const a = lc(w.address);
      if (!traderSet.has(a)) continue;
      inAny.add(a);
      if (fundingClusters.includes(c)) inFunding.add(a);
    }
  }
  const dep = origin.creator ? lc(origin.creator) : null;
  const deployerLinkedToTraders = !!dep && fundingClusters.some((c) => c.containsDeployer && c.wallets.some((w) => traderSet.has(lc(w.address)) && lc(w.address) !== dep));

  const native = funding.coverage.nativeFunding;
  const fundingCoverage = native === 'NONE' && funding.coverage.tokenTransfers === 'NONE' ? 'NONE_AT_ALL' : native;

  let liquidityVenue;
  if (poolResult.failed) liquidityVenue = null;
  else if (origin.launch?.protocol === 'PONS_V2') liquidityVenue = 'PONS';
  else if (pools.length) liquidityVenue = 'DEX_POOL';
  else liquidityVenue = 'NONE';

  return {
    originStatus: origin.status,
    earlyTraderCount: early.buyers.length,
    earlyComplete: early.coverage.complete,
    tradersInFundingClusters: inFunding.size,
    tradersInAnyGroup: inAny.size,
    strongClusterCount: clusterResult.summary.byLabel.STRONG_CORRELATION,
    deployerLinkedToTraders,
    fundingCoverage,
    holderStatus: holders.status,
    clusterSupplyPct: holders.distribution ? (clusterResult.summary.estimatedClusterSupplyPct ?? 0) : null,
    developerSupplyPct: holders.distribution ? clusterResult.summary.estimatedDeveloperSupplyPct : null,
    top10WalletPct: holders.distribution?.top10WalletPct ?? null,
    contractScore: contract?.score ?? null,
    contractReasons: (contract?.findings ?? []).map((f) => `${f.title} [${f.level}]`),
    liquidityVenue,
    liquidityDexes: [...new Set(pools.map((p) => dexLabel(network, p.dex)))],
  };
}
