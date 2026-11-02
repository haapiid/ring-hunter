// Shared hosted-scan report (report.html?id=…). Read-only view of the same JSON report the CLI produces.
// Every value is inserted as text; addresses/tx hashes link to the Robinhood Chain explorer.
import { $, el, short, when, copy, api, levelPill, EXPLORER } from './ui.js';

const body = $('#reportBody');
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const ext = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const addr = (a) => (HEX40.test(a ?? '') ? ext(`${EXPLORER}/address/${a}`, short(a)) : '–');
const txl = (h) => (HEX64.test(h ?? '') ? ext(`${EXPLORER}/tx/${h}`, `${h.slice(0, 10)}…`) : '–');
const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '–');
const row = (k, v) => el('div', {}, el('span', {}, k), el('b', {}, v));
const list = (title, items) => (items?.length ? [el('h3', {}, title), el('ul', { class: 'rep-list' }, items.map((t) => el('li', {}, t)))] : []);

function render(data) {
  const r = data.report;
  const a = r.analysis ?? {};
  const s = r.scoring ?? {};
  const t = r.token ?? {};
  const h = r.holders?.summary;
  body.textContent = '';
  // Native append() would print null/arrays as text: flatten and drop empty parts first.
  const put = (...parts) => body.append(...parts.flat().filter((x) => x != null && x !== false));
  put(
    el('p', { class: 'eyebrow-sm' }, 'Hosted scan · Robinhood Chain'),
    el('h1', {}, t.symbol ?? 'Token', t.name ? el('span', { class: 'dim' }, ` · ${t.name}`) : null),
    el('p', { class: 'mono small' }, addr(t.address), ' ', el('button', { class: 'btn-sm', type: 'button', onclick: () => copy(t.address, 'Token address copied') }, 'Copy address')),
    el('div', { class: 'rep-score' }, levelPill(s.level, s.score), el('span', { class: 'small dim' }, ` confidence ${s.confidence ?? '–'} · data coverage ${a.data_coverage_pct ?? '–'}%`)),
    a.summary ? el('p', { class: 'rep-summary' }, a.summary) : null,
    el(
      'div',
      { class: 'wm-rows' },
      row('Creator / deployer', addr(r.origin?.creator ?? r.origin?.deployer)),
      row('Launch', r.origin?.method ?? '–'),
      row('Clusters', a.cluster_detected ? `${a.cluster_detected.count} (${a.cluster_detected.wallet_count} wallets, strongest ${a.cluster_detected.strongest_label ?? '–'})` : '–'),
      row('Est. cluster-associated supply', pct(a.estimated_cluster_associated_supply_pct)),
      row('Est. developer-associated supply', pct(a.estimated_developer_associated_supply_pct)),
      h ? row('Top-10 wallet holders', pct(h.top10WalletPct)) : null,
      h ? row('Holders', `${h.holderCount ?? '–'}${h.sampleMode ? ' (sample)' : ''}`) : null,
      row('Analyzed at', when(r.analyzedAt)),
    ),
    ...list('Risk factors', a.risk_factors),
    ...list('Positive signals', a.positive_signals),
    ...list('Could be a false positive', a.false_positive_notes),
    a.evidence?.length ? [el('h3', {}, 'Evidence'), el('ul', { class: 'rep-list' }, a.evidence.map((e) => el('li', {}, txl(e.txHash), ' ', e.note)))] : null,
    ...list('Limitations', a.limitations),
    el('p', { class: 'small dim rep-disclaimer' }, r.disclaimer ?? ''),
    el(
      'div',
      { class: 'wm-actions' },
      el(
        'button',
        {
          class: 'btn-sm',
          type: 'button',
          onclick: () => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
            const dl = el('a', { href: url, download: `ring-hunter-${t.symbol ?? 'token'}-${data.id}.json` });
            document.body.append(dl);
            dl.click();
            dl.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
        },
        'Download JSON report',
      ),
      el('button', { class: 'btn-sm', type: 'button', onclick: () => copy(location.href, 'Share link copied') }, 'Copy share link'),
    ),
  );
}

(async () => {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  try {
    const data = await api(`/api/report?id=${encodeURIComponent(id)}`);
    if (data.status !== 'done' || !data.report) {
      body.textContent = '';
      body.append(el('p', { class: 'wm-msg' }, data.status === 'failed' ? `This scan failed: ${data.error ?? 'unknown error'}` : 'This scan is still running — reload in a minute.'));
      return;
    }
    render(data);
  } catch (e) {
    body.textContent = '';
    body.append(el('p', { class: 'wm-msg err' }, e.message), el('p', { class: 'small dim' }, 'Scan any token yourself with the free CLI: npm install -g ring-hunter-ai'));
  }
})();
