// End-to-end test of the interactive CLI flows: the driver runs as a child process and presses keys
// programmatically (no TTY, no network). SYNTHETIC data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const driver = fileURLToPath(new URL('../helpers/cliDriver.js', import.meta.url));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function runDriver(scenario) {
  const r = spawnSync(process.execPath, [driver, scenario], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: stripAnsi(r.stdout || ''), prompts: stripAnsi(r.stderr || '') };
}

test('main menu: Configuration Check then Exit', () => {
  const { code, out, prompts } = runDriver('config');
  assert.equal(code, 0, prompts.slice(-2000));
  assert.ok(prompts.includes('Main menu'));
  assert.ok(prompts.includes('1. Scan Token Contract'));
  assert.ok(prompts.includes('set ROBINHOOD_CHAIN_RPC'), 'items needing RPC are disabled with a reason');
  assert.ok(prompts.includes('without explorer: Pons launches only'), 'the no-explorer limitation is shown');
  assert.ok(out.includes('ROBINHOOD_CHAIN_RPC'), 'config table is shown');
  assert.ok(out.includes('RPC/chain ID not configured'));
  assert.ok(out.includes('[driver] done'));
});

test('scan flow: report, tx hashes, cluster detail, back to menu', () => {
  const { code, out, prompts } = runDriver('scan');
  assert.equal(code, 0, prompts.slice(-2000));
  assert.ok(out.includes('DEV RISK SCORE'));
  assert.ok(out.includes('Synthetic Ring Token (SRING)'));
  for (const s of ['RISK FACTORS', 'POSITIVE SIGNALS', 'DATA COVERAGE', 'ANALYSIS LIMITATIONS', 'UNVERIFIED ASSUMPTIONS', 'Disclaimer']) assert.ok(out.includes(s), s);
  assert.ok(out.includes('DEPLOYMENT') && out.includes('BUY'), 'tx hash table is shown');
  assert.ok(out.includes('Alternative explanations'), 'cluster detail is shown');
  assert.ok(prompts.includes('Next step'));
  assert.ok(out.includes('[driver] lastReport=SRING'));
});
