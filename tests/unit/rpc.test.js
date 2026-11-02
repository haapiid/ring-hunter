import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpcClient, classifyRpcError } from '../../src/adapters/evm/rpcClient.js';
import { RpcError, LogRangeError, DataUnavailableError } from '../../src/utils/errors.js';
import { createMockChain, A } from '../helpers/mockChain.js';
import { attributeTrade } from '../../src/scanner/transactionScanner.js';
import { ERC20, TOPICS } from '../../src/adapters/evm/abis.js';

test('classifyRpcError: Robinhood RPC limit messages are recognized', () => {
  assert.ok(classifyRpcError('eth_getLogs', { code: -32602, message: 'query spans 98573322 blocks (0 to 98573321), but only 10000000 are allowed' }) instanceof LogRangeError);
  assert.ok(classifyRpcError('eth_getLogs', { code: -32000, message: 'logs matched by query exceeds limit of 10000' }) instanceof LogRangeError);
  assert.ok(classifyRpcError('eth_getBalance', { code: -32000, message: 'historical state abc is not available' }) instanceof DataUnavailableError);
  const m = classifyRpcError('debug_traceTransaction', { code: -32601, message: 'the method debug_traceTransaction does not exist/is not available' });
  assert.equal(m.retryable, false);
});

test('classifyRpcError: messages from other networks\' public RPCs (seen 2026-11-02)', () => {
  // Range problems → shrink the range.
  assert.ok(classifyRpcError('eth_getLogs', { code: -32000, message: 'log query timed out' }) instanceof LogRangeError);
  assert.ok(classifyRpcError('eth_getLogs', { code: -32000, message: 'exceed maximum block range: 50000' }) instanceof LogRangeError);
  // No history → "data unavailable", not a broken RPC.
  assert.ok(classifyRpcError('eth_getLogs', { code: -32000, message: 'Archive requests require a personal token. Get one at: https://…' }) instanceof DataUnavailableError);
  assert.ok(classifyRpcError('eth_getCode', { code: -32000, message: 'missing trie node abc (path ) state 0x… is not available' }) instanceof DataUnavailableError);
  // eth_getLogs refused outright (mainnet.base.org, bsc-dataseed) → clear, non-retryable error.
  for (const message of ['request limit reached', 'limit exceeded']) {
    const e = classifyRpcError('eth_getLogs', { code: -32005, message });
    assert.ok(e instanceof RpcError && !(e instanceof LogRangeError), message);
    assert.equal(e.retryable, false);
    assert.match(e.message, /does not serve eth_getLogs/);
  }
});

test('HTTP transport: a JSON-RPC error sent with a non-200 status is classified, not reported as a bare HTTP code', async () => {
  const { createHttpTransport } = await import('../../src/adapters/evm/rpcClient.js');
  const fetchImpl = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Archive requests require a personal token.' } }), { status: 403 });
  const t = createHttpTransport({ url: 'https://rpc.example', fetchImpl });
  await assert.rejects(t.send('eth_getLogs', [{}]), (e) => e instanceof DataUnavailableError);
  const plain = createHttpTransport({ url: 'https://rpc.example', fetchImpl: async () => new Response('forbidden', { status: 403 }) });
  await assert.rejects(plain.send('eth_chainId', []), /RPC HTTP 403/);
});

test('read-only: write methods are blocked', async () => {
  const rpc = createRpcClient(createMockChain().transport);
  await assert.rejects(rpc.request('eth_sendRawTransaction', ['0x00']), /read-only/);
});

test('getLogsChunked: range is split automatically when over the limit', async () => {
  const chain = createMockChain({ latestBlock: 30_000_000, maxRange: 1_000_000 });
  const T = A(0x1);
  chain.setCode(T);
  for (let i = 0; i < 5; i++) chain.transfer(T, A(0), A(2), 1n, 5_000_000 * i + 1);
  const rpc = createRpcClient(chain.transport, { minIntervalMs: 0 });
  const r = await rpc.getLogsChunked({ address: T, topics: [TOPICS.Transfer], fromBlock: 0, toBlock: 30_000_000, chunkSize: 4_000_000 });
  assert.equal(r.complete, true);
  assert.equal(r.logs.length, 5);
});

