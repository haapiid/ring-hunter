// Early activity scanner: deployment, pool creation, and swaps (buy/sell) proven by swap events.
// Plain token transfers are NOT counted as buys.
import { getAddress } from 'ethers';
import { getCurveTrades } from '../adapters/evm/ponsAdapter.js';
import { getSwaps } from '../adapters/evm/dexAdapter.js';
import { mapLimit, createLimiter } from '../utils/rateLimiter.js';
import { TOPICS, topicAddr } from '../adapters/evm/abis.js';

/** Sort by (block, transaction index, log index). */
export const byChainOrder = (a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex;

/**
 * @returns {Promise<{activities:object[], trades:object[], buyers:object[], coverage:object}>}
 */
export async function scanEarlyActivity({ rpc, token, origin, pools, latestBlock, limit = 50, chunkSize, deadline, isCancelled, extraInfra = [] }) {
  const activities = [];
  const coverage = { tradesFetched: 0, limit, sources: [], complete: true, notes: [] };

  if (origin.deployTxHash) {
    activities.push({
      type: 'DEPLOYMENT',
      txHash: origin.deployTxHash,
      blockNumber: origin.deployBlock,
      txIndex: origin.launch?.txIndex ?? 0,
      logIndex: origin.launch?.logIndex ?? 0,
      actor: origin.creator,
      evidence: origin.method,
    });
  }
  for (const p of pools) {
    const evidence = p.kind === 'v4' ? `${p.dex} PoolManager Initialize` : `${p.dex} factory ${p.kind === 'v2' ? 'PairCreated' : 'PoolCreated'}`;
    activities.push({ type: 'POOL_CREATION', txHash: p.txHash, blockNumber: p.blockNumber, txIndex: p.txIndex, logIndex: p.logIndex, actor: null, poolId: p.poolId, dex: p.dex, evidence });
  }

  let trades = [];
  // Pons bonding-curve phase (pre-graduation).
  if (origin.launch?.curve) {
    const r = await getCurveTrades(rpc, origin.launch.curve, { fromBlock: origin.launch.blockNumber, toBlock: latestBlock, maxLogs: limit, chunkSize, deadline, isCancelled });
    trades.push(...r.trades);
    coverage.sources.push('Pons curve CurveBuy/CurveSell');
    if (!r.complete && r.reason !== 'maxLogs') {
      coverage.complete = false;
      coverage.notes.push(`Curve trade fetching stopped (${r.reason}).`);
    }
  }
  // DEX pool phase (after graduation or for non-Pons tokens), only if the quota is not yet full.
  for (const pool of pools) {
    if (trades.length >= limit) break;
    const r = await getSwaps(rpc, pool, { fromBlock: pool.blockNumber, toBlock: latestBlock, maxLogs: limit - trades.length, chunkSize, deadline, isCancelled });
    trades.push(...r.swaps);
    coverage.sources.push(`${pool.dex} Swap (pool ${pool.poolId.slice(0, 10)}…)`);
    if (!r.complete && r.reason !== 'maxLogs') {
      coverage.complete = false;
      coverage.notes.push(`${pool.dex} swap fetching stopped (${r.reason}).`);
    }
  }
  trades = trades.sort(byChainOrder).slice(0, limit);

  // Attribute the actor from token Transfer logs in the same receipt (see attributeTrade).
  const lim = createLimiter({ concurrency: 4 });
  // Pool contracts (V2 pairs, V3 pools, V4 PoolManager) hold the liquidity: tokens leaving them are bought, not owned.
  const infra = new Set([origin.launch?.curve, ...pools.map((p) => p.address), ...extraInfra].filter(Boolean).map((a) => a.toLowerCase()));
  await mapLimit(trades, lim, async (t) => {
    try {
      const receipt = await rpc.getReceipt(t.txHash);
      attributeTrade(t, receipt, token, infra);
    } catch {
      t.trader = null;
    }
    try {
      t.timestamp = await rpc.getBlockTimestamp(t.blockNumber);
    } catch {
      t.timestamp = null;
    }
  });
  const unattributed = trades.filter((t) => !t.trader).length;
  if (unattributed) coverage.notes.push(`${unattributed} trade(s) without owner attribution.`);

  coverage.tradesFetched = trades.length;
  if (trades.length === 0) coverage.notes.push('No swap events observed for this token.');

  for (const t of trades) activities.push({ type: t.side, ...t, actor: t.trader });
  activities.sort(byChainOrder);

  return { activities, trades, buyers: summarizeTraders(trades), coverage };
}

/**
 * Attribute the economic owner of a trade (pure function, mutates the trade object).
 * Verified on real Robinhood Chain data: the buyer/seller field in events is often a router,
 * and a router can sell tokens owned by ANOTHER wallet via transferFrom (approval) in a tx sent
 * by a different address. Therefore:
 *  - BUY  → the recipient of the token Transfer leaving the curve/pool/router to a non-router address.
 *  - SELL → the sender of the token Transfer entering the curve/pool/router from a non-router address.
 * An amount exactly equal to the event is preferred. Fallback: event.recipient (BUY), then tx.from.
 */
export function attributeTrade(t, receipt, token, infra = new Set()) {
  const txFrom = receipt?.from ? getAddress(receipt.from) : null;
  const txTo = receipt?.to ? getAddress(receipt.to) : null;
  t.txFrom = txFrom;
  t.txTo = txTo;
  const routerish = new Set([...infra, t.eventActor, t.router, txTo].filter(Boolean).map((a) => a.toLowerCase()));
  // The tx sender is an EOA, so never a router (e.g. the deployer selling directly to the curve: eventActor = tx.from).
  if (txFrom) routerish.delete(txFrom.toLowerCase());
  const transfers = (receipt?.logs ?? [])
    .filter((l) => l.address?.toLowerCase() === token.toLowerCase() && l.topics?.[0] === TOPICS.Transfer && l.topics.length === 3)
    .map((l) => ({ from: topicAddr(l.topics[1]).toLowerCase(), to: topicAddr(l.topics[2]).toLowerCase(), value: BigInt(l.data.slice(0, 66)) }));
  const ZERO = '0x0000000000000000000000000000000000000000';
  const amount = BigInt(t.tokenAmount);
  const pick = (cands, key) => {
    if (!cands.length) return null;
    const exact = cands.find((x) => x.value === amount);
    return (exact ?? cands.reduce((a, b) => (b.value > a.value ? b : a)))[key];
  };
  let owner = null;
  if (t.side === 'BUY') {
    owner = pick(transfers.filter((x) => routerish.has(x.from) && !routerish.has(x.to) && x.to !== ZERO), 'to');
    if (owner) t.attribution = 'token-transfer-in-tx';
    else if (t.recipient && !routerish.has(t.recipient.toLowerCase())) {
      owner = t.recipient;
      t.attribution = 'event.recipient';
    }
  } else {
    owner = pick(transfers.filter((x) => !routerish.has(x.from) && routerish.has(x.to) && x.from !== ZERO), 'from');
    if (owner) t.attribution = 'token-transfer-in-tx';
  }
  if (!owner && txFrom) {
    owner = txFrom;
    t.attribution = 'tx.from';
  }
  t.trader = owner ? getAddress(owner) : null;
  // Tx sender ≠ token owner: a strong link (paying for / selling on behalf of another wallet).
  t.executedForOther = !!(t.trader && txFrom && t.trader.toLowerCase() !== txFrom.toLowerCase());
  return t;
}

/** Summarize per actor: first buy/sell, amounts, and distinct recipients (buys for other wallets). */
export function summarizeTraders(trades) {
  const map = new Map();
  for (const t of trades) {
    if (!t.trader) continue;
    const k = t.trader.toLowerCase();
    if (!map.has(k)) map.set(k, { address: t.trader, buys: 0, sells: 0, firstBuy: null, firstSell: null, tokenBought: 0n, tokenSold: 0n, recipients: new Set() });
    const s = map.get(k);
    if (t.side === 'BUY') {
      s.buys++;
      s.tokenBought += BigInt(t.tokenAmount);
      s.firstBuy ??= { blockNumber: t.blockNumber, txHash: t.txHash, timestamp: t.timestamp ?? null, txIndex: t.txIndex, logIndex: t.logIndex };
      if (t.recipient && t.recipient.toLowerCase() !== k) s.recipients.add(t.recipient);
    } else {
      s.sells++;
      s.tokenSold += BigInt(t.tokenAmount);
      s.firstSell ??= { blockNumber: t.blockNumber, txHash: t.txHash, timestamp: t.timestamp ?? null };
    }
  }
  return [...map.values()].map((s) => ({ ...s, recipients: [...s.recipients] }));
}

/** Simple trade statistics for a honeypot indication (not proof). */
export function tradeStats(trades) {
  const buys = trades.filter((t) => t.side === 'BUY').length;
  const sells = trades.filter((t) => t.side === 'SELL').length;
  const sellers = new Set(trades.filter((t) => t.side === 'SELL' && t.trader).map((t) => t.trader.toLowerCase())).size;
  return { buys, sells, sellers, total: trades.length };
}
