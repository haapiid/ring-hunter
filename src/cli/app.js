// CLI flows: token scan, wallet analysis, reports, export, config check.
// This module connects the (UI-less) scanner with the display components.
import ora from 'ora';
import Table from 'cli-table3';
import { c, clusterLabelColor } from './theme.js';
import { createStageProgress } from './progress.js';
import { renderSummaryTable, renderDetails, renderClusterDetail, renderTxHashes } from './reportTable.js';
import { askAddress, askAddressList, askConfirm, choose } from './prompts.js';
import { SCAN_STAGES } from '../scanner/stages.js';
import { runFullScan } from '../core/pipeline.js';
import { analyzeWalletSet, analyzeDeveloperWallet } from '../scanner/walletAnalysis.js';
import { serializable, APP_VERSION } from '../reports/reportBuilder.js';
import { saveReport, listReports, loadReport, deleteReport } from '../reports/exportJson.js';
import { createHttpTransport, createRpcClient } from '../adapters/evm/rpcClient.js';
import { createExplorerClient } from '../adapters/evm/explorerAdapter.js';
import { createLabelRegistry, loadLocalLabels } from '../config/labels.js';
import { assertScanReady, aiStatus, describeConfig } from '../config/env.js';
import { CancelledError } from '../utils/errors.js';
import { safeErrorMessage } from '../utils/redact.js';
import { shortAddr, toJson, tokenAmount } from '../utils/format.js';

/** Session context: config, RPC/explorer clients, labels, and the latest report. */
export function createContext(config) {
  let rpc = null;
  let explorer;
  let labels = null;
  return {
    config,
    lastReport: null,
    lastWalletReport: null,
    get rpc() {
      assertScanReady(config);
      rpc ??= createRpcClient(createHttpTransport({ url: config.rpcUrl, timeoutMs: config.rpcTimeoutMs }));
      return rpc;
    },
    get explorer() {
      if (explorer === undefined) {
        const x = config.explorer;
        explorer = x ? createExplorerClient({ apiKey: x.apiKey, baseUrl: x.baseUrl, chainParam: x.chainParam, provider: x.provider, chainId: config.network.chainId, timeoutMs: config.rpcTimeoutMs }) : null;
      }
      return explorer;
    },
    get labels() {
      labels ??= createLabelRegistry(loadLocalLabels());
      return labels;
    },
  };
}

