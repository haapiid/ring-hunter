// Read-only EVM JSON-RPC client: timeouts, bounded retries, rate limiting, and adaptive eth_getLogs chunking.
// Only read methods are exposed. No eth_sendRawTransaction / signer in this module.
import { RpcError, LogRangeError, DataUnavailableError } from '../../utils/errors.js';
import { withRetry } from '../../utils/retry.js';
import { createLimiter } from '../../utils/rateLimiter.js';
import { redact } from '../../utils/redact.js';
import { logger } from '../../utils/logger.js';

export const READ_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getCode',
  'eth_call',
  'eth_getLogs',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getTransactionCount',
  'eth_getBalance',
  'eth_getStorageAt',
]);

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/** Classify JSON-RPC errors into application error classes. */
export function classifyRpcError(method, err) {
  const msg = String(err?.message || '');
  const code = err?.code ?? null;
  // "log query timed out": arb1.arbitrum.io on wide ranges (2026-11-02) — a smaller range succeeds.
  if (/spans .* blocks|block range|range too (large|wide)|exceeds limit|too many (results|logs)|query returned more than|limit of \d+|log query timed out/i.test(msg)) {
    return new LogRangeError(`${method} range exceeds the RPC limit: ${msg}`, { code });
  }
  if (/historical state|missing trie node|pruned|archive (requests|node|data)|requires? (an )?archive/i.test(msg)) {
    return new DataUnavailableError(`RPC is not an archive node: ${msg}`);
  }
  // Public endpoints that refuse eth_getLogs outright (mainnet.base.org: "request limit reached";
  // bsc-dataseed: "limit exceeded"; tested 2026-11-02). Halving the range would never help.
  if (method === 'eth_getLogs' && /^(request )?limit (reached|exceeded)$|please specify an address/i.test(msg.trim())) {
    return new RpcError(`This RPC does not serve eth_getLogs (${msg}). Use your own RPC URL for this network.`, { code, retryable: false });
  }
  if (code === -32601 || /does not exist\/is not available|method not found/i.test(msg)) {
    return new RpcError(`Method ${method} is not supported by the RPC.`, { code, retryable: false });
  }
  if (code === 429 || /rate limit|too many requests/i.test(msg)) {
    return new RpcError(`RPC rate limit: ${msg}`, { code, retryable: true });
  }
  if (code === 3 || /execution reverted|revert/i.test(msg)) {
    return new RpcError(`eth_call revert: ${msg}`, { code, retryable: false });
  }
  return new RpcError(`RPC ${method} failed: ${msg}`, { code, retryable: code === -32000 || code === -32603 });
}

/** HTTP transport using Node's built-in fetch. */
/** @param {{url:string, timeoutMs?:number, fetchImpl?:typeof fetch, headers?:Record<string,string>}} p headers: e.g. the hosted-RPC Bearer key */
export function createHttpTransport({ url, timeoutMs = 15_000, fetchImpl = globalThis.fetch, headers = {} }) {
  let id = 0;
  return {
    label: 'http',
    async send(method, params) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        throw new RpcError(timeout ? `RPC timeout after ${timeoutMs} ms (${method})` : `RPC connection failed: ${redact(e.message)}`, {
          retryable: true,
          hint: timeout ? null : 'If your internet provider blocks the RPC host, switch to encrypted DNS (e.g. Cloudflare 1.1.1.1 DNS over HTTPS). RING-HUNTER Pro users can also scan with --hosted-rpc.',
        });
      }
      if (res.status === 429) throw new RpcError('RPC rate limit (HTTP 429)', { code: 429, retryable: true });
      if (!res.ok) {
        // Some providers send a JSON-RPC error with a non-200 status (e.g. HTTP 403 "Archive requests require a
        // personal token"): classify that message so callers can tell "no archive data" from a broken RPC.
        const body = await res.text().catch(() => '');
        let rpcErr = null;
        try {
          rpcErr = JSON.parse(body)?.error ?? null;
        } catch {
          /* not JSON */
        }
        if (rpcErr?.message) throw classifyRpcError(method, rpcErr);
        // RING-HUNTER hosted RPC answers { error: "<text>" } for 401 (bad key) / 402 (not Pro) / 403 (blocked method).
        if (typeof rpcErr === 'string' && [401, 402, 403].includes(res.status)) throw new RpcError(`Hosted RPC: ${rpcErr}`, { code: res.status, retryable: false });
        throw new RpcError(`RPC HTTP ${res.status}`, { code: res.status, retryable: res.status >= 500 });
      }
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_RESPONSE_BYTES) throw new RpcError('RPC response too large', { retryable: false });
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new RpcError('RPC response too large', { retryable: false });
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new RpcError('RPC response is not JSON', { retryable: true });
      }
      if (json.error) throw classifyRpcError(method, json.error);
      return json.result;
    },
  };
}

const hex = (n) => '0x' + BigInt(n).toString(16);
const num = (h) => (h == null ? null : Number(BigInt(h)));

/**
 * @param {{send:(method:string, params:any[])=>Promise<any>}} transport
 * @param {{retries?:number, concurrency?:number, minIntervalMs?:number, sleepFn?:Function}} opts
 */
