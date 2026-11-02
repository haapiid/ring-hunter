// Optional account link (`ring-hunter login | whoami | logout`), orex-style: the website issues an API key after a
// wallet sign-in; the CLI stores it in the config directory. NOTHING in the scanner depends on it — every scan
// feature works the same without logging in.
// The key is a secret: it is redacted from output, stored with file mode 0600, and sent only to the account
// server as a Bearer token (/api/cli/whoami, and /api/rpc when the user opts into --hosted-rpc). Never to the AI
// provider or a third-party RPC.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR } from '../config/paths.js';
import { ConfigError, InputError, AppError } from '../utils/errors.js';
import { registerSecret, safeUrlLabel } from '../utils/redact.js';
import { c } from './theme.js';

export const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');
export const API_KEY_RE = /^rh_[A-Za-z0-9_-]{43}$/; // same format as server/app.js

const CredentialsSchema = z.object({
  apiUrl: z.string().url(),
  apiKey: z.string().regex(API_KEY_RE),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  linkedAt: z.string(),
});

const keyHint = (key) => `${key.slice(0, 10)}…`;

/** Base URL of the account server: RING_HUNTER_API_URL, or the official site (DEFAULT_ACCOUNT_API_URL in config/env.js). */
export function accountApiUrl(config) {
  const url = config.accountApiUrl;
  if (!url) throw new ConfigError('RING_HUNTER_API_URL is not set.', { hint: 'Add RING_HUNTER_API_URL=<the RING-HUNTER website URL> to your config file (ring-hunter check shows where).' });
  return url.replace(/\/+$/, '');
}

export function readCredentials(file = CREDENTIALS_FILE) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = CredentialsSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    parsed = { success: false };
  }
  if (!parsed.success) throw new ConfigError(`${file} is damaged.`, { hint: 'Run "ring-hunter logout", then "ring-hunter login" again.' });
  registerSecret(parsed.data.apiKey);
  return parsed.data;
}

/** GET /api/cli/whoami with the key. Returns { address }. */
export async function whoamiRequest(apiUrl, apiKey, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${apiUrl}/api/cli/whoami`, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new AppError(`Account server unreachable (${safeUrlLabel(apiUrl)}): ${e?.name === 'TimeoutError' ? 'timeout' : 'connection failed'}.`, { hint: 'Check RING_HUNTER_API_URL and your internet connection. Scanning does not need the account.' });
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AppError(`API key ${keyHint(apiKey)} was not accepted: ${body.error ?? 'unauthorized'}.`, { hint: 'Create a new key on the website dashboard, then run "ring-hunter login" again.' });
  if (!res.ok || typeof body.address !== 'string') throw new AppError(`Account server error (HTTP ${res.status}).`);
  return body;
}

/** `ring-hunter login [KEY]` — prompts (masked) when no key is given. */
export async function runLogin(config, keyArg, { out = process.stdout, fetchImpl, file = CREDENTIALS_FILE, prompt } = {}) {
  const apiUrl = accountApiUrl(config);
  let key = keyArg?.trim();
  if (!key) {
    if (!process.stdin.isTTY && !prompt) throw new InputError('An API key is required: ring-hunter login <API_KEY>');
    const ask = prompt ?? (await import('@inquirer/prompts')).password;
    key = String(await ask({ message: 'Paste your RING-HUNTER API key (from the website dashboard):', mask: '*' })).trim();
  }
  if (!API_KEY_RE.test(key)) throw new InputError('That is not a RING-HUNTER API key (expected "rh_" followed by 43 characters).');
  registerSecret(key);
  const who = await whoamiRequest(apiUrl, key, { fetchImpl });
  mkdirSync(CONFIG_DIR, { recursive: true });
  const creds = { apiUrl, apiKey: key, address: who.address, linkedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  out.write(`\n${c.green('✓')} Logged in as ${who.address}\n`);
  out.write(c.dim(`  Key ${keyHint(key)} saved to ${file}\n  Scans work the same with or without an account.\n\n`));
  return creds;
}

/** `ring-hunter whoami` */
export async function runWhoami({ out = process.stdout, fetchImpl, file = CREDENTIALS_FILE } = {}) {
  const creds = readCredentials(file);
  if (!creds) {
    out.write('Not logged in. The account is optional — every scan works without it.\nTo link one: sign in on the RING-HUNTER website, copy your API key, then run "ring-hunter login".\n');
    return null;
  }
  const who = await whoamiRequest(creds.apiUrl, creds.apiKey, { fetchImpl });
  out.write(`${c.green('✓')} Logged in as ${who.address}\n${c.dim(`  Server ${safeUrlLabel(creds.apiUrl)} · key ${keyHint(creds.apiKey)} · linked ${creds.linkedAt}`)}\n`);
  if (who.pro) {
    const p = who.pro;
    out.write(p.active ? `  RING-HUNTER Pro: active${p.paidUntil ? ` until ${p.paidUntil}` : ''}${p.tokenHolder ? ' (token holder)' : ''} · hosted RPC: ring-hunter scan <token> --hosted-rpc\n` : c.dim('  RING-HUNTER Pro: not active (optional — see the website dashboard)\n'));
  }
  return who;
}

/** `ring-hunter logout` — removes the local key only; revoke it on the dashboard to disable it everywhere. */
export function runLogout({ out = process.stdout, file = CREDENTIALS_FILE } = {}) {
  if (!existsSync(file)) {
    out.write('Not logged in — nothing to remove.\n');
    return false;
  }
  rmSync(file);
  out.write(`${c.green('✓')} Logged out: the API key was removed from this computer.\n${c.dim('  To disable the key everywhere, revoke it on the website dashboard.')}\n`);
  return true;
}