test('getLogsChunked: deadline → complete=false with a reason', async () => {
  const chain = createMockChain({ latestBlock: 5_000_000 });
  const rpc = createRpcClient(chain.transport, { minIntervalMs: 0 });
  const r = await rpc.getLogsChunked({ address: A(1), fromBlock: 0, toBlock: 5_000_000, chunkSize: 1000, deadline: Date.now() - 1 });
  assert.equal(r.complete, false);
  assert.equal(r.reason, 'deadline');
});

test('bounded retry on retryable errors (timeout)', async () => {
  let n = 0;
  const transport = {
    async send() {
      n++;
      throw new RpcError('RPC timeout', { retryable: true });
    },
  };
  const rpc = createRpcClient(transport, { retries: 2, sleepFn: async () => {}, minIntervalMs: 0 });
  await assert.rejects(rpc.chainId(), /timeout/);
  assert.equal(n, 3);
});

test('findLogsBackward: finds old events across many windows', async () => {
  const chain = createMockChain({ latestBlock: 50_000_000 });
  const T = A(0x9);
  chain.transfer(T, A(0), A(3), 7n, 1234);
  const rpc = createRpcClient(chain.transport, { minIntervalMs: 0 });
  const found = await rpc.findLogsBackward({ address: T, topics: [TOPICS.Transfer], toBlock: 50_000_000 });
  assert.equal(found.length, 1);
});

// --- Trade attribution (real observed pattern: a router sells another wallet's tokens via approval) ---
const log = (token, from, to, value) => ({ address: token, topics: ERC20.encodeEventLog(ERC20.getEvent('Transfer'), [from, to, value]).topics, data: ERC20.encodeEventLog(ERC20.getEvent('Transfer'), [from, to, value]).data });

test('attributeTrade: SELL on behalf of another wallet → token owner, executedForOther', () => {
  const [T, OWNER, SENDER, ROUTER, CURVE] = [A(0xa), A(0xb), A(0xc), A(0xd), A(0xe)];
  const t = { side: 'SELL', tokenAmount: '500', eventActor: ROUTER, recipient: ROUTER };
  attributeTrade(t, { from: SENDER, to: ROUTER, logs: [log(T, OWNER, ROUTER, 500n), log(T, ROUTER, CURVE, 500n)] }, T, new Set([CURVE]));
  assert.equal(t.trader.toLowerCase(), OWNER);
  assert.equal(t.txFrom.toLowerCase(), SENDER);
  assert.equal(t.executedForOther, true);
  assert.equal(t.attribution, 'token-transfer-in-tx');
});

test('attributeTrade: plain BUY → token recipient = tx sender', () => {
  const [T, USER, ROUTER, CURVE] = [A(0xa), A(0xb), A(0xd), A(0xe)];
  const t = { side: 'BUY', tokenAmount: '900', eventActor: ROUTER, recipient: USER };
  attributeTrade(t, { from: USER, to: ROUTER, logs: [log(T, CURVE, USER, 900n)] }, T, new Set([CURVE]));
  assert.equal(t.trader.toLowerCase(), USER);
  assert.equal(t.executedForOther, false);
});

test('attributeTrade: deployer sells directly to the curve (eventActor = tx.from)', () => {
  const [T, DEV, CURVE] = [A(0xa), A(0xb), A(0xe)];
  const t = { side: 'SELL', tokenAmount: '10', eventActor: DEV, recipient: DEV };
  attributeTrade(t, { from: DEV, to: CURVE, logs: [log(T, DEV, CURVE, 10n)] }, T, new Set([CURVE]));
  assert.equal(t.trader.toLowerCase(), DEV);
  assert.equal(t.attribution, 'token-transfer-in-tx');
});
