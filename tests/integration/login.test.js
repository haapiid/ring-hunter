// `ring-hunter login / whoami / logout` against a local account server (in-memory SQLite, 127.0.0.1 only).
// Uses a temporary RING_HUNTER_HOME and a SYNTHETIC throwaway wallet to obtain a key. No internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { PROJECT_ROOT } from '../../src/config/paths.js';
import { createAccountServer } from '../../server/app.js';

const exec = promisify(execFile);
let app;
let base;
let home;

before(async () => {
  // The CLI is not a browser: it talks to 127.0.0.1 directly, so the public origin is the local one here.
  app = createAccountServer({ publicOrigin: 'http://127.0.0.1:1' });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), 'rh-login-'));
  writeFileSync(join(home, '.env'), `ROBINHOOD_CHAIN_RPC=https://rpc.mainnet.chain.robinhood.com\nROBINHOOD_CHAIN_ID=4663\nRING_HUNTER_API_URL=${base}\n`);
});
after(async () => {
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

async function run(args, env = {}) {
  try {
    const r = await exec(process.execPath, [join(PROJECT_ROOT, 'src', 'index.js'), ...args], { env: { ...process.env, RING_HUNTER_HOME: home, NO_COLOR: '1', ...env } });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { status: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** Get a real key through the website flow (sign-in → create key). */
async function issueKey() {
  const w = Wallet.createRandom();
  const post = (path, body, cookie) =>
    fetch(base + path, { method: 'POST', headers: { origin: 'http://127.0.0.1:1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const n = await (await post('/api/auth/nonce', { address: w.address })).json();
  const v = await post('/api/auth/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  const k = await (await post('/api/key', {}, cookie)).json();
  return { address: w.address, key: k.apiKey, cookie, post };
}

test('login → whoami → logout; the key is stored locally but never printed', async () => {
  const { address, key } = await issueKey();
  assert.match((await run(['whoami'])).stdout, /Not logged in/);

  const login = await run(['login', key]);
  assert.equal(login.status, 0, login.stderr);
  assert.ok(login.stdout.includes(`Logged in as ${address}`));
  for (const out of [login.stdout, login.stderr]) assert.ok(!out.includes(key), 'key not echoed');
  const creds = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
  assert.equal(creds.apiKey, key);
  assert.equal(creds.address, address);

  const who = await run(['whoami']);
  assert.equal(who.status, 0, who.stderr);
  assert.ok(who.stdout.includes(address));
  assert.ok(!who.stdout.includes(key));

  const out = await run(['logout']);
  assert.equal(out.status, 0);
  assert.ok(!existsSync(join(home, 'credentials.json')));
  assert.match((await run(['whoami'])).stdout, /Not logged in/);
});

test('bad keys: malformed → exit 2, unknown/revoked → exit 1, nothing saved', async () => {
  assert.equal((await run(['login', 'not-a-key'])).status, 2);
  const fake = 'rh_' + 'A'.repeat(43);
  const r = await run(['login', fake]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not accepted/);
  assert.ok(!r.stderr.includes(fake), 'key redacted');
  assert.ok(!existsSync(join(home, 'credentials.json')));

  const { key, cookie, post } = await issueKey();
  await post('/api/key/revoke', {}, cookie);
  assert.equal((await run(['login', key])).status, 1);
});

test('login is optional and documented in --help', async () => {
  // --help still lists scan as the main use; login is marked optional.
  assert.match((await run(['--help'])).stdout, /login \[API_KEY\]\s+Link this CLI to your website account \(optional\)/);
});