export function createRpcClient(transport, opts = {}) {
  const { retries = 3, concurrency = 4, minIntervalMs = 25, sleepFn } = opts;
  const limit = createLimiter({ concurrency, minIntervalMs });
  const blockTimeCache = new Map();
  const stats = { requests: 0, retries: 0, errors: 0 };

  async function request(method, params = []) {
    if (!READ_METHODS.has(method)) throw new RpcError(`Method ${method} is blocked: RING-HUNTER is read-only.`);
    return limit(() =>
      withRetry(
        () => {
          stats.requests++;
          return transport.send(method, params);
        },
        {
          retries,
          sleepFn,
          shouldRetry: (e) => e instanceof RpcError && e.retryable && !(e instanceof LogRangeError),
          onRetry: (e, attempt) => {
            stats.retries++;
            logger.debug(`retry ${method} #${attempt}: ${e.message}`);
          },
        },
      ).catch((e) => {
        // Log range rejections are a normal part of adaptive chunking, not a failure.
        if (!(e instanceof LogRangeError)) stats.errors++;
        throw e;
      }),
    );
  }

  const client = {
    stats,
    request,
    chainId: async () => num(await request('eth_chainId')),
    blockNumber: async () => num(await request('eth_blockNumber')),
    getCode: (address, tag = 'latest') => request('eth_getCode', [address, tag]),
    getStorageAt: (address, slot, tag = 'latest') => request('eth_getStorageAt', [address, slot, tag]),
    getTransactionCount: async (address, tag = 'latest') => num(await request('eth_getTransactionCount', [address, tag])),
    call: (to, data, tag = 'latest') => request('eth_call', [{ to, data }, tag]),
    getTransaction: (hash) => request('eth_getTransactionByHash', [hash]),
    getReceipt: (hash) => request('eth_getTransactionReceipt', [hash]),
    async getBlockTimestamp(blockNumber) {
      const key = Number(blockNumber);
      if (blockTimeCache.has(key)) return blockTimeCache.get(key);
      const b = await request('eth_getBlockByNumber', [hex(key), false]);
      const ts = b ? num(b.timestamp) : null;
      blockTimeCache.set(key, ts);
      if (blockTimeCache.size > 20_000) blockTimeCache.delete(blockTimeCache.keys().next().value);
      return ts;
    },
    getLogs: (filter) =>
      request('eth_getLogs', [
        {
          ...filter,
          fromBlock: typeof filter.fromBlock === 'string' ? filter.fromBlock : hex(filter.fromBlock),
          toBlock: typeof filter.toBlock === 'string' ? filter.toBlock : hex(filter.toBlock),
        },
      ]),

    /**
     * Fetch logs over a large range in chunks (ascending). The range is halved automatically when the RPC
     * rejects it due to block/log limits. Stops with complete=false when the deadline or maxLogs is reached.
     */
    async getLogsChunked({ address, topics, fromBlock, toBlock, chunkSize = 500_000, maxChunk = 9_000_000, deadline = null, maxLogs = Infinity, onProgress, isCancelled }) {
      const logs = [];
      let from = Number(fromBlock);
      const to = Number(toBlock);
      let size = Math.max(1, chunkSize);
      while (from <= to) {
        if (isCancelled?.()) return { logs, complete: false, scannedTo: from - 1, reason: 'cancelled' };
        if (deadline && Date.now() > deadline) return { logs, complete: false, scannedTo: from - 1, reason: 'deadline' };
        const end = Math.min(to, from + size - 1);
        try {
          const batch = await client.getLogs({ address, topics, fromBlock: from, toBlock: end });
          for (const l of batch) logs.push(l);
          onProgress?.({ from, to: end, total: to, found: logs.length });
          if (logs.length >= maxLogs) return { logs, complete: end >= to, scannedTo: end, reason: end >= to ? null : 'maxLogs' };
          from = end + 1;
          if (batch.length < 2_000 && size < maxChunk) size = Math.min(maxChunk, size * 2);
        } catch (e) {
          if (e instanceof LogRangeError && end > from) {
            size = Math.max(1, Math.floor((end - from + 1) / 2));
            continue;
          }
          throw e;
        }
      }
      return { logs, complete: true, scannedTo: to, reason: null };
    },

    /**
     * Search logs backwards from toBlock with a fixed window; stops at the first window containing logs.
     * Used to find topic-filtered events (small results), e.g. TokenLaunched for a single token.
     */
    async findLogsBackward({ address, topics, toBlock, floorBlock = 0, window = 9_000_000, deadline = null, isCancelled }) {
      let end = Number(toBlock);
      let size = window;
      while (end >= floorBlock) {
        if (isCancelled?.() || (deadline && Date.now() > deadline)) return [];
        const start = Math.max(floorBlock, end - size + 1);
        try {
          const found = await client.getLogs({ address, topics, fromBlock: start, toBlock: end });
          if (found.length) return found;
          end = start - 1;
        } catch (e) {
          if (e instanceof LogRangeError && size > 1) {
            size = Math.max(1, Math.floor(size / 2));
            continue;
          }
          throw e;
        }
      }
      return [];
    },
  };
  return client;
}
