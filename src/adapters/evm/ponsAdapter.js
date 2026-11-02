// Pons v2 adapter (launchpad on Robinhood Chain). Only reads events whose signatures are verified.
import { getAddress } from 'ethers';
import { PONS } from '../../config/networks.js';
import { PONS_FACTORY, PONS_CURVE, TOPICS, addrTopic } from './abis.js';

const ref = (l) => ({
  txHash: l.transactionHash,
  blockNumber: Number(BigInt(l.blockNumber)),
  txIndex: Number(BigInt(l.transactionIndex ?? 0)),
  logIndex: Number(BigInt(l.logIndex ?? 0)),
});

/**
 * Find the TokenLaunched event for a given token (topic1 = token). Returns null if the token
 * was not launched via the Pons v2 Factory.
 */
export async function findPonsLaunch(rpc, token, { latestBlock, isCancelled } = {}) {
  const logs = await rpc.findLogsBackward({
    address: PONS.factory,
    topics: [TOPICS.TokenLaunched, addrTopic(token)],
    toBlock: latestBlock,
    isCancelled,
  });
  if (!logs.length) return null;
  const l = logs[0];
  const ev = PONS_FACTORY.parseLog(l);
  return {
    protocol: 'PONS_V2',
    token: getAddress(ev.args.token),
    curve: getAddress(ev.args.curve),
    deployer: getAddress(ev.args.deployer),
    pairToken: getAddress(ev.args.pairToken),
    pairIsNative: /^0x0{40}$/i.test(ev.args.pairToken),
    launchConfigId: ev.args.launchConfigId.toString(),
    graduationThreshold: ev.args.graduationThreshold.toString(),
    ...ref(l),
    evidence: 'Pons Factory TokenLaunched',
  };
}

/** Pons launches by a given deployer (topic3 = deployer). Used in the developer wallet analysis. */
export async function findPonsLaunchesByDeployer(rpc, deployer, { fromBlock = 0, toBlock, chunkSize, deadline, isCancelled } = {}) {
  const res = await rpc.getLogsChunked({
    address: PONS.factory,
    topics: [TOPICS.TokenLaunched, null, null, addrTopic(deployer)],
    fromBlock,
    toBlock,
    chunkSize: chunkSize ?? 9_000_000,
    deadline,
    isCancelled,
  });
  return {
    complete: res.complete,
    launches: res.logs.map((l) => {
      const ev = PONS_FACTORY.parseLog(l);
      return { token: getAddress(ev.args.token), curve: getAddress(ev.args.curve), ...ref(l) };
    }),
  };
}

/** CurveBuy / CurveSell events from one token's curve, ascending. */
export async function getCurveTrades(rpc, curve, { fromBlock, toBlock, maxLogs = 500, chunkSize, deadline, isCancelled }) {
  const res = await rpc.getLogsChunked({
    address: curve,
    topics: [[TOPICS.CurveBuy, TOPICS.CurveSell]],
    fromBlock,
    toBlock,
    chunkSize,
    deadline,
    maxLogs,
    isCancelled,
  });
  const trades = res.logs.map((l) => {
    const ev = PONS_CURVE.parseLog(l);
    const isBuy = ev.name === 'CurveBuy';
    // Verified on real data: the buyer/seller field often holds a router contract (msg.sender),
    // not the user's wallet. The actor is attributed from the receipt by transactionScanner.attributeTrade().
    return {
      venue: 'PONS_CURVE',
      side: isBuy ? 'BUY' : 'SELL',
      trader: null,
      eventActor: getAddress(isBuy ? ev.args.buyer : ev.args.seller),
      recipient: getAddress(ev.args.recipient),
      tokenAmount: (isBuy ? ev.args.tokensOut : ev.args.tokensIn).toString(),
      quoteAmount: (isBuy ? ev.args.quoteIn : ev.args.quoteOut).toString(),
      fee: ev.args.fee.toString(),
      tax: ev.args.tax.toString(),
      attribution: 'pending', // filled in by attributeTrade() from the receipt
      ...ref(l),
    };
  });
  return { trades, complete: res.complete, reason: res.reason };
}
