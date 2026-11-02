// Mock EVM chain for testing. ALL DATA HERE IS SYNTHETIC — not real on-chain data.
// Addresses are built from numbers (e.g. 0x…a001) so they are clearly fake. The transport mimics Robinhood RPC limits
// (getLogs range ≤ 10,000,000 blocks, ≤ 10,000 logs) so the chunking logic is tested too.
import { ERC20, PONS_FACTORY, PONS_CURVE, V4_POOL_MANAGER, OWNABLE } from '../../src/adapters/evm/abis.js';
import { RpcError } from '../../src/utils/errors.js';
import { classifyRpcError } from '../../src/adapters/evm/rpcClient.js';

export const SYNTHETIC = true;

/** Clearly fake synthetic address: A(0xa001) → 0x000…a001 */
export const A = (n) => '0x' + n.toString(16).padStart(40, '0');
export const H = (n) => '0x' + n.toString(16).padStart(64, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);

export function createMockChain({ chainId = 4663, latestBlock = 1_000_000, maxRange = 10_000_000, maxLogs = 10_000 } = {}) {
  const codes = new Map();
  const storage = new Map();
  const calls = new Map(); // `${to}|${selector}` → hex result or function(data)
  const logs = [];
  const txs = new Map();
  const nonces = new Map();
  const balances = new Map();
  let txCounter = 1;
  const failures = { timeoutOnce: new Set(), alwaysFail: new Set() };

  const chain = {
    chainId,
    latestBlock,
    setCode: (addr, code = '0x6080604052') => codes.set(addr.toLowerCase(), code),
    setStorage: (addr, slot, value) => storage.set(`${addr.toLowerCase()}|${slot}`, value),
    setCall: (to, iface, fn, values) => {
      const sel = iface.getFunction(fn).selector;
      calls.set(`${to.toLowerCase()}|${sel}`, typeof values === 'function' ? values : iface.encodeFunctionResult(fn, values));
    },
    setNonce: (addr, n) => nonces.set(addr.toLowerCase(), n),
    failMethod: (m) => failures.alwaysFail.add(m),

    /** Add an event log; returns the log object. The tx is created automatically if missing. */
    addLog({ address, iface, event, args, blockNumber, txHash, from, to, logIndex }) {
      const { topics, data } = iface.encodeEventLog(iface.getEvent(event), args);
      const hash = txHash ?? H(0x7000 + txCounter++);
      if (!txs.has(hash)) txs.set(hash, { hash, from: from ?? A(0xeee), to: to ?? address, blockNumber, logs: [], txIndex: txs.size });
      const tx = txs.get(hash);
      const log = { address, topics, data, blockNumber: hex(blockNumber), transactionHash: hash, transactionIndex: hex(tx.txIndex), logIndex: hex(logIndex ?? logs.length) };
      tx.logs.push(log);
      logs.push(log);
      return log;
    },
    transfer(token, from, to, value, blockNumber, opts = {}) {
      return chain.addLog({ address: token, iface: ERC20, event: 'Transfer', args: [from, to, value], blockNumber, ...opts });
    },
    erc20(token, { name = 'Synthetic Test Token', symbol = 'SYN', decimals = 18, totalSupply, balanceOf = {} }) {
      // Do not overwrite bytecode that is already set (e.g. a token with a mint selector).
      if (!codes.has(token.toLowerCase())) chain.setCode(token);
      chain.setCall(token, ERC20, 'name', [name]);
      chain.setCall(token, ERC20, 'symbol', [symbol]);
      chain.setCall(token, ERC20, 'decimals', [decimals]);
      chain.setCall(token, ERC20, 'totalSupply', [totalSupply]);
      for (const [k, v] of Object.entries(balanceOf)) balances.set(`${token.toLowerCase()}|${k.toLowerCase()}`, v);
      const sel = ERC20.getFunction('balanceOf').selector;
      calls.set(`${token.toLowerCase()}|${sel}`, (data) => {
        const [holder] = ERC20.decodeFunctionData('balanceOf', data);
        return ERC20.encodeFunctionResult('balanceOf', [balances.get(`${token.toLowerCase()}|${holder.toLowerCase()}`) ?? 0n]);
      });
    },
    setBalance: (token, holder, v) => balances.set(`${token.toLowerCase()}|${holder.toLowerCase()}`, v),
    owner(token, owner) {
      chain.setCall(token, OWNABLE, 'owner', [owner]);
    },
    ifaces: { ERC20, PONS_FACTORY, PONS_CURVE, V4_POOL_MANAGER },
  };

  function matchTopics(log, topics = []) {
    return topics.every((t, i) => {
      if (t == null) return true;
      const v = log.topics[i]?.toLowerCase();
      return Array.isArray(t) ? t.some((x) => x.toLowerCase() === v) : t.toLowerCase() === v;
    });
  }

  chain.transport = {
    async send(method, params) {
      if (failures.alwaysFail.has(method)) throw new RpcError(`RPC timeout (mock) ${method}`, { retryable: true });
      switch (method) {
        case 'eth_chainId':
          return hex(chain.chainId);
        case 'eth_blockNumber':
          return hex(chain.latestBlock);
        case 'eth_getCode':
          return codes.get(params[0].toLowerCase()) ?? '0x';
        case 'eth_getStorageAt':
          return storage.get(`${params[0].toLowerCase()}|${params[1]}`) ?? '0x' + '0'.repeat(64);
        case 'eth_getTransactionCount':
          return hex(nonces.get(params[0].toLowerCase()) ?? 1);
        case 'eth_getBalance':
          return '0x0';
        case 'eth_call': {
          const { to, data } = params[0];
          const v = calls.get(`${to.toLowerCase()}|${data.slice(0, 10)}`);
          if (v == null) throw classifyRpcError('eth_call', { code: 3, message: 'execution reverted' });
          return typeof v === 'function' ? v(data) : v;
        }
        case 'eth_getLogs': {
          const f = params[0];
          const from = Number(BigInt(f.fromBlock));
          const to = f.toBlock === 'latest' ? chain.latestBlock : Number(BigInt(f.toBlock));
          if (to - from + 1 > maxRange) throw classifyRpcError('eth_getLogs', { code: -32602, message: `query spans ${to - from + 1} blocks, but only ${maxRange} are allowed` });
          const addr = f.address?.toLowerCase();
          const out = logs.filter((l) => (!addr || l.address.toLowerCase() === addr) && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to && matchTopics(l, f.topics));
          if (out.length > maxLogs) throw classifyRpcError('eth_getLogs', { code: -32000, message: `logs matched by query exceeds limit of ${maxLogs}` });
          return out.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
        }
        case 'eth_getTransactionByHash': {
          const t = txs.get(params[0]);
          return t ? { hash: t.hash, from: t.from, to: t.to, blockNumber: hex(t.blockNumber) } : null;
        }
        case 'eth_getTransactionReceipt': {
          const t = txs.get(params[0]);
          return t ? { transactionHash: t.hash, from: t.from, to: t.to, blockNumber: hex(t.blockNumber), logs: t.logs } : null;
        }
        case 'eth_getBlockByNumber':
          return { number: params[0], timestamp: hex(1_700_000_000 + Number(BigInt(params[0])) * 2) };
        default:
          throw new RpcError(`mock: method ${method} is not implemented`);
      }
    },
  };
  return chain;
}

/** Fake explorer client: native tx history per address. */
export function createMockExplorer(txsByAddress = {}) {
  const norm = Object.fromEntries(Object.entries(txsByAddress).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    source: 'mock-explorer',
    async txList(address) {
      return (norm[address.toLowerCase()] ?? []).filter((t) => t.kind !== 'INTERNAL');
    },
    async internalTxList(address) {
      return (norm[address.toLowerCase()] ?? []).filter((t) => t.kind === 'INTERNAL');
    },
    async contractCreation() {
      throw new Error('mock: no creation data');
    },
  };
}

/** Synthetic native tx for the fake explorer. */
export const nativeTx = (n, from, to, valueEth, blockNumber, kind = 'NATIVE') => ({
  kind,
  hash: H(0x9000 + n),
  blockNumber,
  timestamp: 1_700_000_000 + blockNumber * 2,
  from,
  to,
  value: BigInt(Math.round(valueEth * 1e6)) * 10n ** 12n,
  isError: false,
});
