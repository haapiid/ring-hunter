// Loads and validates config from .env (uses Node's built-in process.loadEnvFile, no dotenv).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../utils/errors.js';
import { registerSecret, safeUrlLabel } from '../utils/redact.js';
import { CONFIG_DIR, ENV_FILE } from './paths.js';
import { NETWORK } from './networks.js';

const intFrom = (def, min, max) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null));

// The official RING-HUNTER website & account server (deployed and verified 2026-11-02). Used only by
// `ring-hunter login / whoami`; RING_HUNTER_API_URL overrides it (e.g. a self-hosted server).
export const DEFAULT_ACCOUNT_API_URL = 'https://www.ringhunter.fun';

const EnvSchema = z.object({
  ROBINHOOD_CHAIN_RPC: optStr,
  ROBINHOOD_CHAIN_ID: optStr,
  AI_PROVIDER: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().toLowerCase() : 'none'))
    .pipe(z.enum(['gemini', 'groq', 'none'])),
  GEMINI_API_KEY: optStr,
  GROQ_API_KEY: optStr,
  GEMINI_MODEL: optStr,
  GROQ_MODEL: optStr,
  AI_TIMEOUT_MS: intFrom(30_000, 1_000, 300_000),
  BLOCK_EXPLORER_API_KEY: optStr,
  RING_HUNTER_API_URL: optStr,
  MAX_INITIAL_TRANSACTIONS: intFrom(50, 5, 50),
  RPC_TIMEOUT_MS: intFrom(15_000, 1_000, 120_000),
  LOG_CHUNK_BLOCKS: intFrom(500_000, 1_000, 10_000_000),
  HOLDER_SCAN_MAX_SECONDS: intFrom(120, 5, 3_600),
});

let loadedFrom = null;

/** Load .env from the config directory (once). Variables already in the environment are not overwritten. */
export function loadDotEnv(dir = CONFIG_DIR) {
  const file = resolve(dir, '.env');
  if (existsSync(file)) {
    process.loadEnvFile(file);
    loadedFrom = file;
  }
  return loadedFrom;
}

/**
 * Build the validated config object.
 * Does not throw for optional fields; throws ConfigError if the core config is broken.
 * @param {Record<string,string|undefined>} env
 */
