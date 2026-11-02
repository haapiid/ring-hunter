// Terminal report renderer. Works from the serialized report object (buildReport),
// so fresh scans and old reports are displayed by the same code.
import Table from 'cli-table3';
import { c, scoreColor, levelText, clusterLabelColor } from './theme.js';
import { shortAddr, shortHash, pct, tokenAmount } from '../utils/format.js';
import { COMPONENT_NAMES } from '../ai/fallbackAnalysis.js';

const tableWidth = () => Math.min(100, Math.max(60, (process.stdout.columns || 90) - 2));

function kvTable(rows) {
  const w = tableWidth();
  const t = new Table({ colWidths: [24, w - 27], wordWrap: true, style: { head: [], border: ['gray'] } });
  for (const [k, v] of rows) t.push([c.label(k), v ?? c.dim('-')]);
  return t.toString();
}

const coverageText = (r) => `${Math.round((r.scoring?.coverage ?? 0) * 100)}%${r.holders?.status === 'PARTIAL' || r.fundingGraph?.coverage?.nativeFunding !== 'COMPLETE_FOR_TARGETS' ? ' (PARTIAL DATA)' : ''}`;

/** Main summary table. */
export function renderSummaryTable(r) {
  const s = r.scoring;
  const color = scoreColor(s.score);
  const cs = r.clusters.summary;
  const tokenLabel = `${r.token.name ?? '?'} (${r.token.symbol ?? '?'})`;
  const creator = r.origin.creator ? `${r.origin.creator}\n${c.dim(`${r.origin.status} · ${r.origin.method}`)}` : c.dim(`unknown (${r.origin.status})`);
  const supply = cs.estimatedClusterSupplyPct == null ? c.dim('not available') : `${pct(cs.estimatedClusterSupplyPct)} ${c.dim('ESTIMATED CLUSTER-ASSOCIATED')}`;
  const dev = cs.estimatedDeveloperSupplyPct == null ? null : `${pct(cs.estimatedDeveloperSupplyPct)} ${c.dim('ESTIMATED DEVELOPER-ASSOCIATED')}`;
  const scoreText = s.score == null ? c.dim('cannot be computed') : color.bold(`${s.score} / 100`);
  const levelLine = s.displayLevel === 'INSUFFICIENT_DATA' && s.score != null ? `${color(levelText(s.level))} ${c.yellow('· INSUFFICIENT DATA (low coverage)')}` : color(levelText(s.displayLevel));
  return kvTable([
    ['Token', tokenLabel],
    ['Contract', r.token.address],
    ['Network', `${r.network.name} (chain ID ${r.network.chainId})`],
    ['Creator', creator],
    ['DEV RISK SCORE', scoreText],
    ['Risk Level', levelLine],
    ['Cluster Count', `${cs.meaningfulCount} ${c.dim(`≥ POSSIBLE_CLUSTER (total groups: ${cs.total})`)}`],
    ['Related Wallets', String(cs.meaningfulWalletCount)],
    ['Est. Cluster Supply', supply],
    ...(dev ? [['Est. Developer Supply', dev]] : []),
    ['Confidence', s.confidence],
    ['Data Coverage', coverageText(r)],
  ]);
}

function section(title) {
  return `\n${c.magenta('▌')} ${c.title(title)}\n`;
}

const bullets = (list, color = (x) => x) => (list?.length ? list.map((x) => `  • ${color(x)}`).join('\n') : c.dim('  (none)'));

