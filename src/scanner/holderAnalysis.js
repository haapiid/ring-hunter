// Holder distribution. The Robinhood RPC is not an archive node, so balances are reconstructed from all Transfer logs
// since the deployment block, then partly cross-checked against balanceOf at the latest block.
import { getAddress } from 'ethers';
import { TOPICS, topicAddr } from '../adapters/evm/abis.js';
import { readBalance } from '../adapters/evm/tokenAdapter.js';
import { ratioPct } from '../utils/format.js';
import { mapLimit, createLimiter } from '../utils/rateLimiter.js';

const ZERO = '0x0000000000000000000000000000000000000000';

/** Fetch all token Transfer logs in chunks. */
export async function fetchTransfers(rpc, token, { fromBlock, toBlock, chunkSize, deadline, maxLogs, onProgress, isCancelled }) {
  const res = await rpc.getLogsChunked({ address: token, topics: [TOPICS.Transfer], fromBlock, toBlock, chunkSize, deadline, maxLogs, onProgress, isCancelled });
  const transfers = [];
  for (const l of res.logs) {
    // Standard Transfer: 3 topics + uint256 data. Other logs with the same topic but a different shape are skipped.
    if (l.topics.length !== 3 || !l.data || l.data.length < 66) continue;
    transfers.push({
      from: getAddress(topicAddr(l.topics[1])),
      to: getAddress(topicAddr(l.topics[2])),
      value: BigInt(l.data.slice(0, 66)),
      txHash: l.transactionHash,
      blockNumber: Number(BigInt(l.blockNumber)),
      txIndex: Number(BigInt(l.transactionIndex ?? 0)),
      logIndex: Number(BigInt(l.logIndex ?? 0)),
    });
  }
  return { transfers, complete: res.complete, reason: res.reason, scannedTo: res.scannedTo };
}

/**
 * Reconstruct balances from transfers (pure function). The zero address is not counted as a holder.
 * @returns {{balances: Map<string, bigint>, minted: bigint, burnedToZero: bigint, negative: string[]}}
 */
export function computeBalances(transfers) {
  const balances = new Map();
  let minted = 0n;
  let burnedToZero = 0n;
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from === ZERO) minted += t.value;
    else balances.set(from, (balances.get(from) ?? 0n) - t.value);
    if (to === ZERO) burnedToZero += t.value;
    else balances.set(to, (balances.get(to) ?? 0n) + t.value);
  }
  // Negative balances indicate incomplete data (early transfers not observed) or a non-standard token.
  const negative = [...balances.entries()].filter(([, v]) => v < 0n).map(([k]) => k);
  return { balances, minted, burnedToZero, negative };
}

/**
 * Holder classification & percentages (pure function).
 * @param {{balances: Map<string,bigint>, totalSupply: bigint, labels: any, contracts: Set<string>, extraLabels?: Map<string,{label:string, kind:string}>}} p
 */
export function computeDistribution({ balances, totalSupply, labels, contracts = new Set(), extraLabels = new Map() }) {
  const holders = [];
  for (const [addr, bal] of balances) {
    if (bal <= 0n) continue;
    const extra = extraLabels.get(addr);
    const reg = labels.get(addr);
    let category = 'WALLET';
    let label = null;
    if (extra) {
      category = extra.kind;
      label = extra.label;
    } else if (reg) {
      category = reg.kind;
      label = reg.label;
    } else if (contracts.has(addr)) {
      category = 'CONTRACT';
    }
    holders.push({ address: getAddress(addr), balance: bal, pct: totalSupply ? ratioPct(bal, totalSupply) : null, category, label });
  }
  holders.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  const sum = (list) => list.reduce((s, h) => s + h.balance, 0n);
  const wallets = holders.filter((h) => h.category === 'WALLET');
  const infraKinds = new Set(['PROTOCOL', 'ROUTER', 'DEX', 'BURN', 'CURVE', 'EXCHANGE', 'BRIDGE', 'SERVICE']);
  const infra = holders.filter((h) => infraKinds.has(h.category));
  const contractsHeld = holders.filter((h) => h.category === 'CONTRACT');
  const top10Wallets = wallets.slice(0, 10);
  const pctOf = (v) => (totalSupply ? ratioPct(v, totalSupply) : null);

  return {
    holderCount: holders.length,
    walletHolderCount: wallets.length,
    holders,
    top10WalletPct: pctOf(sum(top10Wallets)),
    largestWalletPct: wallets[0] ? wallets[0].pct : null,
    infraPct: pctOf(sum(infra)),
    burnPct: pctOf(sum(holders.filter((h) => h.category === 'BURN'))),
    lpAndCurvePct: pctOf(sum(holders.filter((h) => h.category === 'DEX' || h.category === 'CURVE'))),
    unlabeledContractPct: pctOf(sum(contractsHeld)),
  };
}

