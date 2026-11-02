// Terminal demo on the right. Each section has a "scene" that is re-typed when the section comes into view.
// Content follows the real CLI output format, with numbers from a real scan report of the PXT1 test token
// (reports/PXT1-B6ea6642-*.json). This is a sample display — not a scan in progress.

const BANNER = [
  '  ___  ___  _  _   ___       _  _  _   _  _  _  _____  ___  ___ ',
  ' | _ \\|_ _|| \\| | / __| ___ | || || | | || \\| ||_   _|| __|| _ \\',
  ' |   / | | | .` || (_ ||___|| __ || |_| || .` |  | |  | _| |   /',
  ' |_|_\\|___||_|\\_| \\___|     |_||_| \\___/ |_|\\_|  |_|  |___||_|_\\',
];

const TOKEN = '0xB6ea66422c14F64Cf66FaE50F7d4914D4bAaC09B';
const DEPLOYER = '0x7afa1A5e0f491C367dbBA8A0be67A236f80FA90F';

// Lines: { cmd } is typed per character; { s: [[class, text], …] } appears per line; { pause } waits.
const cmd = (text, title) => ({ cmd: text, title });
const L = (...s) => ({ s });
const blank = { s: [['', '']] };

/**
 * cli-table3-style table with auto-computed column widths so the borders always line up.
 * rows: array of rows, each cell [text, class?]. head: optional header row.
 */
function table(rows, head = null) {
  const all = head ? [head, ...rows] : rows;
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => r[i][0].length)));
  const rule = (l, m, r) => L(['d', l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r]);
  const row = (cells, defCls) => L(...cells.flatMap(([t, cls], i) => [['d', i ? ' │ ' : '│ '], [cls ?? defCls(i), t.padEnd(widths[i])]]), ['d', ' │']);
  const out = [rule('┌', '┬', '┐')];
  if (head) out.push(row(head, () => 'b'), rule('├', '┼', '┤'));
  for (const r of rows) out.push(row(r, (i) => (i === 0 && !head ? 'b' : 'w')));
  out.push(rule('└', '┴', '┘'));
  return out;
}

function banner() {
  return [...BANNER.map((t) => ({ s: [['gd', t]], cls: 'bn' })),L(['m', '  AI'], ['d', ' · Developer Trust & Insider Ring Scanner v0.1.1']), L(['d', '  Read-only · Robinhood Chain (4663)']), blank];
}

