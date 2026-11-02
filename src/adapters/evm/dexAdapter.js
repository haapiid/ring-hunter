// DEX adapter for every verified deployment listed in network.dexes (config/networks.js):
//   v2 — pair contracts (Uniswap V2): PairCreated on the factory, Swap on the pair.
//   v3 — pool contracts (Uniswap V3): PoolCreated on the factory, Swap on the pool.
//   v4 — singleton PoolManager (Uniswap V4): Initialize & Swap on the PoolManager, keyed by poolId.
import { getAddress } from 'ethers';
import { V4_POOL_MANAGER, V2_FACTORY, V2_PAIR, V3_FACTORY, V3_POOL, TOPICS, addrTopic } from './abis.js';

const ZERO = '0x0000000000000000000000000000000000000000';

const ref = (l) => ({
  txHash: l.transactionHash,
  blockNumber: Number(BigInt(l.blockNumber)),
  txIndex: Number(BigInt(l.transactionIndex ?? 0)),
  logIndex: Number(BigInt(l.logIndex ?? 0)),
});
const abs = (v) => (v < 0n ? -v : v);

/** Search a factory/PoolManager for events naming the token in either currency position. */
async function creationLogs(rpc, address, topic0, token, offset, opts) {
  const t = addrTopic(token);
  const base = { address, fromBlock: opts.fromBlock, toBlock: opts.toBlock, chunkSize: opts.chunkSize ?? 9_000_000, deadline: opts.deadline, isCancelled: opts.isCancelled };
  const pad = Array(offset).fill(null);
  const [a, b] = await Promise.all([rpc.getLogsChunked({ ...base, topics: [topic0, ...pad, t] }), rpc.getLogsChunked({ ...base, topics: [topic0, ...pad, null, t] })]);
  return { logs: [...a.logs, ...b.logs], complete: a.complete && b.complete };
}

/**
 * Find Uniswap V4 pools containing the token (as currency0 or currency1) since fromBlock.
 * PoolManager is a singleton, so the search uses topic filters to keep results small.
 */
export async function findV4Pools(rpc, token, { poolManager, ponsHook = null, dexId = 'UNISWAP_V4', fromBlock, toBlock, chunkSize, deadline, isCancelled }) {
  const r = await creationLogs(rpc, poolManager, TOPICS.Initialize, token, 1, { fromBlock, toBlock, chunkSize, deadline, isCancelled });
  const pools = r.logs.map((l) => {
    const ev = V4_POOL_MANAGER.parseLog(l);
    const hooks = getAddress(ev.args.hooks);
    return {
      dex: dexId,
      kind: 'v4',
      poolId: ev.args.id,
      address: getAddress(poolManager),
      currency0: getAddress(ev.args.currency0),
      currency1: getAddress(ev.args.currency1),
      tokenIsCurrency0: ev.args.currency0.toLowerCase() === token.toLowerCase(),
      fee: Number(ev.args.fee),
      tickSpacing: Number(ev.args.tickSpacing),
      hooks,
      isPonsPool: !!ponsHook && hooks.toLowerCase() === ponsHook.toLowerCase(),
      ...ref(l),
    };
  });
  return { pools, complete: r.complete };
}

/** V2 pairs (PairCreated: token0, token1 indexed; data = pair, pair count). */
export async function findV2Pools(rpc, token, dexDef, opts) {
  const r = await creationLogs(rpc, dexDef.factory, TOPICS.PairCreated, token, 0, opts);
  const pools = r.logs.map((l) => {
    const ev = V2_FACTORY.parseLog(l);
    const pair = getAddress(ev.args.pair);
    return { dex: dexDef.id, kind: 'v2', poolId: pair, address: pair, currency0: getAddress(ev.args.token0), currency1: getAddress(ev.args.token1), tokenIsCurrency0: ev.args.token0.toLowerCase() === token.toLowerCase(), fee: null, hooks: null, isPonsPool: false, ...ref(l) };
  });
  return { pools, complete: r.complete };
}

/** V3 pools (PoolCreated: token0, token1, fee indexed; data = tickSpacing, pool). */
export async function findV3Pools(rpc, token, dexDef, opts) {
  const r = await creationLogs(rpc, dexDef.factory, TOPICS.PoolCreated, token, 0, opts);
  const pools = r.logs.map((l) => {
    const ev = V3_FACTORY.parseLog(l);
    const pool = getAddress(ev.args.pool);
    return { dex: dexDef.id, kind: 'v3', poolId: pool, address: pool, currency0: getAddress(ev.args.token0), currency1: getAddress(ev.args.token1), tokenIsCurrency0: ev.args.token0.toLowerCase() === token.toLowerCase(), fee: Number(ev.args.fee), tickSpacing: Number(ev.args.tickSpacing), hooks: null, isPonsPool: false, ...ref(l) };
  });
  return { pools, complete: r.complete };
}

/**
 * All pools of the token across the network's verified DEXes. A failing DEX does not hide the others:
 * its error is returned in `failures` and the result is marked incomplete.
 */
