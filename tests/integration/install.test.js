// `ring-hunter init` / `--version` as an installed CLI would run them. Uses a temporary RING_HUNTER_HOME,
// so the real ~/.ring-hunter is never touched. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../src/config/paths.js';

const run = (args, home) =>
  spawnSync(process.execPath, [join(PROJECT_ROOT, 'src', 'index.js'), ...args], {
    env: { ...process.env, RING_HUNTER_HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
  });

test('init creates the config from the template and never overwrites it', () => {
  const base = mkdtempSync(join(tmpdir(), 'rh-init-'));
  const home = join(base, '.ring-hunter');
  try {
    const first = run(['init'], home);
    assert.equal(first.status, 0, first.stderr);
    const envFile = join(home, '.env');
    assert.ok(existsSync(envFile));
    assert.ok(existsSync(join(home, 'reports')));
    assert.equal(readFileSync(envFile, 'utf8'), readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8'));

    writeFileSync(envFile, 'ROBINHOOD_CHAIN_ID=4663\n# edited by user\n');
    const second = run(['init'], home);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already exists/);
    assert.match(readFileSync(envFile, 'utf8'), /edited by user/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--version prints the package version', () => {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const r = run(['--version'], join(tmpdir(), 'rh-unused'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('Robinhood only: --chain and the chains command are gone; non-EVM addresses are invalid input (exit 2)', () => {
  const base = mkdtempSync(join(tmpdir(), 'rh-chain-'));
  const home = join(base, '.ring-hunter');
  try {
    assert.equal(run(['init'], home).status, 0);
    const evm = '0xB6ea66422c14F64Cf66FaE50F7d4914D4bAaC09B';
    assert.equal(run(['scan', evm, '--chain', 'base'], home).status, 2);
    assert.equal(run(['chains'], home).status, 2);
    assert.equal(run(['scan', '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN'], home).status, 2);
    assert.match(run(['--help'], home).stdout, /Robinhood Chain \(chain ID 4663\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
