// Standalone wallet analysis (menus 2 & 3), reusing the funding graph and cluster detection.
import { formatEther } from 'ethers';
import { DataUnavailableError, NetworkMismatchError } from '../utils/errors.js';
import { normalizeAddress } from '../utils/validation.js';
import { buildFundingGraph } from './fundingGraph.js';
import { detectClusters } from './walletCluster.js';
import { findPonsLaunchesByDeployer } from '../adapters/evm/ponsAdapter.js';
import { readTokenInfo } from '../adapters/evm/tokenAdapter.js';
import { EXPLORER_KEY_ENV } from '../config/env.js';

async function verifyNetwork(rpc, config) {
  const actual = await rpc.chainId();
  if (actual !== config.chainId) throw new NetworkMismatchError(config.chainId, actual);
}

/**
 * Menu 2: find funding correlations among a list of wallets. Requires the explorer because
 * native-coin transfers cannot be fetched from a standard RPC.
 */
export async function analyzeWalletSet({ rpc, explorer, config, wallets, labels, onStage = () => {}, signal }) {
  if (!explorer) {
    throw new DataUnavailableError(`Wallet cluster analysis requires ${EXPLORER_KEY_ENV} (${config.network?.nativeSymbol ?? 'native'} transfer history is not available via RPC).`, {
      hint: 'Get an API key (Blockscout: https://dev.blockscout.com, Etherscan: https://etherscan.io/apis) and put it in your config file (ring-hunter check shows where).',
    });
  }
  onStage('network', 'start');
  await verifyNetwork(rpc, config);
  onStage('network', 'done');
  onStage('funding', 'start');
  const list = wallets.map((w) => normalizeAddress(w));
  const funding = await buildFundingGraph({ rpc, traders: list.map((a) => ({ address: a })), trades: [], transfers: [], deployer: null, explorer, labels, maxLookups: list.length, isCancelled: () => !!signal?.aborted });
  onStage('funding', 'done', `${funding.graph.edges.length} edges`);
  onStage('clusters', 'start');
  const result = detectClusters({ graph: funding.graph, interest: funding.interest, funderProfiles: funding.funderProfiles, traders: [], labels, coverage: funding.coverage });
  onStage('clusters', 'done', `${result.clusters.length} clusters`);
  return { wallets: list, funding, ...result };
}

/**
 * Menu 3: developer wallet profile. Pons launches (Robinhood Chain) can be found via RPC (deployer topic);
 * native-coin funding sources & recipients require the explorer.
 */
export async function analyzeDeveloperWallet({ rpc, explorer, config, address, labels = null, onStage = () => {}, signal }) {
  const dev = normalizeAddress(address, 'Developer address');
  onStage('network', 'start');
  await verifyNetwork(rpc, config);
  const latestBlock = await rpc.blockNumber();
  onStage('network', 'done');

  onStage('token', 'start');
  const [code, nonce, balanceHex] = await Promise.all([rpc.getCode(dev), rpc.getTransactionCount(dev), rpc.request('eth_getBalance', [dev, 'latest'])]);
  onStage('token', 'done');

  onStage('origin', 'start');
  const hasPons = !!(config.network?.protocols?.pons ?? true);
  const pons = hasPons ? await findPonsLaunchesByDeployer(rpc, dev, { fromBlock: 0, toBlock: latestBlock, isCancelled: () => !!signal?.aborted }) : { launches: [], complete: true };
  const launches = [];
  for (const l of pons.launches.slice(-20)) {
    let info = null;
    try {
      info = await readTokenInfo(rpc, l.token);
    } catch {
      /* metadata is optional */
    }
    launches.push({ ...l, name: info?.name ?? null, symbol: info?.symbol ?? null });
  }
  onStage('origin', 'done', hasPons ? `${pons.launches.length} Pons launches` : 'no launchpad decoder on this network');

  let funding = null;
  const limitations = [];
  if (explorer) {
    onStage('funding', 'start');
    try {
      const [normal, internal] = await Promise.all([explorer.txList(dev, { offset: 500 }), explorer.internalTxList(dev, { offset: 500 })]);
      const all = [...normal, ...internal].filter((t) => !t.isError && t.value > 0n);
      const incoming = all.filter((t) => t.to && t.to.toLowerCase() === dev.toLowerCase());
      const outgoing = all.filter((t) => t.from && t.from.toLowerCase() === dev.toLowerCase());
      const agg = (txs, key) => {
        const m = new Map();
        for (const t of txs) {
          const k = t[key];
          if (!m.has(k)) m.set(k, { address: k, count: 0, total: 0n, firstTx: t.hash, label: labels?.get(k)?.label ?? null });
          const e = m.get(k);
          e.count++;
          e.total += t.value;
        }
        return [...m.values()].sort((a, b) => (b.total > a.total ? 1 : -1)).slice(0, 15);
      };
      funding = { firstIncoming: incoming.slice(0, 5), topFunders: agg(incoming, 'from'), topRecipients: agg(outgoing, 'to'), sampled: all.length };
      if (normal.length >= 500) limitations.push('Transaction history truncated at the first 500 transactions.');
    } catch (e) {
      limitations.push(`Explorer failed: ${e.message}`);
    }
    onStage('funding', 'done');
  } else {
    limitations.push(`Without ${EXPLORER_KEY_ENV}: the developer's ${config.network?.nativeSymbol ?? 'native-coin'} funding sources and recipients cannot be shown.`);
  }
  if (!pons.complete) limitations.push('Pons launch search did not complete.');

  return {
    address: dev,
    isContract: code && code !== '0x',
    nonce,
    balanceEth: formatEther(BigInt(balanceHex)),
    nativeSymbol: config.network?.nativeSymbol ?? 'ETH',
    ponsLaunchCount: hasPons ? pons.launches.length : null,
    launches,
    funding,
    latestBlock,
    limitations,
  };
}

