// Token creator/deployer detection. Creator, deployer, owner, admin, and fee recipient can differ —
// this module only reports a creator if it can be proven from deployment data.
import { getAddress } from 'ethers';
import { findPonsLaunch } from '../adapters/evm/ponsAdapter.js';
import { TOPICS, addrTopic } from '../adapters/evm/abis.js';
import { DataUnavailableError } from '../utils/errors.js';
import { EXPLORER_KEY_ENV } from '../config/env.js';

const ZERO_TOPIC = addrTopic('0x0000000000000000000000000000000000000000');

/**
 * @returns {Promise<{status:'VERIFIED'|'INDICATIVE'|'UNKNOWN', method:string|null, creator:string|null,
 *   deployTxHash:string|null, deployBlock:number|null, launch:object|null, notes:string[]}>}
 */
export async function detectOrigin({ rpc, explorer, token, latestBlock, deadline = null, isCancelled }) {
  const notes = [];

  // 1) Pons v2: TokenLaunched from the Factory is strong proof of launch.
  const launch = await findPonsLaunch(rpc, token, { latestBlock, isCancelled });
  if (launch) {
    let txFrom = null;
    try {
      const tx = await rpc.getTransaction(launch.txHash);
      txFrom = tx?.from ? getAddress(tx.from) : null;
    } catch {
      notes.push('launch tx could not be fetched to confirm tx.from');
    }
    if (txFrom && txFrom.toLowerCase() !== launch.deployer.toLowerCase()) {
      notes.push(`deployer in the event (${launch.deployer}) differs from the tx sender (${txFrom})`);
    }
    return {
      status: 'VERIFIED',
      method: 'PONS_TOKEN_LAUNCHED',
      creator: launch.deployer,
      launchTxSender: txFrom,
      deployTxHash: launch.txHash,
      deployBlock: launch.blockNumber,
      launch,
      notes,
    };
  }
  notes.push('Token not found as a launch in the Pons v2 Factory.');

  // 2) Explorer (if configured): contract creation data from the indexer.
  if (explorer) {
    try {
      const c = await explorer.contractCreation(token);
      if (c.creator) {
        let deployBlock = c.blockNumber;
        if (deployBlock == null && c.txHash) {
          const tx = await rpc.getTransaction(c.txHash).catch(() => null);
          deployBlock = tx?.blockNumber != null ? Number(BigInt(tx.blockNumber)) : null;
        }
        return { status: 'VERIFIED', method: 'EXPLORER_CONTRACT_CREATION', creator: c.creator, launchTxSender: c.creator, deployTxHash: c.txHash, deployBlock, launch: null, notes };
      }
    } catch (e) {
      notes.push(`Explorer failed to provide creator data: ${e.message}`);
    }
  } else {
    notes.push(`${EXPLORER_KEY_ENV} is not set: the token creator cannot be read from an indexer.`);
  }

  // 3) Indication: the first mint transaction (Transfer from 0x0). This tx's sender is NOT NECESSARILY the deployer.
  let res;
  try {
    res = await rpc.getLogsChunked({
      address: token,
      topics: [TOPICS.Transfer, ZERO_TOPIC],
      fromBlock: 0,
      toBlock: latestBlock,
      chunkSize: 9_000_000,
      maxLogs: 1,
      deadline,
      isCancelled,
    });
  } catch (e) {
    // Some RPCs only serve recent logs (e.g. free public endpoints); the scan continues without an origin.
    if (!(e instanceof DataUnavailableError)) throw e;
    notes.push(`The RPC does not serve old logs (${e.message}); the first mint cannot be searched. Use an RPC with full log history or an explorer API key.`);
    return { status: 'UNKNOWN', method: null, creator: null, launchTxSender: null, deployTxHash: null, deployBlock: null, launch: null, notes };
  }
  if (res.logs.length) {
    const first = res.logs[0];
    let sender = null;
    try {
      sender = getAddress((await rpc.getTransaction(first.transactionHash)).from);
    } catch {
      /* left as null */
    }
    notes.push('Creator indicated by the sender of the first mint transaction — not proof of the deployer.');
    return {
      status: 'INDICATIVE',
      method: 'FIRST_MINT_TX_SENDER',
      creator: sender,
      launchTxSender: sender,
      deployTxHash: first.transactionHash,
      deployBlock: Number(BigInt(first.blockNumber)),
      launch: null,
      notes,
    };
  }
  if (res.reason === 'deadline') notes.push('The search for the first mint ran out of time; set an explorer API key or use an archive RPC.');
  return { status: 'UNKNOWN', method: null, creator: null, launchTxSender: null, deployTxHash: null, deployBlock: null, launch: null, notes };
}

