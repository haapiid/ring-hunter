#!/usr/bin/env node
// Start the RING-HUNTER account server (website + account API) — for the VPS, not part of the npm package.
//   RH_PUBLIC_ORIGIN  public origin of the site, e.g. https://your-domain.example (required; SIWE domain & CSRF check)
//   RH_SERVER_PORT    port on 127.0.0.1 (default 8787) — put a TLS reverse proxy in front of it
//   RH_DB_FILE        SQLite file (default server/data/accounts.db)
//   RH_TRUST_PROXY=1  take the client IP from X-Real-IP (only when the reverse proxy sets it)
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/config/paths.js';
import { createAccountServer } from './app.js';

const env = process.env;
const port = Number(env.RH_SERVER_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid RH_SERVER_PORT: ${env.RH_SERVER_PORT}`);
let publicOrigin = env.RH_PUBLIC_ORIGIN;
if (!publicOrigin) {
  publicOrigin = `http://localhost:${port}`;
  process.stderr.write(`RH_PUBLIC_ORIGIN is not set — using ${publicOrigin} (local testing only).\n`);
}
const dbFile = resolve(env.RH_DB_FILE || resolve(PROJECT_ROOT, 'server/data/accounts.db'));

const app = createAccountServer({ publicOrigin, dbFile, trustProxy: env.RH_TRUST_PROXY === '1' });
await app.listen(port);
process.stdout.write(`RING-HUNTER account server on 127.0.0.1:${port} (public origin ${publicOrigin})\n`);
const stop = () => app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
