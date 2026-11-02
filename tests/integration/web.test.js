// Tests for the info page (web/) and its static server. No network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWebServer, PUBLIC_DIR } from '../../src/web/server.js';
import { SCORING_WEIGHTS } from '../../src/config/analysis.js';
import { ROBINHOOD_MAINNET, PONS } from '../../src/config/networks.js';

let app;
let port;
before(async () => {
  app = createWebServer();
  port = await app.listen(0);
});
after(() => app.close());

function raw(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

const jsFiles = readdirSync(join(PUBLIC_DIR, 'js')).map((f) => [f, readFileSync(join(PUBLIC_DIR, 'js', f), 'utf8')]);

test('page & assets are served with security headers', async () => {
  const res = await raw('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  for (const s of ['npm install -g ring-hunter-ai', 'ring-hunter init', 'Connect wallet', 'ring-hunter check']) assert.ok(res.text.includes(s), s);
  for (const p of ['/css/site.css', '/js/site.js', '/js/terminal.js', '/js/wallet.js', '/js/account.js', '/account.html', '/report.html', '/js/pro.js', '/js/report.js', '/js/ui.js', '/favicon.svg']) assert.equal((await raw('GET', p)).status, 200, p);
});

test('page is info only: no API endpoints / scan functions on the server', async () => {
  assert.equal((await raw('GET', '/api/status')).status, 404);
  assert.equal((await raw('POST', '/api/scan')).status, 405);
});

test('path traversal & files outside web/ are rejected', async () => {
  for (const p of ['/..%2Fpackage.json', '/..%2F.env', '/%2E%2E/%2E%2E/.env', '/js/..%2F..%2F.env', '/..%5C.env']) {
    const res = await raw('GET', p);
    assert.equal(res.status, 404, p);
    assert.ok(!res.text.includes('ROBINHOOD_CHAIN_RPC'), p);
  }
});

test('Host asing ditolak (proteksi DNS rebinding)', async () => {
  assert.equal((await raw('GET', '/', { Host: 'evil.example' })).status, 421);
});

// Comments may mention forbidden methods (as documentation); only code is checked.
const codeOnly = (full) => full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('wallet: no transaction/typed-data methods in frontend code; personal_sign only in the guarded SIWE signIn', () => {
  for (const [name, full] of jsFiles) {
    const src = codeOnly(full);
    for (const bad of ['eth_sendTransaction', 'eth_sendRawTransaction', "'eth_sign'", 'eth_signTypedData', 'privateKey', 'mnemonic', 'innerHTML', 'approve(']) {
      assert.ok(!src.includes(bad), `${name} must not contain ${bad}`);
    }
    assert.equal(src.split('personal_sign').length - 1, name === 'wallet.js' ? 1 : 0, `personal_sign in ${name}`);
  }
  // The one personal_sign sits inside signIn, after the checks that bind the message to this site, address, and chain.
  const w = codeOnly(jsFiles.find(([f]) => f === 'wallet.js')[1]);
  const fn = w.slice(w.indexOf('export async function signIn('), w.indexOf('export const wallet'));
  const at = fn.indexOf('personal_sign');
  assert.ok(at > 0);
  for (const guard of ['wants you to sign in with your Ethereum account:', 'location.origin', "'Chain ID: 4663'", "'Nonce: '", 'throw new Error']) {
    assert.ok(fn.indexOf(guard) >= 0 && fn.indexOf(guard) < at, guard);
  }
});

test('account page talks only to its own same-origin /api and keeps nothing in browser storage', () => {
  const acc = codeOnly(jsFiles.find(([f]) => f === 'account.js')[1]);
  const paths = [...new Set([...acc.matchAll(/api\('([^']+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(paths, ['/api/auth/nonce', '/api/auth/verify', '/api/key', '/api/key/revoke', '/api/logout', '/api/me']);
  assert.ok(!/https?:\/\//.test(acc), 'no absolute URLs');
  for (const bad of ['localStorage', 'sessionStorage', 'document.cookie']) assert.ok(!acc.includes(bad), bad);
});

test('Pro dashboard, report page, and shared helpers: same-origin /api only, no wallet requests, no storage', () => {
  const src = (f) => codeOnly(jsFiles.find(([n]) => n === f)[1]);
  const pro = src('pro.js');
  const paths = [...new Set([...pro.matchAll(/api\('([^']+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(paths, ['/api/launches', '/api/pro', '/api/pro/claim', '/api/scan', '/api/scans', '/api/watch', '/api/watch/remove']);
  assert.match(src('report.js'), /api\(`\/api\/report\?id=\$\{encodeURIComponent\(id\)\}`\)/);
  const ui = jsFiles.find(([n]) => n === 'ui.js')[1]; // raw: codeOnly() would cut at the explorer URL's //
  assert.match(ui, /fetch\(path,/);
  assert.equal((ui.match(/fetch\(/g) ?? []).length, 1, 'one fetch, to a relative /api path');
  for (const f of ['pro.js', 'report.js', 'ui.js']) {
    const s = src(f);
    assert.ok(!/fetch\(\s*['"`]https?:/.test(s), `${f}: no cross-origin fetch`);
    for (const bad of ['localStorage', 'sessionStorage', 'document.cookie', 'request(', 'ethereum', 'wallet.']) assert.ok(!s.includes(bad), `${f}: ${bad}`);
  }
  // The only absolute URL is the public block explorer (links, not requests).
  assert.deepEqual([...new Set([...ui.matchAll(/https?:\/\/[^'"`\s]+/g)].map((m) => m[0]))], ['https://robinhoodchain.blockscout.com']);
});

test('page data is consistent with the app config', () => {
  const site = jsFiles.find(([f]) => f === 'site.js')[1];
  const shown = [...site.matchAll(/\['[^']+', (\d+)\]/g)].map((m) => Number(m[1]));
  assert.deepEqual(shown, Object.values(SCORING_WEIGHTS), 'page weights = SCORING_WEIGHTS');
  const walletJs = jsFiles.find(([f]) => f === 'wallet.js')[1];
  assert.ok(walletJs.includes(`'0x${ROBINHOOD_MAINNET.chainId.toString(16)}'`), 'wallet chain ID = 4663');
  assert.ok(walletJs.includes(ROBINHOOD_MAINNET.explorerUrl));
  assert.ok(walletJs.includes('https://rpc.mainnet.chain.robinhood.com'));
});

test('launchpad section: mentioned factory = PONS.factory', () => {
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const sec = html.slice(html.indexOf('id="launchpad"'), html.indexOf('id="commands"'));
  assert.ok(sec.includes(`${PONS.factory.slice(0, 6)}…${PONS.factory.slice(-4)}`), 'factory abbreviation matches');
});

test('public page shows installed-CLI commands only: no local paths, localhost, or dev scripts', () => {
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const pageText = [html, readFileSync(join(PUBLIC_DIR, 'account.html'), 'utf8'), ...jsFiles.map(([, src]) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))].join('\n');
  for (const bad of ['C:\\laragon', 'localhost', 'npm start', 'npm run ', 'node src/', 'npm test', '../solana-launchpad']) {
    assert.ok(!pageText.includes(bad), `page must not contain "${bad}"`);
  }
  assert.ok(html.includes('npm install -g ring-hunter-ai'));
  assert.ok(html.includes('ring-hunter init'));
});
