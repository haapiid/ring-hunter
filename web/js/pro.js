// RING-HUNTER Pro section of the account dashboard.
// Payment is MANUAL: the user sends ETH from their own wallet app, then pastes the tx hash; the server verifies it
// on-chain. This page never asks the wallet for a transaction, approval, or any signature.
// Hosted scans, watchlist, and the Pons launch feed are server-side features of the same site (/api/*).
import { el, short, when, toast, copy, api, levelPill, EXPLORER } from './ui.js';

const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
let pollTimer = null;

const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const addrLink = (a) => link(`${EXPLORER}/address/${a}`, short(a));
const reportLink = (id, text = 'Open report') => el('a', { href: `report.html?id=${encodeURIComponent(id)}` }, text);
const msg = () => el('p', { class: 'wm-msg' });
const fail = (line, e) => {
  line.className = 'wm-msg err';
  line.textContent = e?.message || 'Something went wrong.';
};
const ok = (line, text) => {
  line.className = 'wm-msg';
  line.textContent = text;
};

/** Split pasted text into unique 0x addresses (comma/space/newline separated). */
function parseAddresses(text) {
  const parts = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !ADDR_RE.test(p));
  return { list: [...new Set(parts.filter((p) => ADDR_RE.test(p)).map((p) => p.toLowerCase()))], bad };
}

export async function mountPro(root, { address, hasKey }) {
  clearInterval(pollTimer);
  root.hidden = false;
  root.textContent = '';
  let pro;
  try {
    pro = await api('/api/pro');
  } catch (e) {
    root.append(el('h2', {}, 'RING-HUNTER Pro'), el('p', { class: 'wm-msg err' }, e.message));
    return;
  }
  root.append(el('h2', {}, 'RING-HUNTER Pro'), statusBlock(pro));
  if (!pro.active) {
    root.append(joinBlock(pro, address, () => mountPro(root, { address, hasKey })));
    return;
  }
  if (pro.payments) root.append(el('details', { class: 'pro-extend' }, el('summary', {}, 'Extend Pro'), joinBlock(pro, address, () => mountPro(root, { address, hasKey }))));
  const history = el('div', { class: 'pro-list' });
  root.append(
    scanBlock(pro, () => refreshHistory(history)),
    el('h3', {}, 'Your hosted scans'),
    history,
    watchBlock(pro),
    launchesBlock(() => refreshHistory(history)),
    el(
      'div',
      { class: 'pro-cli' },
      el('h3', {}, 'Hosted RPC for the CLI'),
      el('p', { class: 'small dim' }, hasKey ? 'If your internet provider blocks the public RPC, scan through this site’s read-only RPC:' : 'Create an API key above and run ring-hunter login, then:'),
      el('button', { class: 'cmd', type: 'button', onclick: () => copy('ring-hunter scan <token> --hosted-rpc', 'Copied') }, el('code', {}, 'ring-hunter scan <token> --hosted-rpc')),
    ),
  );
  refreshHistory(history);
}

function statusBlock(pro) {
  const rows = [];
  if (pro.active) {
    rows.push(el('div', {}, el('span', {}, 'Status'), el('span', { class: 'pill ok' }, 'Pro active')));
    if (pro.paidUntil) rows.push(el('div', {}, el('span', {}, 'Paid until'), el('span', {}, when(pro.paidUntil))));
    if (pro.tokenHolder?.qualifies) rows.push(el('div', {}, el('span', {}, 'Token holder'), el('span', {}, `${pro.tokenHolder.balance} tokens`)));
  } else {
    rows.push(el('div', {}, el('span', {}, 'Status'), el('span', { class: 'pill warn' }, 'Free')));
  }
  return el(
    'div',
    {},
    el('div', { class: 'wm-rows' }, ...rows),
    el('p', { class: 'small dim' }, `Pro adds server-side features: hosted scans with share links (up to ${pro.limits.batch} tokens at once, ${pro.limits.scansPerDay}/day), a watchlist of up to ${pro.limits.watchlist} tokens re-scanned every 6 hours, the new Pons launch feed, and a hosted read-only RPC for the CLI. Scanning in the CLI stays free.`),
  );
}