export const SCENES = {
  hero: {
    title: 'ring-hunter',
    lines: [
      cmd('ring-hunter'),
      ...banner(),
      L(['g', '? '], ['h', 'Main menu'], ['d', ' (use arrow keys)']),
      L(['b', '❯ 1. Scan Token Contract']),
      L(['w', '  2. Analyze Wallet Cluster '], ['d', '(needs BLOCK_EXPLORER_API_KEY)']),
      L(['w', '  3. Analyze Developer Wallet']),
      L(['w', '  4. View Previous Reports']),
      L(['w', '  5. Export Report']),
      L(['w', '  6. Configuration Check']),
      L(['w', '  7. Exit']),
    ],
  },
  install: {
    title: 'ring-hunter — setup',
    lines: [
      cmd('npm install -g ring-hunter-ai'),
      blank,
      cmd('ring-hunter init'),
      L(['g', '✓ '], ['w', 'Config directory: ~/.ring-hunter']),
      L(['g', '✓ '], ['w', 'Created config file: ~/.ring-hunter/.env']),
      L(['g', '✓ '], ['w', 'Reports folder: ~/.ring-hunter/reports']),
      blank,
      cmd('ring-hunter check'),
      ...table([
        [['ROBINHOOD_CHAIN_RPC'], ['https://rpc.mainnet.chain.robinhood.com']],
        [['ROBINHOOD_CHAIN_ID'], ['4663']],
        [['AI status'], ['inactive — AI_PROVIDER=none (local analysis mode)']],
        [['GROQ_API_KEY'], ['empty']],
        [['BLOCK_EXPLORER_API_KEY'], ['empty (funding graph PARTIAL)', 'y']],
      ]),
      { pause: 500 },
      L(['g', '✔ '], ['w', 'RPC OK · chain ID 4663 · block 104200115 · 539 ms']),
    ],
  },
  scan: {
    title: 'ring-hunter scan',
    lines: [
      cmd(`ring-hunter scan ${TOKEN.slice(0, 10)}…C09B --no-ai`),
      ...banner().slice(4),
      ...[
        ['Connecting to RPC', ''],
        ['Verifying network', 'Robinhood Chain (chain ID 4663)'],
        ['Checking token contract', 'PXTEST1 (PXT1)'],
        ['Detecting creator & token origin', 'PONS_TOKEN_LAUNCHED → 0x7afa…A90F'],
        ['Finding liquidity pools', ''],
        ['Fetching early transactions', '7 trades'],
        ['Analyzing holder distribution', 'COMPLETE'],
        ['Building funding graph', '4 wallets · 4 links'],
        ['Detecting wallet clusters', '1 cluster/group (1 ≥ POSSIBLE)'],
        ['Analyzing contract risk', '0 findings'],
        ['Computing risk score', '43/100 (MODERATE RISK)'],
      ].flatMap(([label, detail], i) => [{ pause: 120 + (i === 5 || i === 6 ? 380 : 0) }, L(['g', '  ✓ '], ['w', label], ['d', detail ? ` — ${detail}` : ''])]),
      blank,
      ...table([
        [['Token'], ['PXTEST1 (PXT1)']],
        [['DEV RISK SCORE'], ['43 / 100', 'y']],
        [['Risk Level'], ['MODERATE RISK', 'y']],
        [['Cluster Count'], ['1 ≥ POSSIBLE_CLUSTER (total groups: 1)']],
        [['Confidence'], ['MEDIUM']],
        [['Data Coverage'], ['83% (PARTIAL DATA)']],
      ]),
    ],
  },
  cluster: {
    title: 'ring-hunter-ai — cluster detail',
    lines: [
      L(['g', '? '], ['h', 'Next step: '], ['b', 'View cluster details']),
      blank,
      L(['r', '[C1] STRONG_CORRELATION'], ['d', ' confidence MEDIUM · basis FUNDING_AND_TRANSFERS']),
      L(['w', '  Reason: 4 direct transfers between members; cluster includes']),
      L(['w', '  the deployer address; ≥2 members bought within 2 blocks']),
      blank,
      L(['h', '  Wallets:']),
      L(['w', `    ${DEPLOYER.slice(0, 22)}…`], ['r', ' DEPLOYER'], ['d', ', EARLY_TRADER']),
      L(['w', '    0xa2123c3A5Fa6EE5565…'], ['d', ' EARLY_TRADER']),
      L(['w', '    0x2b37C2445986714f40…'], ['d', ' EARLY_TRADER, TX_SENDER']),
      L(['w', '    0x4F2Dd11466B8CCc02A…'], ['d', ' EARLY_TRADER, TX_SENDER']),
      blank,
      L(['h', '  Indicators:']),
      L(['y', '    • DIRECT_TRANSFER'], ['d', ' — 4 direct transfers between members']),
      L(['y', '    • DEPLOYER_LINKED'], ['d', ' — cluster includes the deployer address']),
      L(['y', '    • COORDINATED_BUY_TIMING'], ['d', ' — ≥2 members bought within 2 blocks']),
      blank,
      L(['h', '  Transaction evidence:']),
      L(['r', '    EXECUTED_FOR_OTHER'], ['d', ' 0x2b37…8b92 → 0xa212…A819  6.64M PXT1']),
      L(['b', '    TOKEN_TRANSFER    '], ['d', ' 0x2b37…8b92 → 0x7afa…A90F  6.49M PXT1']),
      blank,
      L(['d', '  Alternative explanations: payments, OTC, airdrops, a public team…']),
    ],
  },
  score: {
    title: 'ring-hunter-ai — score components',
    lines: [
      L(['h', '▌ Score Components']),
      ...table(
        [
          ['Funding correlation', '25%', '100', 'r', 'partial'],
          ['Cluster-linked supply', '20%', '0', 'g', 'scored'],
          ['Early-buyer coordination', '15%', '100', 'r', 'scored'],
          ['Contract privileges', '20%', '0', 'g', 'scored'],
          ['Liquidity risk', '10%', '25', 'g', 'partial'],
          ['Holder concentration', '10%', '0', 'g', 'scored'],
        ].map(([n, w, s, cls, st]) => [[n], [w], [s, cls], [st, st === 'partial' ? 'y' : 'w']]),
        [['Component'], ['Weight'], ['Score'], ['Status']],
      ),
      L(['d', '  The score is a heuristic model, not a rug-pull probability.']),
      blank,
      L(['h', '▌ DATA COVERAGE']),
      L(['w', '  • Coverage score: 83% (PARTIAL DATA) · confidence MEDIUM']),
      L(['w', '  • Early trades: 7/50 (complete)']),
      L(['w', '  • Native ETH funding: '], ['y', 'NONE']),
      L(['d', '  • Confidence: capped at MEDIUM without ETH funding data']),
    ],
  },
  ai: {
    title: 'ring-hunter-ai — summary',
    lines: [
      L(['m', '⠋ '], ['w', 'AI Engine is analyzing observed wallet correlations...']),
      { pause: 900 },
      L(['g', '✔ '], ['w', 'AI summary done (groq/<your model>)']),
      blank,
      L(['h', '▌ Summary (AI)']),
      L(['w', '  The deterministic engine gave PXT1 a score of 43/100 with a']),
      L(['w', '  moderate observed risk level; data coverage 83%, confidence MEDIUM.']),
      L(['w', '  1 correlated cluster with 4 wallets was detected.']),
      blank,
      L(['h', '▌ Anti-hallucination validation']),
      L(['g', '  ✓ '], ['d', 'every address/hash exists in the input data']),
      L(['g', '  ✓ '], ['d', 'every "N/100" equals the engine score']),
      L(['g', '  ✓ '], ['d', 'every percentage matches an input number (±0.05)']),
      L(['y', '  ! '], ['d', 'failed 2× → fall back to local analysis']),
      blank,
      L(['y', '  ⚠ '], ['w', 'AI not used — AI_PROVIDER=none (local analysis mode). Using local analysis.']),
    ],
  },
  wallet: {
    title: 'ring-hunter-ai — developer wallet',
    dynamic: true,
  },
  account: {
    title: 'ring-hunter — account (optional)',
    lines: [
      L(['d', '# key copied from the dashboard after signing in']),
      cmd('ring-hunter login'),
      L(['g', '? '], ['h', 'Paste your RING-HUNTER API key (from the website dashboard): '], ['d', '****************']),
      L(['g', '✓ '], ['w', 'Logged in as <your wallet address>']),
      L(['d', '  Scans work the same with or without an account.']),
      blank,
      cmd('ring-hunter whoami'),
      L(['g', '✓ '], ['w', 'Logged in as <your wallet address>']),
    ],
  },
  launchpad: {
    title: 'launchpad → ring-hunter',
    lines: [
      L(['d', '# token address copied from the launchpad page']),
      cmd(`ring-hunter scan ${TOKEN.slice(0, 10)}…C09B --no-ai`),
      L(['d', '  source: '], ['w', 'Pons Factory TokenLaunched']),
      L(['d', '  score:  '], ['y', '43 · MODERATE_RISK'], ['d', ' · coverage 83%']),
    ],
  },
  commands: {
    title: 'ring-hunter — reports',
    lines: [
      cmd(`ring-hunter scan ${TOKEN.slice(0, 10)}…C09B --save`),
      L(['d', '  … 11 stages …']),
      L(['g', '✓ '], ['w', 'Report saved: ~/.ring-hunter/reports/PXT1-B6ea6642-2026-11-02T12-03-44-404Z.json']),
      blank,
      cmd('ring-hunter'),
      L(['g', '? '], ['h', 'Main menu '], ['b', '4. View Previous Reports']),
      L(['g', '? '], ['h', 'Saved reports (newest first):']),
      L(['b', '❯ PXT1 · 43 · MODERATE_RISK · 2026-11-02 12:03:44']),
      L(['w', '  Back']),
    ],
  },
};