/**
 * Full holder analysis: fetch transfers → reconstruct → flag contracts → cross-check balanceOf.
 */
export async function analyzeHolders({ rpc, token, tokenInfo, fromBlock, latestBlock, labels, extraLabels, chunkSize, deadline, maxLogs, crossCheckTop = 15, sampleTop = 150, extraCandidates = [], onProgress, isCancelled }) {
  if (tokenInfo.totalSupply == null) {
    return { status: 'UNAVAILABLE', reason: 'totalSupply could not be read', transfers: [], distribution: null, balances: new Map() };
  }
  if (fromBlock == null) {
    return { status: 'UNAVAILABLE', reason: 'Deployment block unknown; the log range cannot be determined', transfers: [], distribution: null, balances: new Map() };
  }
  const fetched = await fetchTransfers(rpc, token, { fromBlock, toBlock: latestBlock, chunkSize, deadline, maxLogs, onProgress, isCancelled });
  const { balances, minted, negative } = computeBalances(fetched.transfers);

  // Flag contracts among the top holders (getCode) so LPs/contracts are not counted as wallets.
  const ranked = [...balances.entries()].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const toCheck = ranked.slice(0, 40).map(([a]) => a);
  const contracts = new Set();
  const lim = createLimiter({ concurrency: 4 });
  await mapLimit(toCheck, lim, async (a) => {
    if (labels.get(a) || extraLabels?.get(a)) return;
    try {
      const code = await rpc.getCode(a);
      if (code && code !== '0x') contracts.add(a);
    } catch {
      /* check failed → keep it as a wallet; recorded via coverage */
    }
  });

  // Cross-check reconstructed balances vs balanceOf (latest). A difference = non-standard token or incomplete data.
  const mismatches = [];
  await mapLimit(ranked.slice(0, crossCheckTop), lim, async ([a, v]) => {
    const onchain = await readBalance(rpc, token, a);
    if (onchain != null && onchain !== v) mismatches.push({ address: getAddress(a), reconstructed: v, onchain });
  });

  const complete = fetched.complete && negative.length === 0 && mismatches.length === 0;
  const notes = [];

  // Incomplete data → reconstructed balances may be stale. Recompute from balanceOf (latest) for
  // a sample of observed addresses (top reconstructed holders + extra addresses, e.g. early buyers).
  let effectiveBalances = balances;
  let sampleSize = null;
  if (!complete) {
    const candidates = [...new Set([...ranked.slice(0, sampleTop).map(([a]) => a), ...extraCandidates.map((a) => a.toLowerCase())])];
    const sampled = new Map();
    await mapLimit(candidates, lim, async (a) => {
      const onchain = await readBalance(rpc, token, a);
      if (onchain != null && onchain > 0n) sampled.set(a, onchain);
    });
    // Contracts among the sample that have not been checked yet.
    await mapLimit([...sampled.keys()].filter((a) => !contracts.has(a) && !labels.get(a) && !extraLabels?.get(a) && !toCheck.includes(a)), lim, async (a) => {
      try {
        const code = await rpc.getCode(a);
        if (code && code !== '0x') contracts.add(a);
      } catch {
        /* keep it as a wallet */
      }
    });
    effectiveBalances = sampled;
    sampleSize = candidates.length;
    notes.push(`PARTIAL DATA: distribution computed from on-chain balances (balanceOf) of ${sampled.size} funded addresses out of a sample of ${candidates.length} observed addresses; the total holder count is unknown.`);
  }

  const distribution = computeDistribution({ balances: effectiveBalances, totalSupply: tokenInfo.totalSupply, labels, contracts, extraLabels });
  if (!complete) {
    distribution.sampleMode = true;
    distribution.observedAddressCount = balances.size;
    distribution.holderCount = null;
  }
  if (!fetched.complete) notes.push(`Transfer fetching stopped before finishing (${fetched.reason}); only up to block ${fetched.scannedTo}.`);
  if (negative.length) notes.push(`${negative.length} address(es) with a negative reconstructed balance (indicates incomplete data/non-standard token).`);
  if (mismatches.length) notes.push(`${mismatches.length} of the top ${Math.min(crossCheckTop, ranked.length)} balances do not match balanceOf (possibly rebase/fee-on-transfer/partial data).`);
  if (minted !== tokenInfo.totalSupply) notes.push('The observed total minted differs from the current totalSupply (possibly due to burns, later mints, or partial data).');

  return {
    status: complete ? 'COMPLETE' : 'PARTIAL',
    transfers: fetched.transfers,
    transferCount: fetched.transfers.length,
    scannedRange: { fromBlock, toBlock: fetched.scannedTo },
    sampleSize,
    // Balances used by the cluster analysis: full reconstruction, or sampled on-chain balances.
    balances: effectiveBalances,
    contracts,
    minted,
    mismatches,
    distribution,
    notes,
  };
}
