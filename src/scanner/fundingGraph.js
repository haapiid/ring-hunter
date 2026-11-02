// Funding graph: node = address, edge = an OBSERVED transaction relationship. Each edge stores evidence
// (tx hash, block, asset, amount, data source, verification status). No guessed edges.
import { getAddress } from 'ethers';
import { lc } from '../utils/validation.js';
import { mapLimit, createLimiter } from '../utils/rateLimiter.js';

export const RELATIONS = Object.freeze({
  NATIVE_FUNDING: 'NATIVE_FUNDING', // direct ETH transfer (from the explorer)
  INTERNAL_FUNDING: 'INTERNAL_FUNDING', // ETH from a contract (internal tx, from the explorer)
  TOKEN_TRANSFER: 'TOKEN_TRANSFER', // transfer of the analyzed token between wallets (from logs)
  // Tx sender ≠ token owner in a trade: buying for another wallet, or selling another wallet's tokens
  // via approval (from the swap receipt). Moving someone else's tokens requires their approval.
  EXECUTED_FOR_OTHER: 'EXECUTED_FOR_OTHER',
});

/** Simple Map-based graph with edge dedup per (relation, txHash, from, to, logIndex). */
export function createGraph() {
  const nodes = new Map();
  const edges = [];
  const seen = new Set();
  return {
    nodes,
    edges,
    addNode(address, role) {
      const k = lc(address);
      if (!nodes.has(k)) nodes.set(k, { address: getAddress(k), roles: new Set() });
      if (role) nodes.get(k).roles.add(role);
      return nodes.get(k);
    },
    addEdge(e) {
      const key = `${e.relation}|${e.txHash}|${lc(e.from)}|${lc(e.to)}|${e.logIndex ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      this.addNode(e.from);
      this.addNode(e.to);
      edges.push({
        from: getAddress(lc(e.from)),
        to: getAddress(lc(e.to)),
        txHash: e.txHash,
        blockNumber: e.blockNumber,
        timestamp: e.timestamp ?? null,
        asset: e.asset,
        amount: e.amount != null ? String(e.amount) : null,
        relation: e.relation,
        source: e.source,
        verification: e.verification ?? 'OBSERVED',
        logIndex: e.logIndex ?? null,
      });
      return true;
    },
    incoming: (address) => edges.filter((x) => lc(x.to) === lc(address)),
    outgoing: (address) => edges.filter((x) => lc(x.from) === lc(address)),
  };
}

/**
 * Build the funding graph for wallets of interest (deployer, early buyers, top holders).
 * @param {object} p
 * @param {{address:string, firstBuy:object|null, recipients:string[]}[]} p.traders
 * @param {object[]} p.trades early trades (for EXECUTED_FOR_OTHER)
 * @param {object[]} p.transfers all token Transfers that were fetched
 * @param {string|null} p.deployer
 * @param {string[]} p.topHolders
 * @param {object|null} p.explorer optional explorer client
 * @param {any} p.labels label registry
 * @param {string} p.tokenSymbol
 * @param {string} [p.nativeSymbol] native coin of the network (ETH, BNB)
 */
export async function buildFundingGraph({ rpc, traders, trades, transfers, deployer, topHolders = [], explorer, labels, tokenSymbol = 'TOKEN', nativeSymbol = 'ETH', explorerKeyHint = 'BLOCK_EXPLORER_API_KEY', maxLookups = 30, txPerWallet = 200, isCancelled }) {
  const g = createGraph();
  const interest = new Set();
  const mark = (a, role) => {
    if (!a || labels.isPublicInfra(a)) return;
    g.addNode(a, role);
    interest.add(lc(a));
  };
  if (deployer) mark(deployer, 'DEPLOYER');
  for (const t of traders) mark(t.address, 'EARLY_TRADER');
  for (const h of topHolders) mark(h, 'TOP_HOLDER');

  // 1) EXECUTED_FOR_OTHER from swap receipts: tx sender ≠ owner of the bought/sold tokens.
  for (const t of trades) {
    if (!t.executedForOther || !t.txFrom || !t.trader) continue;
    if (labels.isPublicInfra(t.txFrom) || labels.isPublicInfra(t.trader)) continue;
    mark(t.txFrom, 'TX_SENDER');
    g.addEdge({
      from: t.txFrom,
      to: t.trader,
      txHash: t.txHash,
      blockNumber: t.blockNumber,
      timestamp: t.timestamp,
      asset: tokenSymbol,
      amount: t.tokenAmount,
      relation: RELATIONS.EXECUTED_FOR_OTHER,
      source: 'rpc-receipt',
      verification: t.side === 'SELL' ? 'OBSERVED (sold tokens owned by another wallet; requires approval)' : 'OBSERVED (bought for another wallet)',
      logIndex: t.logIndex,
    });
  }

  // 2) TOKEN_TRANSFER between wallets of interest (not transfers from/to infrastructure or trades).
  for (const t of transfers) {
    const f = lc(t.from);
    const to = lc(t.to);
    if (!interest.has(f) && !interest.has(to)) continue;
    if (labels.isPublicInfra(t.from) || labels.isPublicInfra(t.to)) continue;
    if (/^0x0{40}$/.test(f) || /^0x0{40}$/.test(to)) continue;
    // Only relationships between two wallets of interest, so the graph stays focused on internal links.
    if (!(interest.has(f) && interest.has(to))) continue;
    g.addEdge({ from: t.from, to: t.to, txHash: t.txHash, blockNumber: t.blockNumber, asset: tokenSymbol, amount: t.value, relation: RELATIONS.TOKEN_TRANSFER, source: 'rpc-log', logIndex: t.logIndex });
  }

  // 3) Native & internal ETH funding from the explorer (RPC cannot provide this).
  const lookups = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  if (explorer) {
    const targets = [...interest].slice(0, maxLookups);
    lookups.skipped = Math.max(0, interest.size - targets.length);
    const lim = createLimiter({ concurrency: 2 });
    await mapLimit(targets, lim, async (addr) => {
      if (isCancelled?.()) return;
      lookups.attempted++;
      try {
        const [normal, internal] = await Promise.all([explorer.txList(addr, { offset: txPerWallet }), explorer.internalTxList(addr, { offset: txPerWallet })]);
        for (const tx of [...normal, ...internal]) {
          if (tx.isError || tx.value <= 0n || !tx.from || !tx.to) continue;
          const incoming = lc(tx.to) === addr;
          const outgoingToInterest = lc(tx.from) === addr && interest.has(lc(tx.to));
          if (!incoming && !outgoingToInterest) continue;
          g.addEdge({
            from: tx.from,
            to: tx.to,
            txHash: tx.hash,
            blockNumber: tx.blockNumber,
            timestamp: tx.timestamp,
            asset: nativeSymbol,
            amount: tx.value,
            relation: tx.kind === 'INTERNAL' ? RELATIONS.INTERNAL_FUNDING : RELATIONS.NATIVE_FUNDING,
            source: explorer.source,
          });
        }
        lookups.succeeded++;
      } catch {
        lookups.failed++;
      }
    });
  }

  // 4) Profiles of funders that funded ≥2 wallets of interest: nonce & contract → public service detection.
  const funders = new Map();
  for (const e of g.edges) {
    if (e.relation !== RELATIONS.NATIVE_FUNDING && e.relation !== RELATIONS.INTERNAL_FUNDING) continue;
    if (!interest.has(lc(e.to))) continue;
    const k = lc(e.from);
    if (!funders.has(k)) funders.set(k, new Set());
    funders.get(k).add(lc(e.to));
  }
  const funderProfiles = new Map();
  const multi = [...funders.entries()].filter(([, s]) => s.size >= 2);
  const lim2 = createLimiter({ concurrency: 3 });
  await mapLimit(multi, lim2, async ([f, recips]) => {
    const profile = { address: getAddress(f), fundedInterestWallets: recips.size, nonce: null, isContract: null, label: labels.get(f) };
    try {
      profile.nonce = await rpc.getTransactionCount(f);
    } catch {
      /* null = unknown */
    }
    try {
      const code = await rpc.getCode(f);
      profile.isContract = !!code && code !== '0x';
    } catch {
      /* null */
    }
    funderProfiles.set(f, profile);
  });

  const nativeCoverage = explorer ? (lookups.failed === 0 && lookups.skipped === 0 ? 'COMPLETE_FOR_TARGETS' : 'PARTIAL') : 'NONE';
  return {
    graph: g,
    interest,
    funderProfiles,
    coverage: {
      tokenTransfers: transfers.length ? 'FROM_FETCHED_LOGS' : 'NONE',
      nativeFunding: nativeCoverage,
      explorerLookups: lookups,
      note: explorer ? null : `Native ${nativeSymbol} transfers produce no logs; without ${explorerKeyHint}, ${nativeSymbol} funding sources are not observed (PARTIAL DATA).`,
    },
  };
}