/** Run fn with an AbortController triggered by Ctrl+C (a second Ctrl+C forces exit). */
async function withCancel(fn) {
  const ac = new AbortController();
  let presses = 0;
  const onSigint = () => {
    presses++;
    if (presses >= 2) process.exit(130);
    ac.abort();
    process.stderr.write(c.yellow('\n⏹  Cancelling after the running request finishes… (Ctrl+C again to force quit)\n'));
  };
  process.on('SIGINT', onSigint);
  try {
    return await fn(ac.signal);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/**
 * Full token scan → AI/fallback → report.
 * @param {{useAi?:boolean, stream?:NodeJS.WriteStream, interactive?:boolean}} opts
 */
export async function performScan(ctx, address, { useAi = true, stream = process.stdout } = {}) {
  const progress = createStageProgress(SCAN_STAGES, { stream });
  let spinner = null;
  let scanDone = false;
  const report = await withCancel((signal) =>
    runFullScan(ctx, address, {
      useAi,
      signal,
      onStage: progress.onStage,
      // Spinner only once the AI request actually starts.
      onAiStart: () => {
        progress.stop();
        scanDone = true;
        spinner = ora({ text: 'AI Engine is analyzing observed wallet correlations...', stream, color: 'magenta' }).start();
      },
      onAiDone: (aiResult) => {
        if (!spinner) return;
        if (aiResult.source === 'ai') spinner.succeed(`AI summary done (${aiResult.provider}/${aiResult.model})`);
        else spinner.warn(`AI not used — ${aiResult.fallbackReason}. Using local analysis.`);
      },
    }),
  ).finally(() => {
    if (!scanDone) progress.stop();
  });
  ctx.lastReport = report;
  return report;
}

export function printReport(report) {
  process.stdout.write('\n' + renderSummaryTable(report) + '\n');
  process.stdout.write(renderDetails(report) + '\n\n');
}

export async function scanFlow(ctx, presetAddress = null) {
  assertScanReady(ctx.config);
  let address = presetAddress ?? (await askAddress());
  for (;;) {
    let report;
    try {
      report = await performScan(ctx, address);
    } catch (e) {
      if (e instanceof CancelledError) {
        process.stdout.write(c.yellow('Scan cancelled.\n'));
        return;
      }
      throw e;
    }
    printReport(report);
    const next = await postScanMenu(ctx, report);
    if (next === 'rescan') continue;
    if (next === 'new') {
      address = await askAddress();
      continue;
    }
    return;
  }
}

async function postScanMenu(ctx, report) {
  for (;;) {
    const action = await choose('Next step:', [
      { name: 'Rescan this token', value: 'rescan' },
      { name: 'View cluster details', value: 'clusters', disabled: report.clusters.clusters.length ? false : '(no clusters)' },
      { name: 'View early-activity transaction hashes', value: 'txs', disabled: report.earlyActivity.activities.length ? false : '(no activity)' },
      { name: 'Export JSON report', value: 'export' },
      { name: 'Scan another token', value: 'new' },
      { name: 'Back to main menu', value: 'back' },
    ]);
    if (action === 'clusters') await clusterDetailFlow(report);
    else if (action === 'txs') process.stdout.write('\n' + renderTxHashes(report) + '\n\n');
    else if (action === 'export') exportReport(report);
    else return action;
  }
}

async function clusterDetailFlow(report) {
  const list = report.clusters.clusters;
  const pick = await choose(
    'Choose a cluster:',
    [...list.map((cl) => ({ name: `${clusterLabelColor(cl.label)(`[${cl.id}] ${cl.label}`)} · ${cl.wallets.length} wallets · ${cl.confidence}`, value: cl.id })), { name: 'Back', value: null }],
  );
  if (!pick) return;
  process.stdout.write('\n' + renderClusterDetail(list.find((x) => x.id === pick), report.network.explorerUrl) + '\n\n');
}

export function exportReport(report) {
  const file = saveReport(report);
  process.stdout.write(c.green(`✓ Report saved: ${file}\n`));
  return file;
}

export async function exportFlow(ctx) {
  if (!ctx.lastReport && !ctx.lastWalletReport) {
    process.stdout.write(c.yellow('No analysis results in this session yet. Run a scan first.\n'));
    return;
  }
  const choices = [];
  if (ctx.lastReport) choices.push({ name: `Latest token scan: ${ctx.lastReport.token.symbol ?? ctx.lastReport.token.address}`, value: 'token' });
  if (ctx.lastWalletReport) choices.push({ name: 'Latest wallet analysis', value: 'wallet' });
  choices.push({ name: 'Cancel', value: null });
  const pick = await choose('Which report to export?', choices);
  if (pick === 'token') exportReport(ctx.lastReport);
  if (pick === 'wallet') exportReport(ctx.lastWalletReport);
}

export async function reportsFlow() {
  for (;;) {
    const reports = listReports();
    if (!reports.length) {
      process.stdout.write(c.dim('No saved reports yet.\n'));
      return;
    }
    const pick = await choose('Saved reports (newest first):', [
      ...reports.slice(0, 30).map((r) => ({
        name: r.error ? `${r.name} ${c.red('(corrupt)')}` : `${r.token} · ${r.score ?? '-'} · ${r.level ?? '-'} · ${r.analyzedAt?.slice(0, 19).replace('T', ' ') ?? '-'}`,
        value: r.name,
        description: r.name,
      })),
      { name: 'Back', value: null },
    ]);
    if (!pick) return;
    const action = await choose(`Report ${pick}:`, [
      { name: 'Show', value: 'view' },
      { name: 'Delete this report', value: 'delete' },
      { name: 'Back', value: 'back' },
    ]);
    if (action === 'view') {
      try {
        const r = loadReport(pick);
        if (r.scoring) printReport(r);
        else process.stdout.write(toJson(r).slice(0, 4000) + '\n');
      } catch (e) {
        process.stdout.write(c.red(`Failed to read report: ${e.message}\n`));
      }
    } else if (action === 'delete') {
      const ok = await askConfirm(`Permanently delete ${pick}? This cannot be undone.`, false);
      if (ok) {
        deleteReport(pick, { confirmed: true });
        process.stdout.write(c.green('✓ Report deleted.\n'));
      }
    }
  }
}

export async function walletClusterFlow(ctx) {
  assertScanReady(ctx.config);
  const wallets = await askAddressList();
  const progress = createStageProgress(
    [
      { id: 'network', label: 'Verifying network' },
      { id: 'funding', label: 'Fetching funding history (explorer)' },
      { id: 'clusters', label: 'Detecting clusters' },
    ],
    {},
  );
  let res;
  try {
    res = await withCancel((signal) => analyzeWalletSet({ rpc: ctx.rpc, explorer: ctx.explorer, config: ctx.config, wallets, labels: ctx.labels, onStage: progress.onStage, signal }));
  } finally {
    progress.stop();
  }
  process.stdout.write('\n');
  if (!res.clusters.length) process.stdout.write(c.dim('No funding links observed between these wallets.\n'));
  for (const cl of res.clusters) process.stdout.write(renderClusterDetail(cl, ctx.config.network.explorerUrl) + '\n\n');
  if (res.excludedFunders.length) process.stdout.write(c.dim(`${res.excludedFunders.length} funder(s) suspected to be public services were excluded.\n`));
  ctx.lastWalletReport = serializable({
    app: { name: 'RING-HUNTER AI', version: APP_VERSION },
    type: 'WALLET_CLUSTER',
    analyzedAt: new Date().toISOString(),
    network: { key: ctx.config.network.key, name: ctx.config.network.name, chainId: ctx.config.network.chainId },
    token: { symbol: 'WALLETS', address: res.wallets[0] },
    wallets: res.wallets,
    clusters: res.clusters,
    excludedFunders: res.excludedFunders,
    edges: res.funding.graph.edges,
    coverage: res.funding.coverage,
    disclaimer: 'On-chain correlation is not proof of shared ownership.',
  });
  if (await askConfirm('Export results to JSON?', false)) exportReport(ctx.lastWalletReport);
}

export async function devWalletFlow(ctx) {
  assertScanReady(ctx.config);
  const address = await askAddress('Developer/deployer address (0x…):');
  const spinner = ora({ text: 'Analyzing developer wallet…', color: 'cyan' }).start();
  let res;
  try {
    res = await withCancel((signal) => analyzeDeveloperWallet({ rpc: ctx.rpc, explorer: ctx.explorer, config: ctx.config, address, labels: ctx.labels, signal }));
    spinner.succeed('Developer wallet analysis done');
  } catch (e) {
    spinner.fail('Analysis failed');
    throw e;
  }
  const t = new Table({ colWidths: [24, 60], wordWrap: true, style: { border: ['gray'] } });
  t.push([c.label('Address'), res.address], [c.label('Type'), res.isContract ? 'Contract' : 'EOA'], [c.label('Nonce (outgoing tx count)'), String(res.nonce)], [c.label(`${res.nativeSymbol} balance`), res.balanceEth], [c.label('Pons v2 launches'), res.ponsLaunchCount == null ? 'n/a on this network' : String(res.ponsLaunchCount)]);
  process.stdout.write('\n' + t.toString() + '\n');
  if (res.launches.length) {
    const lt = new Table({ head: ['Token', 'Address', 'Block', 'Tx'], colWidths: [16, 16, 12, 22], style: { head: ['cyan'], border: ['gray'] } });
    for (const l of res.launches) lt.push([l.symbol ?? '?', shortAddr(l.token), l.blockNumber, shortAddr(l.txHash)]);
    process.stdout.write(c.title('\nLatest Pons launches (max. 20):\n') + lt.toString() + '\n');
    if (res.ponsLaunchCount >= 5) process.stdout.write(c.yellow(`! This deployer launched ${res.ponsLaunchCount} tokens. Many launches is an indicator worth checking, not proof of bad intent.\n`));
  }
  if (res.funding) {
    const sym = res.nativeSymbol;
    const ft = new Table({ head: ['Funding source', 'Tx', `Total ${sym}`, 'Label'], colWidths: [16, 6, 16, 26], style: { head: ['cyan'], border: ['gray'] } });
    for (const f of res.funding.topFunders) ft.push([shortAddr(f.address), f.count, tokenAmount(f.total, 18, 4), f.label ?? '-']);
    process.stdout.write(c.title(`\nTop ${sym} funding sources:\n`) + ft.toString() + '\n');
    const rt = new Table({ head: [`${sym} recipient`, 'Tx', `Total ${sym}`, 'Label'], colWidths: [16, 6, 16, 26], style: { head: ['cyan'], border: ['gray'] } });
    for (const f of res.funding.topRecipients) rt.push([shortAddr(f.address), f.count, tokenAmount(f.total, 18, 4), f.label ?? '-']);
    process.stdout.write(c.title(`Top ${sym} recipients:\n`) + rt.toString() + '\n');
  }
  for (const l of res.limitations) process.stdout.write(c.dim(`• ${l}\n`));
  ctx.lastWalletReport = serializable({ app: { name: 'RING-HUNTER AI', version: APP_VERSION }, type: 'DEVELOPER_WALLET', analyzedAt: new Date().toISOString(), network: { key: ctx.config.network.key, name: ctx.config.network.name, chainId: ctx.config.network.chainId }, token: { symbol: 'DEV', address: res.address }, ...res });
  process.stdout.write('\n');
}

/** Config check + live connection test (read-only). */
export async function configCheckFlow(ctx, { interactive = true } = {}) {
  const t = new Table({ colWidths: [28, 56], wordWrap: true, style: { border: ['gray'] } });
  for (const [k, v] of describeConfig(ctx.config)) t.push([c.label(k), String(v)]);
  process.stdout.write('\n' + t.toString() + '\n');

  const results = [];
  if (ctx.config.rpcUrl && ctx.config.chainId) {
    const spinner = ora('Testing RPC connection…').start();
    try {
      const t0 = Date.now();
      const [chainId, block] = await Promise.all([ctx.rpc.chainId(), ctx.rpc.blockNumber()]);
      const ms = Date.now() - t0;
      if (chainId !== ctx.config.chainId) {
        spinner.fail(`RPC reports chain ID ${chainId}, config says ${ctx.config.chainId} — MISMATCH`);
        results.push(false);
      } else {
        spinner.succeed(`RPC OK · chain ID ${chainId} · block ${block} · ${ms} ms`);
        results.push(true);
      }
    } catch (e) {
      spinner.fail(`RPC failed: ${safeErrorMessage(e)}`);
      results.push(false);
    }
  } else {
    process.stdout.write(c.yellow('! RPC/chain ID not configured — scans cannot run.\n'));
    results.push(false);
  }

  if (ctx.explorer) {
    const spinner = ora('Testing Blockscout API…').start();
    try {
      await ctx.explorer.txList('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', { offset: 1 });
      spinner.succeed('Blockscout API OK');
    } catch (e) {
      spinner.fail(`Blockscout API failed: ${safeErrorMessage(e)}`);
    }
  }

  const ai = aiStatus(ctx.config);
  if (ai.ready && interactive && (await askConfirm(`Send a small test request to ${ai.provider} (${ai.model})? (uses a little quota)`, false))) {
    const spinner = ora(`Testing ${ai.provider}…`).start();
    try {
      const { createProvider } = await import('../ai/providers.js');
      const p = await createProvider(ctx.config.ai);
      const text = await p.generate('Reply only with the JSON {"ok":true}.', [{ role: 'user', content: 'ping' }]);
      spinner.succeed(`${ai.provider} responded (${String(text).slice(0, 40)})`);
    } catch (e) {
      spinner.fail(safeErrorMessage(e));
    }
  }
  process.stdout.write('\n');
  return results.every(Boolean);
}
