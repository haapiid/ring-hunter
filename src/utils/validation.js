// Input validation and normalization.
import { getAddress, isAddress } from 'ethers';
import { InputError } from './errors.js';

/** Normalize an EVM address to checksum format. Throws InputError if invalid. */
export function normalizeAddress(input, label = 'Address') {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new InputError(`${label} is invalid: must be 0x followed by 40 hexadecimal characters.`);
  }
  // Mixed-case addresses with a wrong checksum are rejected (likely a typo).
  const hex = s.slice(2);
  const mixedCase = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixedCase && !isAddress(s)) {
    throw new InputError(`${label} has an invalid EIP-55 checksum. Double-check the address.`);
  }
  return getAddress(s.toLowerCase());
}

export const lc = (a) => (a ? String(a).toLowerCase() : a);

export const isTxHash = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);

/** Parse an address list separated by commas/spaces/newlines. */
export function parseAddressList(text) {
  const parts = String(text || '')
    .split(/[\s,;]+/)
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const a = normalizeAddress(p);
    if (!seen.has(lc(a))) {
      seen.add(lc(a));
      out.push(a);
    }
  }
  return out;
}
