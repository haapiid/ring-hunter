// DEX decoding & discovery on SYNTHETIC logs (mock chain). Sign conventions are the part most likely to be wrong:
// V2 uses in/out amounts, V3 amounts are from the pool's side, V4 deltas are from the swapper's side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockChain, A } from '../helpers/mockChain.js';
import { createRpcClient } from '../../src/adapters/evm/rpcClient.js';
import { V2_FACTORY, V2_PAIR, V3_FACTORY, V3_POOL, V4_POOL_MANAGER } from '../../src/adapters/evm/abis.js';
import { decodeSwap, findPools, getSwaps, selectPrimaryPools } from '../../src/adapters/evm/dexAdapter.js';
import { NETWORK } from '../../src/config/networks.js';
import { getAddress } from 'ethers';

const TOKEN = A(0xa001);
const WETH = A(0xa002); // > TOKEN, so TOKEN is token0
const ROUTER = A(0xb001);
const USER = getAddress(A(0xc001));

const log = (iface, event, args, address) => ({ address, ...iface.encodeEventLog(iface.getEvent(event), args), blockNumber: '0x10', transactionHash: '0x' + '1'.repeat(64), transactionIndex: '0x0', logIndex: '0x0' });

test('decodeSwap V2: tokens out of the pair = BUY, tokens in = SELL (token as token0 and token1)', () => {
  const pair = A(0xd001);
  const p0 = { kind: 'v2', dex: 'UNISWAP_V2', address: pair, poolId: pair, tokenIsCurrency0: true };
  const buy = decodeSwap(p0, log(V2_PAIR, 'Swap', [ROUTER, 0n, 5n, 1000n, 0n, USER], pair));
  assert.deepEqual([buy.side, buy.tokenAmount, buy.quoteAmount, buy.recipient], ['BUY', '1000', '5', USER]);
  const sell = decodeSwap(p0, log(V2_PAIR, 'Swap', [ROUTER, 700n, 0n, 0n, 3n, USER], pair));
  assert.deepEqual([sell.side, sell.tokenAmount, sell.quoteAmount], ['SELL', '700', '3']);
  const p1 = { ...p0, tokenIsCurrency0: false };
  const buy1 = decodeSwap(p1, log(V2_PAIR, 'Swap', [ROUTER, 5n, 0n, 0n, 1000n, USER], pair));
  assert.deepEqual([buy1.side, buy1.tokenAmount, buy1.quoteAmount], ['BUY', '1000', '5']);
});

test('decodeSwap V3: negative token amount (paid out by the pool) = BUY', () => {
  const pool = A(0xd002);
  const p = { kind: 'v3', dex: 'UNISWAP_V3', address: pool, poolId: pool, tokenIsCurrency0: true };
  const buy = decodeSwap(p, log(V3_POOL, 'Swap', [ROUTER, USER, -1000n, 5n, 1n, 1n, 0], pool));
  assert.deepEqual([buy.side, buy.tokenAmount, buy.quoteAmount, buy.recipient], ['BUY', '1000', '5', USER]);
  const sell = decodeSwap(p, log(V3_POOL, 'Swap', [ROUTER, USER, 1000n, -5n, 1n, 1n, 0], pool));
  assert.equal(sell.side, 'SELL');
  const p1 = { ...p, tokenIsCurrency0: false };
  const buy1 = decodeSwap(p1, log(V3_POOL, 'Swap', [ROUTER, USER, 7n, -900n, 1n, 1n, 0], pool));
  assert.deepEqual([buy1.side, buy1.tokenAmount, buy1.quoteAmount, buy1.venue], ['BUY', '900', '7', 'UNISWAP_V3']);
});

test('decodeSwap V4: positive token delta (received by the swapper) = BUY', () => {
  const pm = A(0xd003);
  const p = { kind: 'v4', dex: 'UNISWAP_V4', address: pm, poolId: '0x' + 'ab'.repeat(32), tokenIsCurrency0: true };
  const buy = decodeSwap(p, log(V4_POOL_MANAGER, 'Swap', [p.poolId, ROUTER, 1000n, -5n, 1n, 1n, 0, 3000], pm));
  assert.deepEqual([buy.side, buy.tokenAmount, buy.quoteAmount], ['BUY', '1000', '5']);
});

test('findPools + getSwaps: pools from the verified Robinhood Uniswap V2/V3 factories, swaps decoded per pool kind', async () => {
  const net = NETWORK;
  const chain = createMockChain({ latestBlock: 5_000 });
  const uniV2 = net.dexes.find((d) => d.id === 'UNISWAP_V2');
  const uniV3 = net.dexes.find((d) => d.id === 'UNISWAP_V3');
  const pair = A(0xe001);
  const pool = A(0xe002);
  chain.addLog({ address: uniV2.factory, iface: V2_FACTORY, event: 'PairCreated', args: [TOKEN, WETH, pair, 1n], blockNumber: 100 });
  chain.addLog({ address: uniV3.factory, iface: V3_FACTORY, event: 'PoolCreated', args: [WETH, TOKEN, 2500, 50, pool], blockNumber: 90 });
  // A PairCreated for another token on the same factory must not match.
  chain.addLog({ address: uniV2.factory, iface: V2_FACTORY, event: 'PairCreated', args: [A(0xf001), WETH, A(0xe003), 2n], blockNumber: 110 });
  chain.addLog({ address: pair, iface: V2_PAIR, event: 'Swap', args: [ROUTER, 0n, 5n, 1000n, 0n, USER], blockNumber: 120 });
  chain.addLog({ address: pool, iface: V3_POOL, event: 'Swap', args: [ROUTER, USER, 7n, -900n, 1n, 1n, 0], blockNumber: 95 });
  const rpc = createRpcClient(chain.transport, { retries: 0, minIntervalMs: 0 });

  const r = await findPools(rpc, TOKEN, net, { fromBlock: 0, toBlock: 5_000 });
  assert.equal(r.failures.length, 0);
  assert.deepEqual(r.pools.map((p) => p.dex).sort(), ['UNISWAP_V2', 'UNISWAP_V3']);
  const v3 = r.pools.find((p) => p.kind === 'v3');
  assert.equal(v3.tokenIsCurrency0, false);
  assert.equal(selectPrimaryPools(r.pools, null).primary[0].dex, 'UNISWAP_V3', 'earliest pool first');

  for (const p of r.pools) {
    const s = await getSwaps(rpc, p, { fromBlock: p.blockNumber, toBlock: 5_000 });
    assert.equal(s.swaps.length, 1, p.dex);
    assert.equal(s.swaps[0].side, 'BUY', p.dex);
  }
});


test('Robinhood registry: only chain 4663, every DEX address is a verified contract', () => {
  assert.equal(NETWORK.chainId, 4663);
  const verified = new Set(NETWORK.verifiedContracts.map((x) => x.address));
  for (const d of NETWORK.dexes) assert.ok(verified.has(d.factory ?? d.poolManager), d.id);
  assert.deepEqual(NETWORK.dexes.map((d) => d.kind).sort(), ['v2', 'v3', 'v4']);
});
