// RING-HUNTER Pro hosted services: a scan queue (the same read-only pipeline as the CLI, local analysis — no AI
// keys on the server), the watchlist re-scanner, and the Pons v2 new-launch feed.
// Scans run one at a time so a small VPS and the public RPC are never flooded.
import { randomBytes } from 'node:crypto';
import { getAddress } from 'ethers';
import { runFullScan } from '../src/core/pipeline.js';
import { buildConfig } from '../src/config/env.js';
import { NETWORK, PONS } from '../src/config/networks.js';
import { createRpcClient, createHttpTransport } from '../src/adapters/evm/rpcClient.js';
import { createExplorerClient } from '../src/adapters/evm/explorerAdapter.js';
import { createLabelRegistry } from '../src/config/labels.js';
import { PONS_FACTORY, TOPICS } from '../src/adapters/evm/abis.js';
import { redact } from '../src/utils/redact.js';

export const REPORT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const SCAN_TIMEOUT_MS = 10 * 60_000;
export const WATCH_INTERVAL_MS = 6 * 60 * 60_000;
const LAUNCH_BACKFILL_BLOCKS = 2_000_000;

/** Read-only scan context for the server (no terminal UI). RH_RPC_URL / RH_EXPLORER_KEY are optional. */
export function createScanContext(env = process.env) {
  const config = buildConfig({
    ROBINHOOD_CHAIN_RPC: env.RH_RPC_URL || NETWORK.defaultRpc,
    ROBINHOOD_CHAIN_ID: String(NETWORK.chainId),
    AI_PROVIDER: 'none',
    BLOCK_EXPLORER_API_KEY: env.RH_EXPLORER_KEY || undefined,
  });
  const rpc = createRpcClient(createHttpTransport({ url: config.rpcUrl, timeoutMs: config.rpcTimeoutMs }));
  const x = config.explorer;
  const explorer = x ? createExplorerClient({ apiKey: x.apiKey, baseUrl: x.baseUrl, chainParam: x.chainParam, provider: x.provider, chainId: config.network.chainId, timeoutMs: config.rpcTimeoutMs }) : null;
  return { config, rpc, explorer, labels: createLabelRegistry([]) };
}

const newReportId = () => randomBytes(16).toString('base64url');

/**
 * @param {{db:object, ctx?:object, scan?:(token:string, signal:AbortSignal)=>Promise<object>, now?:()=>number, log?:(m:string)=>void}} p
 */
export function createHostedService({ db, ctx = null, scan, now = () => Date.now(), log = (m) => process.stderr.write(m + '\n') }) {
  const doScan = scan ?? ((token, signal) => runFullScan(ctx, token, { useAi: false, signal }));
  const queue = [];
  let busy = false;
  let idle = Promise.resolve();
  let release = () => {};
  const timers = [];

  async function runOne(job) {
    db.startReport(job.id);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), SCAN_TIMEOUT_MS);
    try {
      const report = await doScan(job.token, ac.signal);
      const s = report.scoring ?? {};
      const score = Number.isFinite(s.score) ? Math.round(s.score) : null;
      db.finishReport(job.id, { symbol: report.token?.symbol ?? null, score, level: s.level ?? null, json: JSON.stringify(report) }, now());
      if (job.watch) db.recordWatchScan(job.token, job.id, score, s.level ?? null, now());
    } catch (e) {
      const msg = ac.signal.aborted ? 'Scan timed out' : redact(String(e?.message ?? e)).slice(0, 300);
      db.failReport(job.id, msg, now());
      if (job.watch) db.recordWatchScan(job.token, job.id, null, null, now());
    } finally {
      clearTimeout(t);
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    idle = new Promise((ok) => (release = ok));
    try {
      while (queue.length) await runOne(queue.shift());
    } finally {
      busy = false;
      release();
    }
  }

  function enqueue(owner, token, { watch = false } = {}) {
    const id = newReportId();
    const t = getAddress(token);
    db.addReport(id, owner, t, now());
    queue.push({ id, token: t, watch });
    pump();
    return id;
  }

  /** Queue a re-scan for every watched token whose last scan is older than WATCH_INTERVAL_MS. */
  function watchTick() {
    const queued = new Set(queue.filter((j) => j.watch).map((j) => j.token));
    let n = 0;
    for (const { token, scanned_at } of db.watchedTokens()) {
      if (queued.has(token) || (scanned_at && now() - scanned_at < WATCH_INTERVAL_MS)) continue;
      enqueue(null, token, { watch: true });
      n++;
    }
    return n;
  }

  /** Pull new Pons v2 TokenLaunched logs since the last checked block. */
  async function launchesTick(rpc = ctx?.rpc) {
    if (!rpc) return 0;
    const latest = await rpc.blockNumber();
    const saved = Number(db.getKv('launches_next_block') ?? NaN);
    const fromBlock = Number.isFinite(saved) ? saved : Math.max(0, latest - LAUNCH_BACKFILL_BLOCKS);
    if (fromBlock > latest) return 0;
    const res = await rpc.getLogsChunked({ address: PONS.factory, topics: [TOPICS.TokenLaunched], fromBlock, toBlock: latest, maxLogs: 5_000 });
    const rows = res.logs.map((l) => {
      const ev = PONS_FACTORY.parseLog(l);
      return { token: getAddress(ev.args.token), deployer: getAddress(ev.args.deployer), block: Number(BigInt(l.blockNumber)), txHash: l.transactionHash };
    });
    db.addLaunches(rows);
    if (res.complete) db.setKv('launches_next_block', latest + 1);
    return rows.length;
  }

  return {
    enqueue,
    watchTick,
    launchesTick,
    queueLength: () => queue.length + (busy ? 1 : 0),
    /** Resolves when the queue is empty (tests). */
    drain: async () => {
      while (busy || queue.length) await idle;
    },
    start() {
      const failed = db.resetStaleReports();
      if (failed) log(`hosted: marked ${failed} interrupted scan(s) as failed`);
      const safe = (fn, name) => () => Promise.resolve().then(fn).catch((e) => log(`hosted ${name}: ${redact(String(e?.message ?? e))}`));
      const watch = safe(watchTick, 'watchlist');
      const launches = safe(() => launchesTick(), 'launches');
      timers.push(setInterval(watch, 15 * 60_000), setInterval(launches, 5 * 60_000));
      for (const t of timers) t.unref();
      watch();
      launches();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  };
}
