import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAddress, parseAddressList, isTxHash } from '../../src/utils/validation.js';
import { redact, registerSecret, clearSecrets, safeUrlLabel } from '../../src/utils/redact.js';
import { withRetry } from '../../src/utils/retry.js';
import { InputError } from '../../src/utils/errors.js';
import { ratioPct, tokenAmount, shortAddr } from '../../src/utils/format.js';

test('normalizeAddress: accepts lowercase and a correct checksum', () => {
  assert.equal(normalizeAddress('0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'), '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
  assert.equal(normalizeAddress('  0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e '), '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
});

test('normalizeAddress: rejects a bad format and a bad checksum', () => {
  assert.throws(() => normalizeAddress('0x123'), InputError);
  assert.throws(() => normalizeAddress('not an address'), InputError);
  assert.throws(() => normalizeAddress(''), InputError);
  // Checksum changed by one letter → rejected.
  assert.throws(() => normalizeAddress('0x7Ed598BcEf8bd9Edd8C97A195C6d13f40801EC7e'), /checksum/);
});

test('parseAddressList: dedup & mixed separators', () => {
  const a = '0x' + '1'.repeat(40);
  const b = '0x' + '2'.repeat(40);
  assert.deepEqual(parseAddressList(`${a}, ${b}\n${a}`).length, 2);
  assert.throws(() => parseAddressList(`${a}, 0xzz`), InputError);
});

test('isTxHash', () => {
  assert.ok(isTxHash('0x' + 'a'.repeat(64)));
  assert.ok(!isTxHash('0x' + 'a'.repeat(63)));
});

test('redact: masks registered keys, common key patterns, and URL paths', () => {
  clearSecrets();
  registerSecret('SUPERSECRETVALUE123');
  const s = redact('key SUPERSECRETVALUE123 AIzaSyA1234567890abcdefghijklmnop gsk_abcdefghijklmnopqrstuvwx https://rpc.example.com/v2/abc123?apikey=zzz');
  assert.ok(!s.includes('SUPERSECRETVALUE123'));
  assert.ok(!s.includes('AIzaSyA1234567890'));
  assert.ok(!s.includes('gsk_abcdef'));
  assert.ok(!s.includes('abc123'));
  assert.ok(s.includes('https://rpc.example.com/***'));
  clearSecrets();
});

test('safeUrlLabel: host only', () => {
  assert.equal(safeUrlLabel('https://rpc.mainnet.chain.robinhood.com'), 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(safeUrlLabel('https://robinhood-mainnet.g.alchemy.com/v2/KEY'), 'https://robinhood-mainnet.g.alchemy.com/***');
});

test('withRetry: stops after the retry limit (never unbounded)', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('failed');
      },
      { retries: 2, sleepFn: async () => {} },
    ),
  );
  assert.equal(calls, 3);
});

test('withRetry: no retry when shouldRetry is false', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => (calls++, Promise.reject(new Error('x'))), { retries: 5, shouldRetry: () => false, sleepFn: async () => {} }));
  assert.equal(calls, 1);
});

test('format helpers', () => {
  assert.equal(ratioPct(25n, 100n), 25);
  assert.equal(ratioPct(1n, 0n), null);
  assert.equal(tokenAmount(1234567n * 10n ** 18n, 18, 2), '1,234,567');
  assert.equal(shortAddr('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'), '0x7eD5…EC7e');
});

test('normalizeAddress: a bare 40-hex address gets 0x; other malformed input is still rejected', () => {
  assert.equal(normalizeAddress('7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'), '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
  for (const bad of ['x0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', '7ed598bcef8bd9edd8c97a195c6d13f40801ec7', '0X7ed598bcef8bd9edd8c97a195c6d13f40801ec7e1']) assert.throws(() => normalizeAddress(bad), InputError, bad);
});
