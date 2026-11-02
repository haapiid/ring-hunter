// Explorer API adapter for the Etherscan-compatible `module/action` endpoints of Blockscout PRO
// (BLOCK_EXPLORER_API_KEY), the official Robinhood Chain explorer. Optional: active only when the key is set. Needed for data
// NOT available from a standard RPC: native-coin transfers, internal transactions, and contract creators.
//
// Verification status: URL formats from docs.blockscout.com/devs/apis/pro-api (chain_id=);
// the endpoint rejects requests without a key (checked 2026-10-27). Responses with a key are NOT yet tested live — the parser accepts
// Etherscan-style {status,message,result} and {error} envelopes.
import { getAddress } from 'ethers';
import { DataUnavailableError, RpcError } from '../../utils/errors.js';
import { withRetry } from '../../utils/retry.js';
import { createLimiter } from '../../utils/rateLimiter.js';
import { redact } from '../../utils/redact.js';

export function createExplorerClient({ apiKey, baseUrl, chainId, chainParam = 'chain_id', provider = 'blockscout', timeoutMs = 15_000, fetchImpl = globalThis.fetch, sleepFn }) {
  if (!apiKey) return null;
  // Blockscout free tier: 5 req/s.
  const limit = createLimiter({ concurrency: 2, minIntervalMs: 220 });

  async function get(params) {
    const url = new URL(baseUrl);
    url.searchParams.set(chainParam, String(chainId));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('apikey', apiKey);
    return limit(() =>
      withRetry(
        async () => {
          let res;
          try {
            res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
          } catch (e) {
            throw new RpcError(`Explorer unreachable: ${redact(e.message)}`, { retryable: true });
          }
          if (res.status === 429) throw new RpcError('Explorer rate limit (HTTP 429)', { retryable: true });
          const text = await res.text();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            throw new RpcError(`Explorer HTTP ${res.status}: response is not JSON`, { retryable: res.status >= 500 });
          }
          if (json.error) throw new RpcError(`Explorer rejected the request: ${redact(String(json.error))}`, { retryable: false });
          if (json.status === '0') {
            // Etherscan-style: "No transactions found" is not an error.
            if (/no (transactions|records|data) found/i.test(json.message || '') || (Array.isArray(json.result) && json.result.length === 0)) return [];
            if (/rate limit/i.test(String(json.result || json.message))) throw new RpcError('Explorer rate limit', { retryable: true });
            throw new RpcError(`Explorer error: ${redact(String(json.result || json.message))}`, { retryable: false });
          }
          return json.result;
        },
        { retries: 2, sleepFn, shouldRetry: (e) => e.retryable },
      ),
    );
  }

  const normTx = (t, kind) => ({
    kind, // 'NATIVE' | 'INTERNAL'
    hash: t.hash || t.transactionHash,
    blockNumber: Number(t.blockNumber),
    timestamp: t.timeStamp ? Number(t.timeStamp) : null,
    from: t.from ? getAddress(t.from) : null,
    to: t.to ? getAddress(t.to) : null,
    value: BigInt(t.value || '0'),
    isError: t.isError === '1',
  });

  return {
    source: provider,
    /** Normal transactions of an address (containing native-coin transfers), ascending. */
    async txList(address, { offset = 200, startblock = 0, endblock = 999_999_999 } = {}) {
      const r = await get({ module: 'account', action: 'txlist', address, page: 1, offset, sort: 'asc', startblock, endblock });
      return (Array.isArray(r) ? r : []).map((t) => normTx(t, 'NATIVE'));
    },
    /** Internal transactions (native-coin transfers from contracts). Capped at 1,000 records. */
    async internalTxList(address, { offset = 200 } = {}) {
      const r = await get({ module: 'account', action: 'txlistinternal', address, page: 1, offset: Math.min(offset, 1000), sort: 'asc' });
      return (Array.isArray(r) ? r : []).map((t) => normTx(t, 'INTERNAL'));
    },
    /** Contract creator & creation tx. */
    async contractCreation(address) {
      const r = await get({ module: 'contract', action: 'getcontractcreation', contractaddresses: address });
      const row = Array.isArray(r) ? r[0] : null;
      if (!row) throw new DataUnavailableError('Explorer returned no contract creation data.');
      return {
        creator: row.contractCreator ? getAddress(row.contractCreator) : null,
        txHash: row.txHash || null,
        blockNumber: row.blockNumber ? Number(row.blockNumber) : null,
      };
    },
  };
}