export function buildConfig(env = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid .env config: ${issues}`, { hint: `Compare ${ENV_FILE} with the template (ring-hunter init creates it).` });
  }
  const e = parsed.data;

  if (e.ROBINHOOD_CHAIN_RPC) {
    let u;
    try {
      u = new URL(e.ROBINHOOD_CHAIN_RPC);
    } catch {
      throw new ConfigError('ROBINHOOD_CHAIN_RPC is not a valid URL.');
    }
    if (!['https:', 'http:'].includes(u.protocol)) throw new ConfigError('ROBINHOOD_CHAIN_RPC must be http(s).');
  }
  if (e.RING_HUNTER_API_URL) {
    let u;
    try {
      u = new URL(e.RING_HUNTER_API_URL);
    } catch {
      throw new ConfigError('RING_HUNTER_API_URL is not a valid URL.');
    }
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new ConfigError('RING_HUNTER_API_URL must use https:// (http:// only for localhost).');
  }
  let chainId = null;
  if (e.ROBINHOOD_CHAIN_ID) {
    chainId = Number(e.ROBINHOOD_CHAIN_ID);
    if (!Number.isInteger(chainId) || chainId <= 0) throw new ConfigError('ROBINHOOD_CHAIN_ID must be a positive integer.');
  }

  // All secret values are registered so they are redacted from output.
  for (const s of [e.GEMINI_API_KEY, e.GROQ_API_KEY, e.BLOCK_EXPLORER_API_KEY, e.ROBINHOOD_CHAIN_RPC]) registerSecret(s);

  return Object.freeze({
    network: NETWORK,
    // Blockscout PRO API (the official Robinhood Chain explorer); null without a key.
    explorer: e.BLOCK_EXPLORER_API_KEY
      ? Object.freeze({ provider: 'blockscout', baseUrl: NETWORK.explorerApiBase, chainParam: 'chain_id', apiKey: e.BLOCK_EXPLORER_API_KEY, keyEnv: EXPLORER_KEY_ENV })
      : null,
    rpcUrl: e.ROBINHOOD_CHAIN_RPC,
    rpcLabel: e.ROBINHOOD_CHAIN_RPC ? safeUrlLabel(e.ROBINHOOD_CHAIN_RPC) : null,
    chainId,
    ai: Object.freeze({
      provider: e.AI_PROVIDER,
      geminiKey: e.GEMINI_API_KEY,
      groqKey: e.GROQ_API_KEY,
      geminiModel: e.GEMINI_MODEL,
      groqModel: e.GROQ_MODEL,
      timeoutMs: e.AI_TIMEOUT_MS,
    }),
    // Optional account server (ring-hunter login). Scanning never uses it.
    accountApiUrl: e.RING_HUNTER_API_URL ?? DEFAULT_ACCOUNT_API_URL,
    maxInitialTx: e.MAX_INITIAL_TRANSACTIONS,
    rpcTimeoutMs: e.RPC_TIMEOUT_MS,
    logChunkBlocks: e.LOG_CHUNK_BLOCKS,
    holderScanMaxSeconds: e.HOLDER_SCAN_MAX_SECONDS,
  });
}

/** The variable that enables the explorer (native-coin funding, cluster analysis). */
export const EXPLORER_KEY_ENV = 'BLOCK_EXPLORER_API_KEY';
export const explorerKeyNames = () => EXPLORER_KEY_ENV;

/** Make sure the minimum config for a scan is present. */
export function assertScanReady(config) {
  if (!config.rpcUrl) {
    throw new ConfigError('ROBINHOOD_CHAIN_RPC is not set.', { hint: 'Run "ring-hunter init" to create the config file, then set ROBINHOOD_CHAIN_RPC.' });
  }
  if (!config.chainId) {
    throw new ConfigError('ROBINHOOD_CHAIN_ID is not set.', { hint: 'For Robinhood Chain mainnet, use 4663.' });
  }
}

/** AI status: ready, or the reason it isn't. */
export function aiStatus(config) {
  const { provider, geminiKey, groqKey, geminiModel, groqModel } = config.ai;
  if (provider === 'none') return { ready: false, reason: 'AI_PROVIDER=none (local analysis mode)' };
  if (provider === 'gemini') {
    if (!geminiKey) return { ready: false, reason: 'GEMINI_API_KEY is empty' };
    if (!geminiModel) return { ready: false, reason: 'GEMINI_MODEL is empty (model names are never guessed)' };
    return { ready: true, provider, model: geminiModel };
  }
  if (!groqKey) return { ready: false, reason: 'GROQ_API_KEY is empty' };
  if (!groqModel) return { ready: false, reason: 'GROQ_MODEL is empty (model names are never guessed)' };
  return { ready: true, provider, model: groqModel };
}

/** Config summary that is safe to display (no secret values). */
export function describeConfig(config) {
  const filled = (v) => (v ? 'set' : 'empty');
  const ai = aiStatus(config);
  return [
    ['Config file', loadedFrom ? loadedFrom : `not found — run "ring-hunter init" (expected: ${ENV_FILE})`],
    ['ROBINHOOD_CHAIN_RPC', config.rpcLabel ?? 'empty'],
    ['ROBINHOOD_CHAIN_ID', config.chainId ?? 'empty'],
    ['AI_PROVIDER', config.ai.provider],
    ['GEMINI_API_KEY', filled(config.ai.geminiKey)],
    ['GEMINI_MODEL', config.ai.geminiModel ?? 'empty'],
    ['GROQ_API_KEY', filled(config.ai.groqKey)],
    ['GROQ_MODEL', config.ai.groqModel ?? 'empty'],
    ['AI status', ai.ready ? `ready (${ai.provider} / ${ai.model})` : `inactive — ${ai.reason}`],
    ['BLOCK_EXPLORER_API_KEY', config.explorer ? 'set' : 'empty (ETH funding graph PARTIAL)'],
    ['RING_HUNTER_API_URL', config.accountApiUrl === DEFAULT_ACCOUNT_API_URL ? `${DEFAULT_ACCOUNT_API_URL} (default)` : config.accountApiUrl],
    ['MAX_INITIAL_TRANSACTIONS', config.maxInitialTx],
    ['RPC_TIMEOUT_MS', config.rpcTimeoutMs],
    ['LOG_CHUNK_BLOCKS', config.logChunkBlocks],
    ['HOLDER_SCAN_MAX_SECONDS', config.holderScanMaxSeconds],
  ];
}
