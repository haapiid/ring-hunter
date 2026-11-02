// LIVE smoke test, read-only, against the public Robinhood Chain RPC. Run manually: npm run test:live
// Not run by `npm test`. Needs internet; does not need an API key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTransport, createRpcClient } from '../../src/adapters/evm/rpcClient.js';
import { PONS, UNISWAP_V4, ROBINHOOD_MAINNET } from '../../src/config/networks.js';
import { findPonsLaunch } from '../../src/adapters/evm/ponsAdapter.js';
import { runTokenScan } from '../../src/scanner/tokenScanner.js';
import { createLabelRegistry } from '../../src/config/labels.js';
import { buildConfig } from '../../src/config/env.js';

const RPC = process.env.ROBINHOOD_CHAIN_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const rpc = createRpcClient(createHttpTransport({ url: RPC, timeoutMs: 20_000 }));
// Real Pons token used during ABI verification (2026-10-27).
const KNOWN_PONS_TOKEN = '0xB6ea66422c14F64Cf66FaE50F7d4914D4bAaC09B';

test('chain ID = 4663', async () => {
  assert.equal(await rpc.chainId(), ROBINHOOD_MAINNET.chainId);
});

test('verified contracts have bytecode; the canonical PoolManager does not exist on this chain', async () => {
  for (const a of [PONS.factory, PONS.memeHook, UNISWAP_V4.poolManager]) assert.notEqual(await rpc.getCode(a), '0x', a);
  assert.equal(await rpc.getCode('0x000000000004444c5dc75cB358380D2e3dE08A90'), '0x');
});

test('TokenLaunched can be found for a known Pons token', async () => {
  const launch = await findPonsLaunch(rpc, KNOWN_PONS_TOKEN, { latestBlock: await rpc.blockNumber() });
  assert.ok(launch);
  assert.equal(launch.protocol, 'PONS_V2');
});

test('full scan of a Pons token (no explorer, no AI)', { timeout: 240_000 }, async () => {
  const config = buildConfig({ ROBINHOOD_CHAIN_RPC: RPC, ROBINHOOD_CHAIN_ID: '4663' });
  const r = await runTokenScan({ address: KNOWN_PONS_TOKEN, config, rpc, labels: createLabelRegistry() });
  assert.equal(r.origin.status, 'VERIFIED');
  assert.ok(r.early.trades.length > 0);
  assert.ok(r.risk.score == null || (r.risk.score >= 0 && r.risk.score <= 100));
});
