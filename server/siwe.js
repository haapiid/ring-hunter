// Sign-In with Ethereum (EIP-4361), server-built messages.
// The server writes the full message (domain, address, nonce, expiry) and stores it with the nonce; the client
// only returns { nonce, signature }. Verification recovers the signer of the STORED text, so a client can never
// make the server accept a message it did not issue. A signature is a plain-text personal_sign — it cannot move
// funds or approve anything.
import { randomBytes } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';

export const SIWE_CHAIN_ID = 4663; // Robinhood Chain — same as src/config/networks.js
export const NONCE_TTL_MS = 10 * 60 * 1000;
const STATEMENT = 'Sign in to RING-HUNTER AI. This only proves you own this address: it is not a transaction, costs no gas, and grants no token approval.';

export const newNonce = () => randomBytes(16).toString('hex');

/** Build the EIP-4361 message text. `origin` is the site's public origin, e.g. https://example.com */
export function buildSiweMessage({ origin, address, nonce, issuedAt, expiresAt }) {
  const u = new URL(origin);
  return [
    `${u.host} wants you to sign in with your Ethereum account:`,
    getAddress(address),
    '',
    STATEMENT,
    '',
    `URI: ${u.origin}`,
    'Version: 1',
    `Chain ID: ${SIWE_CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(expiresAt).toISOString()}`,
  ].join('\n');
}

/** True when `signature` over `message` was made by `address`. Never throws. */
export function signatureMatches(message, signature, address) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    return verifyMessage(message, signature) === getAddress(address);
  } catch {
    return false;
  }
}