/** Detailed report after the table. */
export function renderDetails(r) {
  const out = [];
  const a = r.analysis;
  out.push(section(`Summary ${a.source === 'ai' ? `(AI: ${a.provider}/${a.model})` : '(local analysis)'}`));
  out.push('  ' + a.summary);
  if (a.fallback_reason) out.push(c.dim(`  Note: AI not used — ${a.fallback_reason}`));

  out.push(section('Score Components'));
  const t = new Table({ head: ['Component', 'Weight', 'Score', 'Status'], colWidths: [28, 8, 8, 16], style: { head: ['cyan'], border: ['gray'] } });
  for (const [k, comp] of Object.entries(r.scoring.components)) {
    t.push([COMPONENT_NAMES[k] ?? k, `${comp.weight}%`, comp.score == null ? c.dim('—') : scoreColor(comp.score)(String(comp.score)), comp.status === 'not_assessed' ? c.dim('not assessed') : comp.status === 'partial' ? c.yellow('partial') : 'scored']);
  }
  out.push(t.toString());
  out.push(c.dim('  ' + r.scoring.disclaimer));

  out.push(section('RISK FACTORS'));
  out.push(bullets(a.risk_factors, c.red));
  out.push(section('POSITIVE SIGNALS'));
  out.push(bullets(a.positive_signals, c.green));

  out.push(section('Wallet Cluster Evidence'));
  const clusters = r.clusters.clusters;
  if (!clusters.length) out.push(c.dim('  No clusters/groups observed in the available data.'));
  for (const cl of clusters.slice(0, 8)) {
    out.push(`  ${clusterLabelColor(cl.label)(`[${cl.id}] ${cl.label}`)} ${c.dim(`· confidence ${cl.confidence} · ${cl.wallets.length} wallets · supply ${pct(cl.supply?.pct)}`)}`);
    out.push(c.dim(`      ${cl.reason}`));
  }
  if (clusters.length > 8) out.push(c.dim(`  … ${clusters.length - 8} more (see "View cluster details").`));
  if (r.clusters.excludedFunders?.length) out.push(c.dim(`  ${r.clusters.excludedFunders.length} funder(s) suspected to be public services were excluded from grouping.`));

  out.push(section('Contract Warnings'));
  const f = r.contract.findings ?? [];
  out.push(f.length ? f.map((x) => `  • ${c.yellow(x.title)} ${c.dim(`[${x.level}]`)}\n    ${c.dim(x.detail)}`).join('\n') : c.dim('  No privilege findings from the heuristic checks.'));
  out.push(c.dim(`  Owner: ${r.contract.ownerStatus}${r.contract.owner ? ` (${r.contract.owner})` : ''}${r.contract.proxy ? ` · Proxy: ${r.contract.proxy.type}` : ''}`));
  const notChecked = (r.contract.checks ?? []).filter((x) => x.status !== 'CHECKED');
  if (notChecked.length) out.push(c.dim(`  Not checked / cannot be checked: ${notChecked.map((x) => x.id).join(', ')}`));

  out.push(section('Liquidity & Holder'));
  const pools = r.pools ?? [];
  const ps = r.poolSelection;
  out.push(`  Venue: ${r.origin.launch ? `Pons v2 curve ${shortAddr(r.origin.launch.curve)}` : 'not a Pons launch'}; main Uniswap V4 pools: ${pools.length}${pools.some((p) => p.isPonsPool) ? ' (Pons hook)' : ''}${ps?.othersCount ? c.dim(` · ${ps.othersCount} other pools not analyzed`) : ''}`);
  const h = r.holders.summary;
  out.push(
    h
      ? `  Holder: ${h.sampleMode ? `unknown — SAMPLE of ${h.sampleSize} addresses (PARTIAL DATA)` : `${h.holderCount} (${r.holders.status})`} · top-10 wallet ${pct(h.top10WalletPct)} · LP/curve ${pct(h.lpAndCurvePct)} · burn ${pct(h.burnPct)}`
      : c.dim(`  Holder data not available: ${r.holders.reason ?? r.holders.status}`),
  );

  out.push(section('DATA COVERAGE'));
  out.push(
    bullets([
      `Coverage score: ${coverageText(r)} · confidence ${r.scoring.confidence}`,
      `Early trades: ${r.earlyActivity.coverage.tradesFetched}/${r.earlyActivity.coverage.limit} (${r.earlyActivity.coverage.complete ? 'complete' : 'partial'})`,
      `Holder: ${r.holders.status} · ${r.holders.transferCount} transfers processed`,
      `Native-coin funding: ${r.fundingGraph.coverage.nativeFunding}`,
      ...r.scoring.confidenceReasons.map((x) => `Confidence: ${x}`),
    ]),
  );
  out.push(section('ANALYSIS LIMITATIONS'));
  out.push(bullets(a.limitations, c.dim));
  out.push(section('Possible False Positives'));
  out.push(bullets(a.false_positive_notes, c.dim));
  out.push(section('UNVERIFIED ASSUMPTIONS'));
  out.push(
    bullets(
      [
        'Trade owners are attributed from Transfer logs in the receipt; smart wallets or intermediary contracts can still mask the real owner.',
        'Correlated wallets are not assumed to be owned by the same person.',
        r.origin.status !== 'VERIFIED' ? 'Creator is only indicative or unknown.' : 'Creator = deployer from launch evidence; owner/admin may be a different address.',
      ],
      c.dim,
    ),
  );
  out.push(section('Disclaimer'));
  out.push(c.dim('  ' + r.disclaimer));
  return out.join('\n');
}

