// npm run check — syntax-check all JS files + static config validation (no network).
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getAddress } from 'ethers';
import { PROJECT_ROOT } from '../src/config/paths.js';

let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  failed++;
  console.log(`✖ ${m}`);
};

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

// 1) Syntax check.
const files = ['src', 'server', 'web', 'tests', 'scripts'].flatMap((d) => (existsSync(join(PROJECT_ROOT, d)) ? walk(join(PROJECT_ROOT, d)) : []));
let syntaxErrors = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    syntaxErrors++;
    fail(`Syntax error: ${relative(PROJECT_ROOT, f)}\n${r.stderr}`);
  }
}
if (!syntaxErrors) ok(`Syntax OK (${files.length} files)`);

// 2) Scoring weights = 100.
const { SCORING_WEIGHTS } = await import('../src/config/analysis.js');
const sum = Object.values(SCORING_WEIGHTS).reduce((s, w) => s + w, 0);
sum === 100 ? ok('Scoring weights add up to 100') : fail(`Scoring weights add up to ${sum}, must be 100`);

// 3) Verified contract addresses are checksummed & have a source.
const { VERIFIED_CONTRACTS: allContracts } = await import('../src/config/networks.js');
const bad = allContracts.filter((x) => {
  try {
    return getAddress(x.address) !== x.address || !x.source || !x.verifiedAt;
  } catch {
    return true;
  }
});
bad.length ? fail(`Contracts without checksum/source: ${bad.map((b) => b.label).join(', ')}`) : ok(`${allContracts.length} verified contracts have a checksum & source`);

// 4) Config: .env (if present) or .env.example must pass schema validation.
const { buildConfig } = await import('../src/config/env.js');
const envFile = existsSync(join(PROJECT_ROOT, '.env')) ? '.env' : '.env.example';
try {
  const parsed = Object.fromEntries(
    readFileSync(join(PROJECT_ROOT, envFile), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
  const cfg = buildConfig(parsed);
  ok(`${envFile} valid (RPC ${cfg.rpcUrl ? 'set' : 'empty'}, chain ID ${cfg.chainId ?? 'empty'}, AI ${cfg.ai.provider})`);
} catch (e) {
  fail(`${envFile} is invalid: ${e.message}`);
}

// 5) .env must never reach git & .env.example must not contain real keys.
const gi = existsSync(join(PROJECT_ROOT, '.gitignore')) ? readFileSync(join(PROJECT_ROOT, '.gitignore'), 'utf8') : '';
/^\.env$/m.test(gi) ? ok('.env is listed in .gitignore') : fail('.env is not listed in .gitignore');
const example = readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8');
/(AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z]{20,}|proapi_[0-9A-Za-z]{8,})/.test(example) ? fail('.env.example appears to contain a real API key') : ok('.env.example contains placeholders only');

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
