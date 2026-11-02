import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, aiStatus, describeConfig, assertScanReady } from '../../src/config/env.js';
import { ConfigError } from '../../src/utils/errors.js';

test('buildConfig: safe defaults when env is empty', () => {
  const c = buildConfig({});
  assert.equal(c.rpcUrl, null);
  assert.equal(c.chainId, null);
  assert.equal(c.ai.provider, 'none');
  assert.equal(c.maxInitialTx, 50);
  assert.equal(c.rpcTimeoutMs, 15000);
  assert.throws(() => assertScanReady(c), ConfigError);
});

test('buildConfig: valid values', () => {
  const c = buildConfig({ ROBINHOOD_CHAIN_RPC: 'https://rpc.mainnet.chain.robinhood.com', ROBINHOOD_CHAIN_ID: '4663', AI_PROVIDER: 'Groq', MAX_INITIAL_TRANSACTIONS: '20' });
  assert.equal(c.chainId, 4663);
  assert.equal(c.ai.provider, 'groq');
  assert.equal(c.maxInitialTx, 20);
  assertScanReady(c);
});

test('buildConfig: rejects invalid input', () => {
  assert.throws(() => buildConfig({ AI_PROVIDER: 'openai' }), ConfigError);
  assert.throws(() => buildConfig({ ROBINHOOD_CHAIN_RPC: 'not-a-url' }), ConfigError);
  assert.throws(() => buildConfig({ ROBINHOOD_CHAIN_RPC: 'ftp://x.y' }), ConfigError);
  assert.throws(() => buildConfig({ ROBINHOOD_CHAIN_ID: '-1' }), ConfigError);
  assert.throws(() => buildConfig({ MAX_INITIAL_TRANSACTIONS: '500' }), ConfigError);
});

test('aiStatus: model is required, never guessed', () => {
  assert.equal(aiStatus(buildConfig({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k'.repeat(30) })).ready, false);
  assert.match(aiStatus(buildConfig({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k'.repeat(30) })).reason, /MODEL/);
  assert.equal(aiStatus(buildConfig({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'k'.repeat(30), GROQ_MODEL: 'some-model' })).ready, true);
});

test('account server: official site by default, RING_HUNTER_API_URL overrides, http only for localhost', () => {
  const base = { ROBINHOOD_CHAIN_RPC: 'https://rpc.mainnet.chain.robinhood.com', ROBINHOOD_CHAIN_ID: '4663' };
  assert.equal(buildConfig(base).accountApiUrl, 'https://www.ringhunter.fun');
  assert.equal(buildConfig({ ...base, RING_HUNTER_API_URL: '' }).accountApiUrl, 'https://www.ringhunter.fun');
  assert.equal(buildConfig({ ...base, RING_HUNTER_API_URL: 'https://rh.example.org' }).accountApiUrl, 'https://rh.example.org');
  assert.equal(buildConfig({ ...base, RING_HUNTER_API_URL: 'http://127.0.0.1:8787' }).accountApiUrl, 'http://127.0.0.1:8787');
  assert.throws(() => buildConfig({ ...base, RING_HUNTER_API_URL: 'http://rh.example.org' }), /https/);
});

test('describeConfig: does not leak secret values', () => {
  const key = 'gsk_THISISAREALLOOKINGKEY1234567890';
  const c = buildConfig({ ROBINHOOD_CHAIN_RPC: 'https://node.example.com/v2/PRIVATEKEY99', ROBINHOOD_CHAIN_ID: '4663', GROQ_API_KEY: key, BLOCK_EXPLORER_API_KEY: 'proapi_abcdefgh123' });
  const text = JSON.stringify(describeConfig(c));
  assert.ok(!text.includes(key));
  assert.ok(!text.includes('PRIVATEKEY99'));
  assert.ok(!text.includes('proapi_abcdefgh123'));
  assert.ok(text.includes('set'));
});