/** Detail of one cluster with transaction evidence. */
export function renderClusterDetail(cl, explorerUrl) {
  const out = [];
  out.push(`${clusterLabelColor(cl.label).bold(`[${cl.id}] ${cl.label}`)} ${c.dim(`confidence ${cl.confidence} · basis ${cl.basis}`)}`);
  out.push(`  Reason: ${cl.reason}`);
  out.push(`  Member supply (current): ${pct(cl.supply?.pct)}`);
  out.push(c.label('  Wallets:'));
  for (const w of cl.wallets) out.push(`    ${w.address} ${c.dim([...(w.roles || []), w.isSharedFunder ? 'SHARED_FUNDER' : null].filter(Boolean).join(', '))}`);
  out.push(c.label('  Indicators:'));
  for (const i of cl.indicators) out.push(`    • ${i.id} — ${c.dim(i.detail)}`);
  out.push(c.label('  Transaction evidence:'));
  if (!cl.evidence.length) out.push(c.dim('    (none)'));
  for (const e of cl.evidence.slice(0, 25)) {
    out.push(`    ${e.relation ?? '-'} ${e.from ? `${shortAddr(e.from)} → ${shortAddr(e.to)}` : ''} ${e.asset ? c.dim(`${e.asset}`) : ''} block ${e.blockNumber ?? '-'}`);
    out.push(c.dim(`      ${explorerUrl}/tx/${e.txHash}`));
  }
  if (cl.evidence.length > 25) out.push(c.dim(`    … ${cl.evidence.length - 25} more evidence items in the JSON report.`));
  out.push(c.label('  Alternative explanations:'));
  out.push(bullets(cl.alternatives, c.dim));
  out.push(c.label('  Limitations:'));
  out.push(bullets(cl.limitations, c.dim));
  return out.join('\n');
}

/** List of early-activity transaction hashes. */
export function renderTxHashes(r) {
  const t = new Table({ head: ['#', 'Type', 'Block', 'Actor', 'Token amount', 'Tx hash'], colWidths: [5, 14, 12, 15, 18, 22], style: { head: ['cyan'], border: ['gray'] } });
  const dec = r.token.decimals ?? 18;
  r.earlyActivity.activities.forEach((x, i) => {
    t.push([i + 1, x.type, x.blockNumber ?? '-', shortAddr(x.actor), x.tokenAmount ? tokenAmount(x.tokenAmount, dec, 2) : '-', shortHash(x.txHash)]);
  });
  return `${t.toString()}\n${c.dim(`Explorer: ${r.network.explorerUrl}/tx/<hash> · full hashes are in the JSON report.`)}`;
}