function joinBlock(pro, address, reload) {
  const box = el('div', { class: 'pro-join' });
  if (!pro.payments && !pro.token) {
    box.append(el('p', { class: 'wm-msg' }, 'Pro opens soon. Every CLI feature already works for free.'));
    return box;
  }
  if (pro.payments) {
    const p = pro.payments;
    const line = msg();
    const input = el('input', { type: 'text', placeholder: '0x… transaction hash', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Transaction hash' });
    const btn = el(
      'button',
      {
        class: 'btn-sm gold',
        type: 'button',
        onclick: async () => {
          const tx = input.value.trim();
          if (!TX_RE.test(tx)) return fail(line, new Error('Paste the full transaction hash: 0x followed by 64 characters.'));
          btn.disabled = true;
          ok(line, 'Checking the transaction on Robinhood Chain…');
          try {
            const r = await api('/api/pro/claim', { txHash: tx });
            toast(`Pro activated: +${r.days} days`);
            reload();
          } catch (e) {
            fail(line, e);
            btn.disabled = false;
          }
        },
      },
      'Verify payment',
    );
    box.append(
      el('h3', {}, `Pay with ETH · ${p.priceEth} ETH = ${p.days} days`),
      el(
        'ol',
        { class: 'pro-steps' },
        el('li', {}, 'In your wallet app, switch to ', el('b', {}, 'Robinhood Chain (chain ID 4663)'), '.'),
        el('li', {}, 'From the wallet you signed in with (', el('b', { class: 'mono' }, short(address)), '), send ', el('b', {}, `${p.priceEth} ETH`), ` (or a multiple, up to ${p.maxPeriodsPerTx}×) as a plain transfer to:`),
        el('li', { class: 'pro-treasury' }, el('button', { class: 'cmd', type: 'button', onclick: () => copy(p.treasury, 'Treasury address copied') }, el('code', {}, p.treasury)), el('span', { class: 'small dim' }, ' ', link(`${EXPLORER}/address/${p.treasury}`, 'view on explorer'))),
        el('li', {}, 'Paste the transaction hash here:'),
      ),
      el('div', { class: 'pro-form' }, input, btn),
      line,
      el('p', { class: 'small dim' }, 'Double-check the address before sending — on-chain transfers cannot be reversed. This page never asks your wallet to sign or send anything.'),
    );
  }
  if (pro.token) {
    box.append(
      el('h3', {}, pro.payments ? 'Or hold the RING-HUNTER token' : 'Hold the RING-HUNTER token'),
      el('p', { class: 'small' }, `Keep at least ${pro.token.minBalance} tokens of `, addrLink(pro.token.address), ' in this wallet — Pro turns on automatically (checked read-only, refreshed every 10 minutes).'),
    );
  }
  return box;
}

function scanBlock(pro, onQueued) {
  const line = msg();
  const area = el('textarea', { rows: '3', placeholder: `Token address(es) — up to ${pro.limits.batch}, one per line`, spellcheck: 'false', 'aria-label': 'Token addresses' });
  const btn = el(
    'button',
    {
      class: 'btn-sm gold',
      type: 'button',
      onclick: async () => {
        const { list, bad } = parseAddresses(area.value);
        if (bad.length) return fail(line, new Error(`Not a token address: ${bad[0].slice(0, 50)} (expected 0x + 40 hex characters)`));
        if (!list.length) return fail(line, new Error('Paste at least one token address.'));
        btn.disabled = true;
        try {
          const r = await api('/api/scan', { tokens: list });
          ok(line, `${r.queued.length} scan(s) queued. Results appear below in a few minutes.`);
          area.value = '';
          onQueued();
        } catch (e) {
          fail(line, e);
        } finally {
          btn.disabled = false;
        }
      },
    },
    'Run hosted scan',
  );
  return el('div', { class: 'pro-block' }, el('h3', {}, 'Hosted scan'), area, el('div', { class: 'wm-actions' }, btn), line);
}

async function refreshHistory(box) {
  clearInterval(pollTimer);
  let data;
  try {
    data = await api('/api/scans');
  } catch (e) {
    box.textContent = '';
    box.append(el('p', { class: 'wm-msg err' }, e.message));
    return;
  }
  box.textContent = '';
  if (!data.scans.length) box.append(el('p', { class: 'small dim' }, 'No hosted scans yet.'));
  for (const s of data.scans.slice(0, 30)) {
    const status =
      s.status === 'done' ? levelPill(s.level, s.score) : s.status === 'failed' ? el('span', { class: 'pill bad', title: s.error ?? '' }, 'failed') : el('span', { class: 'pill' }, s.status === 'running' ? 'scanning…' : 'queued');
    box.append(
      el(
        'div',
        { class: 'pro-row' },
        el('div', {}, s.symbol ? [el('b', {}, s.symbol), ' '] : null, addrLink(s.token), el('div', { class: 'meta' }, when(s.createdAt), s.status === 'failed' && s.error ? ` · ${s.error}` : '')),
        el('div', { class: 'pro-row-end' }, status, s.status === 'done' ? reportLink(s.id) : null),
      ),
    );
  }
  if (data.scans.some((s) => s.status === 'queued' || s.status === 'running')) pollTimer = setInterval(() => refreshHistory(box), 8000);
}

function watchBlock(pro) {
  const list = el('div', { class: 'pro-list' });
  const line = msg();
  const input = el('input', { type: 'text', placeholder: '0x… token address', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Token to watch' });
  async function load() {
    const { watchlist } = await api('/api/watch');
    list.textContent = '';
    if (!watchlist.length) list.append(el('p', { class: 'small dim' }, `Nothing watched yet (up to ${pro.limits.watchlist} tokens).`));
    for (const w of watchlist) {
      list.append(
        el(
          'div',
          { class: 'pro-row' },
          el(
            'div',
            {},
            addrLink(w.token),
            w.changed ? el('span', { class: 'pill warn' }, `changed: was ${w.previousScore ?? '–'}/100`) : null,
            el('div', { class: 'meta' }, w.scannedAt ? `last scan ${when(w.scannedAt)}` : 'first scan queued'),
          ),
          el(
            'div',
            { class: 'pro-row-end' },
            w.level ? levelPill(w.level, w.score) : null,
            w.lastReportId && w.level ? reportLink(w.lastReportId, 'Report') : null,
            el(
              'button',
              {
                class: 'btn-sm',
                type: 'button',
                onclick: async (ev) => {
                  ev.currentTarget.disabled = true;
                  try {
                    await api('/api/watch/remove', { token: w.token });
                    await load();
                  } catch (e) {
                    fail(line, e);
                  }
                },
              },
              'Remove',
            ),
          ),
        ),
      );
    }
  }
  const btn = el(
    'button',
    {
      class: 'btn-sm gold',
      type: 'button',
      onclick: async () => {
        const t = input.value.trim();
        if (!ADDR_RE.test(t)) return fail(line, new Error('Paste a token address: 0x followed by 40 hex characters.'));
        btn.disabled = true;
        try {
          await api('/api/watch', { token: t });
          input.value = '';
          ok(line, 'Added. The first scan is queued; tokens are re-scanned every 6 hours and changes are flagged here.');
          await load();
        } catch (e) {
          fail(line, e);
        } finally {
          btn.disabled = false;
        }
      },
    },
    'Watch',
  );
  load().catch((e) => fail(line, e));
  return el('div', { class: 'pro-block' }, el('h3', {}, 'Watchlist'), el('div', { class: 'pro-form' }, input, btn), line, list);
}

function launchesBlock(onQueued) {
  const list = el('div', { class: 'pro-list' });
  const line = msg();
  api('/api/launches')
    .then(({ launches }) => {
      if (!launches.length) list.append(el('p', { class: 'small dim' }, 'No launches collected yet — the feed updates every 5 minutes.'));
      for (const l of launches.slice(0, 25)) {
        list.append(
          el(
            'div',
            { class: 'pro-row' },
            el('div', {}, addrLink(l.token), el('div', { class: 'meta' }, 'deployer ', addrLink(l.deployer), ` · block ${l.block}`)),
            el(
              'div',
              { class: 'pro-row-end' },
              el(
                'button',
                {
                  class: 'btn-sm',
                  type: 'button',
                  onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    try {
                      await api('/api/scan', { tokens: [l.token] });
                      toast('Scan queued');
                      onQueued();
                    } catch (e) {
                      fail(line, e);
                      ev.currentTarget.disabled = false;
                    }
                  },
                },
                'Scan',
              ),
            ),
          ),
        );
      }
    })
    .catch((e) => fail(line, e));
  return el('div', { class: 'pro-block' }, el('h3', {}, 'New Pons launches'), el('p', { class: 'small dim' }, 'Fresh tokens from the Pons v2 factory on Robinhood Chain. A new token is not vetted — scan it before you trust it.'), line, list);
}
