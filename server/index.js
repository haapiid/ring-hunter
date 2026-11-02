#!/usr/bin/env node
// Start the RING-HUNTER account server (website + account API + Pro) — for the VPS, not part of the npm package.
//   RH_PUBLIC_ORIGIN  public origin of the site, e.g. https://your-domain.example (required; SIWE domain & CSRF check)
//   RH_SERVER_PORT    port on 127.0.0.1 (default 8787) — put a TLS reverse proxy in front of it
//   RH_DB_FILE        SQLite file (default server/data/accounts.db)
//   RH_TRUST_PROXY=1  take the client IP from X-Real-IP (only when the reverse proxy sets it)
// RING-HUNTER Pro (all optional; a feature stays off until its values are set — nothing is guessed):
//   RH_TREASURY       0x address that receives Pro payments (ETH on Robinhood Chain)
//   RH_PRO_PRICE_ETH  price of one Pro period, e.g. 0.01
//   RH_PRO_DAYS       length of one period in days (default 30)
//   RH_PRO_TOKEN      RING-HUNTER token address; holders of ≥ RH_PRO_TOKEN_MIN tokens get Pro
//   RH_PRO_TOKEN_MIN  minimum balance in whole tokens, e.g. 100000
//   RH_RPC_URL        read-only RPC for payment checks, hosted scans, and the Pro RPC proxy (default: public RPC)
//   RH_EXPLORER_KEY   Blockscout PRO key for hosted scans (optional; without it the ETH funding graph is PARTIAL)
//   RH_HOSTED=0       turn hosted scans / watchlist / launch feed off
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/config/paths.js';
import { createAccountServer } from './app.js';
import { proSettings } from './pro.js';
import { createScanContext, createHostedService } from './hosted.js';

const env = process.env;
const port = Number(env.RH_SERVER_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid RH_SERVER_PORT: ${env.RH_SERVER_PORT}`);
let publicOrigin = env.RH_PUBLIC_ORIGIN;
if (!publicOrigin) {
  publicOrigin = `http://localhost:${port}`;
  process.stderr.write(`RH_PUBLIC_ORIGIN is not set — using ${publicOrigin} (local testing only).\n`);
}
const dbFile = resolve(env.RH_DB_FILE || resolve(PROJECT_ROOT, 'server/data/accounts.db'));
const pro = proSettings(env);
const ctx = createScanContext(env);
const hostedOn = env.RH_HOSTED !== '0';

const app = createAccountServer({
  publicOrigin,
  dbFile,
  trustProxy: env.RH_TRUST_PROXY === '1',
  pro,
  chainRpc: ctx.rpc,
  rpcUpstream: ctx.config.rpcUrl,
  createHosted: hostedOn ? (db) => createHostedService({ db, ctx }) : null,
});
await app.listen(port);
app.hosted?.start();
const on = (b) => (b ? 'on' : 'off');
process.stdout.write(
  `RING-HUNTER account server on 127.0.0.1:${port} (public origin ${publicOrigin})\n` +
    `  Pro payments ${on(pro.treasury && pro.priceWei)} · token-holder Pro ${on(pro.token && pro.tokenMin)} · hosted scans ${on(hostedOn)}\n`,
);
const stop = () => app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
