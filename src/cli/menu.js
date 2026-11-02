// Interactive main menu. Items that need extra config are shown disabled with the reason.
import { choose, isPromptExit } from './prompts.js';
import { c } from './theme.js';
import { scanFlow, walletClusterFlow, devWalletFlow, reportsFlow, exportFlow, configCheckFlow } from './app.js';
import { AppError } from '../utils/errors.js';
import { safeErrorMessage } from '../utils/redact.js';
import { EXPLORER_KEY_ENV } from '../config/env.js';

export async function mainMenu(ctx) {
  for (;;) {
    const rpcReady = !!(ctx.config.rpcUrl && ctx.config.chainId);
    const needRpc = rpcReady ? false : `(set ${ctx.config.network.rpcEnv} in your config)`;
    let action;
    try {
      action = await choose('Main menu', [
        { name: '1. Scan Token Contract', value: 'scan', disabled: needRpc },
        { name: '2. Analyze Wallet Cluster', value: 'cluster', disabled: needRpc || (ctx.config.explorer ? false : `(needs ${EXPLORER_KEY_ENV})`) },
        { name: `3. Analyze Developer Wallet${ctx.config.explorer ? '' : c.dim(ctx.config.network.protocols?.pons ? ' (without explorer: Pons launches only)' : ' (without explorer: balance & nonce only)')}`, value: 'dev', disabled: needRpc },
        { name: '4. View Previous Reports', value: 'reports' },
        { name: '5. Export Report', value: 'export' },
        { name: '6. Configuration Check', value: 'config' },
        { name: '7. Exit', value: 'exit' },
      ]);
    } catch (e) {
      if (isPromptExit(e)) return;
      throw e;
    }
    if (action === 'exit') return;
    try {
      if (action === 'scan') await scanFlow(ctx);
      else if (action === 'cluster') await walletClusterFlow(ctx);
      else if (action === 'dev') await devWalletFlow(ctx);
      else if (action === 'reports') await reportsFlow();
      else if (action === 'export') await exportFlow(ctx);
      else if (action === 'config') await configCheckFlow(ctx);
    } catch (e) {
      // Ctrl+C inside a sub-menu prompt → back to the main menu, not exit.
      if (isPromptExit(e)) {
        process.stdout.write('\n');
        continue;
      }
      printError(e);
    }
  }
}

export function printError(e) {
  const msg = safeErrorMessage(e);
  process.stderr.write(`\n${c.red('✖')} ${msg}\n`);
  if (e instanceof AppError && e.hint) process.stderr.write(c.dim(`  Hint: ${e.hint}\n`));
  if (!(e instanceof AppError) && process.env.RING_HUNTER_DEBUG === '1') process.stderr.write(c.dim(safeErrorMessage({ message: e.stack }) + '\n'));
  process.stderr.write('\n');
}