export async function findPools(rpc, token, network, { fromBlock, toBlock, chunkSize, deadline, isCancelled }) {
  const opts = { fromBlock, toBlock, chunkSize, deadline, isCancelled };
  const ponsHook = network.protocols?.pons?.memeHook ?? null;
  const results = await Promise.all(
    network.dexes.map(async (d) => {
      try {
        if (d.kind === 'v4') return await findV4Pools(rpc, token, { ...opts, poolManager: d.poolManager, ponsHook, dexId: d.id });
        if (d.kind === 'v3') return await findV3Pools(rpc, token, d, opts);
        return await findV2Pools(rpc, token, d, opts);
      } catch (e) {
        return { pools: [], complete: false, failure: `${d.label}: ${e.message}` };
      }
    }),
  );
  const failures = results.map((r) => r.failure).filter(Boolean);
  if (failures.length === results.length && results.length) throw new Error(failures.join('; '));
  return { pools: results.flatMap((r) => r.pools), complete: results.every((r) => r.complete), failures };
}

const swapRef = (pool, l) => ({ venue: pool.dex, poolId: pool.poolId, trader: null, attribution: 'pending', ...ref(l) });

/** Normalize one swap log of a pool into { side, router, recipient, tokenAmount, quoteAmount }. Pure function. */
export function decodeSwap(pool, l) {
  if (pool.kind === 'v4') {
    // V4 deltas are from the swapper's side: positive = tokens received by the swapper.
    const ev = V4_POOL_MANAGER.parseLog(l);
    const tokenDelta = BigInt(pool.tokenIsCurrency0 ? ev.args.amount0 : ev.args.amount1);
    const quoteDelta = BigInt(pool.tokenIsCurrency0 ? ev.args.amount1 : ev.args.amount0);
    return { ...swapRef(pool, l), side: tokenDelta > 0n ? 'BUY' : 'SELL', router: getAddress(ev.args.sender), tokenAmount: abs(tokenDelta).toString(), quoteAmount: abs(quoteDelta).toString() };
  }
  if (pool.kind === 'v3') {
    // V3 amounts are from the pool's side: positive = paid into the pool, negative = paid out to the recipient.
    const ev = V3_POOL.parseLog(l);
    const tokenDelta = BigInt(pool.tokenIsCurrency0 ? ev.args.amount0 : ev.args.amount1);
    const quoteDelta = BigInt(pool.tokenIsCurrency0 ? ev.args.amount1 : ev.args.amount0);
    return { ...swapRef(pool, l), side: tokenDelta < 0n ? 'BUY' : 'SELL', router: getAddress(ev.args.sender), recipient: getAddress(ev.args.recipient), tokenAmount: abs(tokenDelta).toString(), quoteAmount: abs(quoteDelta).toString() };
  }
  // V2: tokens out of the pair = a buy. Net amounts cover the rare swap that pays in and out of the same token.
  const ev = V2_PAIR.parseLog(l);
  const [tIn, tOut, qIn, qOut] = pool.tokenIsCurrency0 ? [ev.args.amount0In, ev.args.amount0Out, ev.args.amount1In, ev.args.amount1Out] : [ev.args.amount1In, ev.args.amount1Out, ev.args.amount0In, ev.args.amount0Out];
  const buy = tOut > tIn;
  return { ...swapRef(pool, l), side: buy ? 'BUY' : 'SELL', router: getAddress(ev.args.sender), recipient: getAddress(ev.args.to), tokenAmount: abs(tOut - tIn).toString(), quoteAmount: abs(qIn - qOut).toString() };
}

/**
 * Swaps on one pool, ascending. The sender field is the router, NOT the buyer; buyer attribution is done
 * later from Transfer logs in the receipt by transactionScanner.attributeTrade().
 */
export async function getSwaps(rpc, pool, { fromBlock, toBlock, maxLogs = 500, chunkSize, deadline, isCancelled }) {
  const filter =
    pool.kind === 'v4'
      ? { address: pool.address, topics: [TOPICS.Swap, pool.poolId] }
      : { address: pool.address, topics: [pool.kind === 'v2' ? TOPICS.V2Swap : TOPICS.V3Swap] };
  const res = await rpc.getLogsChunked({ ...filter, fromBlock, toBlock, maxLogs, chunkSize, deadline, isCancelled });
  const swaps = res.logs.map((l) => decodeSwap(pool, l)).filter((s) => s.tokenAmount !== '0');
  return { swaps, complete: res.complete, reason: res.reason };
}

/**
 * Select the token's primary pools (pure function). Pools are permissionless: anyone can create one with any
 * token, and tokens used as the pair for other Pons launches also appear in many Pons-hooked pools. Therefore:
 *  - Pons tokens: the Pons-hooked pool whose pair currency = pairToken from TokenLaunched
 *    (0x0 = native ETH), earliest after launch. This heuristic was matched on 1 real token
 *    (2026-10-27) — not from the PoolGraduated event (signature not yet verified).
 *  - Other tokens: the few earliest pools across all verified DEXes.
 */
export function selectPrimaryPools(pools, launch, { maxNonPons = 5 } = {}) {
  const sorted = [...pools].sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
  if (launch) {
    const pair = (launch.pairIsNative ? ZERO : launch.pairToken).toLowerCase();
    const primary = sorted
      .filter((p) => p.isPonsPool && p.blockNumber >= launch.blockNumber)
      .filter((p) => (p.tokenIsCurrency0 ? p.currency1 : p.currency0).toLowerCase() === pair)
      .slice(0, 1);
    return {
      primary,
      others: sorted.filter((p) => !primary.includes(p)),
      method: primary.length ? 'PONS_HOOK_AND_PAIR_TOKEN' : 'NOT_GRADUATED_OR_NOT_FOUND',
    };
  }
  return { primary: sorted.slice(0, maxNonPons), others: sorted.slice(maxNonPons), method: 'EARLIEST_POOLS' };
}
