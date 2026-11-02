// Interactive CLI flow driver for tests (runs as a child process). SYNTHETIC data, no network.
// Usage: node tests/helpers/cliDriver.js <config|scan>
// App output → stdout; prompt rendering → stderr.
import { PassThrough } from 'node:stream';
import { setPromptContext } from '../../src/cli/prompts.js';
import { mainMenu } from '../../src/cli/menu.js';
import { scanFlow } from '../../src/cli/app.js';
import { createRpcClient } from '../../src/adapters/evm/rpcClient.js';
import { createLabelRegistry } from '../../src/config/labels.js';
import { buildConfig } from '../../src/config/env.js';
import { buildPonsScenario, ADDR } from '../fixtures/ponsScenario.js';

const KEY = { down: '\x1b[B', enter: '\r' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const input = new PassThrough();
setPromptContext({ input, output: process.stderr });

async function press(...keys) {
  for (const k of keys) {
    await sleep(80);
    input.write(k);
  }
}

const scenario = process.argv[2];
if (scenario === 'config') {
  const ctx = { config: buildConfig({}), lastReport: null, lastWalletReport: null, explorer: null, labels: createLabelRegistry() };
  const run = mainMenu(ctx);
  // Items 1–3 are disabled (empty RPC) → cursor starts on "4. View Previous Reports".
  await press(KEY.down, KEY.down, KEY.enter); // 6. Configuration Check
  await sleep(400);
  await press(KEY.down, KEY.down, KEY.down, KEY.enter); // 7. Exit
  await run;
  process.stdout.write('\n[driver] done\n');
} else if (scenario === 'scan') {
  const { chain, explorer } = buildPonsScenario();
  const config = buildConfig({ ROBINHOOD_CHAIN_RPC: 'https://mock.invalid', ROBINHOOD_CHAIN_ID: '4663' });
  const ctx = { config, rpc: createRpcClient(chain.transport, { minIntervalMs: 0 }), explorer, labels: createLabelRegistry(), lastReport: null };
  const run = scanFlow(ctx, ADDR.T);
  await sleep(1500);
  await press(KEY.down, KEY.down, KEY.enter); // View transaction hashes
  await sleep(300);
  await press(KEY.down, KEY.enter); // View cluster details
  await sleep(300);
  await press(KEY.enter); // first cluster
  await sleep(300);
  await press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter); // Back to main menu
  await run;
  process.stdout.write(`\n[driver] lastReport=${ctx.lastReport?.token?.symbol}\n`);
} else {
  process.stderr.write('unknown scenario\n');
  process.exit(2);
}
process.exit(0);