/** The wallet scene is built from the connected address (or a placeholder). */
export function walletScene(address) {
  const a = address || '0x… (connect a wallet)';
  return [
    cmd('ring-hunter'),
    L(['g', '? '], ['h', 'Main menu '], ['b', '3. Analyze Developer Wallet']),
    L(['g', '? '], ['h', 'Developer/deployer address (0x…): '], ['gd', a]),
    { pause: 400 },
    L(['g', '✔ '], ['w', 'Developer wallet analysis done']),
    ...table([
      [['Address'], [address ? `${address.slice(0, 18)}…${address.slice(-6)}` : '—']],
      [['Type'], ['EOA / contract (from eth_getCode)']],
      [['Nonce (outgoing tx count)'], ['from eth_getTransactionCount']],
      [['Pons v2 launches'], ['from the Factory TokenLaunched event']],
    ]),
    blank,
    L(['d', '  Read-only: no signatures, no transactions.']),
  ];
}

/** Terminal player: types a scene, cancellable when another scene is selected. */
export function createTerminal(pre, titleEl) {
  let token = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function lineEl(segs) {
    const div = document.createElement('div');
    for (const [cls, text] of segs) {
      const sp = document.createElement('span');
      if (cls) sp.className = cls;
      sp.textContent = text;
      div.append(sp);
    }
    if (!segs.some(([, t]) => t)) div.append('\u00a0');
    return div;
  }

  async function play(lines, title) {
    const my = ++token;
    titleEl.textContent = title;
    pre.textContent = '';
    const cursor = document.createElement('span');
    cursor.className = 'cur';
    for (const ln of lines) {
      if (my !== token) return;
      if (ln.pause) {
        if (!reduce) await sleep(ln.pause);
        continue;
      }
      if (ln.cmd != null) {
        const div = lineEl([['p', '❯ '], ['w', '']]);
        const target = div.lastChild;
        div.append(cursor);
        pre.append(div);
        for (const ch of reduce ? [ln.cmd] : ln.cmd) {
          if (my !== token) return;
          target.textContent += ch;
          await sleep(18 + Math.random() * 30);
        }
        await sleep(reduce ? 0 : 260);
        cursor.remove();
        continue;
      }
      const div = lineEl(ln.s);
      if (ln.cls) div.className = ln.cls;
      pre.append(div);
      // Auto-scroll when the output is taller than the window.
      pre.scrollTop = pre.scrollHeight;
      if (!reduce) await sleep(38);
    }
    if (my === token) {
      const div = lineEl([['p', '❯ ']]);
      div.append(cursor);
      pre.append(div);
      pre.scrollTop = pre.scrollHeight;
    }
  }
  return { play };
}
