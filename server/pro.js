// RING-HUNTER Pro: on-chain checks, read-only (eth_getTransactionByHash / eth_getTransactionReceipt / eth_call).
// The website never sends a transaction: the user pays from their own wallet app, then pastes the tx hash and the
// server verifies it here. Pro can also come from holding the RING-HUNTER token (balanceOf, cached).
import { getAddress, isAddress, parseEther, parseUnits, formatEther, formatUnits } from 'ethers';
import { ERC20 } from '../src/adapters/evm/abis.js';

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const MAX_PERIODS_PER_TX = 12;
const TOKEN_CACHE_MS = 10 * 60_000;

export class ProError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Pro settings from the server env. Every value is optional: without RH_TREASURY + RH_PRO_PRICE_ETH payments are
 * off; without RH_PRO_TOKEN + RH_PRO_TOKEN_MIN token-holder Pro is off. Nothing is ever guessed.
 */
export function proSettings(env = process.env) {
  const s = { treasury: null, priceWei: null, days: 30, token: null, tokenMin: null };
  if (env.RH_TREASURY) {
    if (!isAddress(env.RH_TREASURY)) throw new Error('RH_TREASURY must be a 0x address');
    s.treasury = getAddress(env.RH_TREASURY);
  }
  if (env.RH_PRO_PRICE_ETH) {
    s.priceWei = parseEther(env.RH_PRO_PRICE_ETH);
    if (s.priceWei <= 0n) throw new Error('RH_PRO_PRICE_ETH must be > 0');
  }
  if (env.RH_PRO_DAYS) {
    s.days = Number(env.RH_PRO_DAYS);
    if (!Number.isInteger(s.days) || s.days < 1 || s.days > 366) throw new Error('RH_PRO_DAYS must be 1–366');
  }
  if (env.RH_PRO_TOKEN) {
    if (!isAddress(env.RH_PRO_TOKEN)) throw new Error('RH_PRO_TOKEN must be a 0x address');
    s.token = getAddress(env.RH_PRO_TOKEN);
  }
  if (env.RH_PRO_TOKEN_MIN) {
    if (!/^\d+(\.\d+)?$/.test(env.RH_PRO_TOKEN_MIN)) throw new Error('RH_PRO_TOKEN_MIN must be a decimal number');
    s.tokenMin = env.RH_PRO_TOKEN_MIN;
  }
  return Object.freeze(s);
}

export const paymentsEnabled = (s) => !!(s.treasury && s.priceWei);
export const tokenProEnabled = (s) => !!(s.token && s.tokenMin);

/** Public description for the dashboard (addresses and prices only). */
export function publicProInfo(s) {
  return {
    payments: paymentsEnabled(s) ? { chainId: 4663, treasury: s.treasury, priceEth: formatEther(s.priceWei), days: s.days, maxPeriodsPerTx: MAX_PERIODS_PER_TX } : null,
    token: tokenProEnabled(s) ? { address: s.token, minBalance: s.tokenMin } : null,
  };
}

const big = (hex) => BigInt(hex ?? 0);

/**
 * Verify a plain ETH transfer: from = the signed-in wallet, to = treasury, succeeded, on chain 4663, value ≥ price.
 * @returns {Promise<{valueWei:string, block:number, days:number}>}
 */
export async function verifyPayment(rpc, s, { txHash, payer }) {
  if (!paymentsEnabled(s)) throw new ProError(503, 'Pro payments are not open yet');
  if (typeof txHash !== 'string' || !TX_HASH_RE.test(txHash)) throw new ProError(400, 'A transaction hash (0x + 64 hex characters) is required');
  const tx = await rpc.getTransaction(txHash);
  if (!tx) throw new ProError(404, 'Transaction not found on Robinhood Chain — wait a few seconds and try again, and check that you paid on Robinhood Chain');
  if (tx.chainId != null && Number(big(tx.chainId)) !== 4663) throw new ProError(400, 'The transaction is not on Robinhood Chain (chain ID 4663)');
  if (!tx.to || getAddress(tx.to) !== s.treasury) throw new ProError(400, 'The transaction was not sent to the RING-HUNTER treasury address');
  if (getAddress(tx.from) !== payer) throw new ProError(400, 'The transaction was sent from a different wallet — pay from the wallet you signed in with');
  if (!tx.blockNumber) throw new ProError(409, 'The transaction is still pending — try again when it is confirmed');
  const receipt = await rpc.getReceipt(txHash);
  if (!receipt) throw new ProError(409, 'The transaction is still pending — try again when it is confirmed');
  if (big(receipt.status) !== 1n) throw new ProError(400, 'The transaction failed on-chain');
  const value = big(tx.value);
  const periods = value / s.priceWei;
  if (periods < 1n) throw new ProError(400, `The amount is below the Pro price (${formatEther(s.priceWei)} ETH)`);
  const n = Number(periods > BigInt(MAX_PERIODS_PER_TX) ? BigInt(MAX_PERIODS_PER_TX) : periods);
  return { valueWei: value.toString(), block: Number(big(tx.blockNumber)), days: n * s.days };
}

/** Token-holder Pro: balanceOf(holder) ≥ RH_PRO_TOKEN_MIN (in whole tokens). Cached per address. */
export function createTokenChecker(rpc, s, { now = () => Date.now() } = {}) {
  const cache = new Map();
  let decimals = null;
  return async function holderStatus(holder) {
    if (!tokenProEnabled(s)) return null;
    const hit = cache.get(holder);
    if (hit && now() - hit.at < TOKEN_CACHE_MS) return hit.value;
    let value;
    try {
      if (decimals == null) decimals = Number(ERC20.decodeFunctionResult('decimals', await rpc.call(s.token, ERC20.encodeFunctionData('decimals')))[0]);
      const bal = ERC20.decodeFunctionResult('balanceOf', await rpc.call(s.token, ERC20.encodeFunctionData('balanceOf', [holder])))[0];
      value = { balance: formatUnits(bal, decimals), qualifies: bal >= parseUnits(s.tokenMin, decimals) };
    } catch {
      value = { balance: null, qualifies: false, error: 'Token balance could not be read right now' };
    }
    if (cache.size > 5_000) cache.clear();
    cache.set(holder, { at: now(), value });
    return value;
  };
}
