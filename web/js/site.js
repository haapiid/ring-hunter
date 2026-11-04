// RING-HUNTER AI info page: scroll animations, terminal demo, copy-to-clipboard commands, connect wallet.
// All dynamic text goes in via textContent (no innerHTML from input/wallet).
import { SCENES, walletScene, createTerminal } from './terminal.js';
import { wallet } from './wallet.js';

const $ = (sel, root = document) => root.querySelector(sel);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EXPLORER = 'https://robinhoodchain.blockscout.com';
// Public launchpad URL. Empty until the launchpad is deployed — the "open in launchpad" link is hidden while empty.
const LAUNCHPAD = '';
// Mirrors SCORING_WEIGHTS in src/config/analysis.js (enforced by a test).
export const WEIGHTS = [
  ['Funding correlation', 25],
  ['Cluster-linked supply', 20],
  ['Early-buyer coordination', 15],
  ['Contract privileges', 20],
  ['Liquidity risk', 10],
  ['Holder concentration', 10],
];

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---------- Toast & copy ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied — paste it in your terminal');
    if (btn) {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1400);
    }
  } catch {
    toast('Copy failed — copy it manually');
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (b) copy(b.dataset.copy, b);
});
function cmdButton(text, label = text) {
  return el('button', { class: 'cmd', type: 'button', 'data-copy': text }, el('code', {}, label));
}

// ---------- Header & reveal animations ----------
const hdr = $('#hdr');
const onScroll = () => hdr.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

const revealer = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      en.target.classList.add('in');
      revealer.unobserve(en.target);
      if (en.target.id === 'weights') requestAnimationFrame(() => en.target.querySelectorAll('.w-bar i').forEach((i) => (i.style.width = `${i.dataset.w * 4}%`)));
    }
  },
  { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
);

// ---------- Score weights ----------
const weightsBox = $('#weights');
for (const [name, w] of WEIGHTS) weightsBox.append(el('div', { class: 'w-row' }, el('span', {}, name), el('div', { class: 'w-bar' }, el('i', { 'data-w': w })), el('b', {}, `${w}%`)));
document.querySelectorAll('.rise, .fade, .wordmark, #weights').forEach((n) => revealer.observe(n));

// ---------- Terminal demo + section indicator ----------
const term = createTerminal($('#term'), $('#termTitle'));
const sections = [...document.querySelectorAll('section[data-scene]')];
const ticks = $('#ticks');
sections.forEach(() => ticks.append(el('i')));
let currentScene = null;

function playScene(name) {
  const sc = SCENES[name];
  if (!sc) return;
  term.play(sc.dynamic ? walletScene(wallet.state.address) : sc.lines, sc.title);
}
function activate(sec) {
  const name = sec.dataset.scene;
  if (name === currentScene) return;
  currentScene = name;
  const idx = sections.indexOf(sec);
  [...ticks.children].forEach((t, i) => t.classList.toggle('on', i === idx));
  document.querySelectorAll('header nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${sec.id}`));
  // The terminal is only visible on wide screens; no need to type on phones.
  if (getComputedStyle($('.stage')).display !== 'none') playScene(name);
}
const sectionObserver = new IntersectionObserver(
  (entries) => {
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (vis) activate(vis.target);
  },
  { rootMargin: '-40% 0px -40% 0px', threshold: [0, 0.25, 0.5] },
);
sections.forEach((s) => sectionObserver.observe(s));

// ---------- Wallet avatar (colors derived from the address) ----------
function avatar(address) {
  const a = el('span', { class: 'avatar', 'aria-hidden': 'true' });
  const h1 = parseInt(address.slice(2, 8), 16) % 360;
  const h2 = parseInt(address.slice(-6), 16) % 360;
  a.style.background = `conic-gradient(from ${h1}deg, hsl(${h1} 85% 60%), hsl(${h2} 80% 55%), hsl(${(h1 + 120) % 360} 85% 60%), hsl(${h1} 85% 60%))`;
  return a;
}

// ---------- Wallet modal ----------
const wm = $('#wm');
const wmBody = $('#wmBody');
const wmBackdrop = $('#wmBackdrop');
let lastFocus = null;
function openModal() {
  lastFocus = document.activeElement;
  renderModal();
  wm.classList.add('open');
  wmBackdrop.classList.add('open');
  setTimeout(() => wm.querySelector('button')?.focus(), 50);
}
function closeModal() {
  wm.classList.remove('open');
  wmBackdrop.classList.remove('open');
  lastFocus?.focus?.();
}
$('#wmClose').addEventListener('click', closeModal);
wmBackdrop.addEventListener('click', closeModal);
addEventListener('keydown', (e) => e.key === 'Escape' && wm.classList.contains('open') && closeModal());
$('#walletBtn').addEventListener('click', openModal);

function errText(e) {
  if (e?.code === 4001) return 'Request rejected in the wallet.';
  if (e?.code === -32002) return 'A request is already open in the wallet — check your wallet extension.';
  return e?.message || 'Failed to connect.';
}

function renderModal() {
  wmBody.textContent = '';
  const st = wallet.state;
  $('#wmTitle').textContent = st.connected ? 'Wallet connected' : 'Connect wallet';
  if (!st.connected) {
    const items = wallet.list();
    const msg = el('p', { class: 'wm-msg' }, 'Reads your address only. No transactions.');
    if (!items.length) {
      wmBody.append(
        el('p', { class: 'wm-msg' }, 'No browser wallet detected. Install an EVM wallet extension, then reload this page.'),
        el('div', { class: 'wm-list' }, el('a', { class: 'wm-pick', href: 'https://metamask.io/download/', target: '_blank', rel: 'noopener noreferrer' }, el('span', { class: 'ph' }), 'MetaMask ↗'), el('a', { class: 'wm-pick', href: 'https://rabby.io/', target: '_blank', rel: 'noopener noreferrer' }, el('span', { class: 'ph' }), 'Rabby ↗')),
      );
      return;
    }
    const listBox = el('div', { class: 'wm-list' });
    for (const entry of items) {
      const icon = entry.info.icon?.startsWith('data:image/') ? el('img', { src: entry.info.icon, alt: '' }) : el('span', { class: 'ph' });
      listBox.append(
        el(
          'button',
          {
            class: 'wm-pick',
            type: 'button',
            onclick: async (ev) => {
              ev.currentTarget.disabled = true;
              msg.className = 'wm-msg';
              msg.textContent = `Waiting for approval in ${entry.info.name}…`;
              try {
                await wallet.connect(entry);
              } catch (e) {
                msg.className = 'wm-msg err';
                msg.textContent = errText(e);
                ev.currentTarget.disabled = false;
              }
            },
          },
          icon,
          entry.info.name,
        ),
      );
    }
    wmBody.append(listBox, msg);
    return;
  }
  const onChain = st.chainId === 4663;
  wmBody.append(
    el(
      'div',
      { class: 'wm-rows' },
      el('div', {}, el('span', {}, 'Address'), el('b', { class: 'mono' }, short(st.address))),
      el('div', {}, el('span', {}, 'Network'), onChain ? el('span', { class: 'pill ok' }, 'Robinhood Chain · 4663') : el('span', { class: 'pill warn' }, `chain ID ${st.chainId ?? '?'}`)),
      onChain ? el('div', {}, el('span', {}, 'Balance'), el('b', {}, st.balance == null ? '—' : `${st.balance.toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH`)) : null,
    ),
  );
  const out = el('p', { class: 'wm-msg' });
  wmBody.append(
    el(
      'div',
      { class: 'wm-actions' },
      onChain
        ? null
        : el(
            'button',
            {
              class: 'btn-sm gold',
              type: 'button',
              onclick: async () => {
                try {
                  await wallet.switchToRobinhood();
                } catch (e) {
                  out.className = 'wm-msg err';
                  out.textContent = errText(e);
                }
              },
            },
            'Switch to Robinhood Chain',
          ),
      el('button', { class: 'btn-sm', type: 'button', onclick: () => copy(st.address) }, 'Copy address'),
      el('a', { class: 'btn-sm', href: `${EXPLORER}/address/${st.address}`, target: '_blank', rel: 'noopener noreferrer' }, 'View on explorer ↗'),
      el('button', { class: 'btn-sm', type: 'button', onclick: () => (closeModal(), document.getElementById('wallet').scrollIntoView()) }, 'Show CLI commands for this wallet'),
      el('button', { class: 'btn-sm', type: 'button', onclick: () => wallet.disconnect() }, 'Disconnect'),
    ),
    out,
    el('p', { class: 'wm-note' }, 'This page never asks for seed phrases or transactions. Only the optional account sign-in asks for one plain-text message signature.'),
  );
}

// ---------- Wallet card in the "Connect a wallet" section ----------
function renderWalletCard() {
  const box = $('#walletCard');
  box.textContent = '';
  const st = wallet.state;
  if (!st.connected) {
    box.append(el('div', { class: 'wc-top' }, el('div', {}, el('b', {}, 'Not connected'), el('div', { class: 'meta' }, 'MetaMask, Rabby, or another EVM wallet')), el('div', { class: 'wc-actions' }, el('button', { class: 'btn-sm gold', type: 'button', onclick: openModal }, 'Connect wallet'))));
    return;
  }
  const onChain = st.chainId === 4663;
  box.append(
    el('div', { class: 'wc-top' }, avatar(st.address), el('div', {}, el('div', { class: 'addr' }, short(st.address)), el('div', { class: 'meta' }, onChain ? el('span', { class: 'pill ok' }, 'Robinhood Chain') : el('span', { class: 'pill warn' }, `chain ID ${st.chainId} — not Robinhood Chain`))), el('div', { class: 'wc-actions' }, el('button', { class: 'btn-sm', type: 'button', onclick: openModal }, 'Manage'))),
    el('p', { class: 'hint' }, 'Check the launch history & funding of this wallet as a developer — run menu 3, then paste the address:'),
    cmdButton('ring-hunter', '$ ring-hunter   →   3. Analyze Developer Wallet'),
    cmdButton(st.address, st.address),
  );
}

// ---------- Scan command builder ----------
const tokenIn = $('#tokenIn');
function renderBuilder() {
  const out = $('#builderOut');
  out.textContent = '';
  const v = tokenIn.value.trim();
  if (!v) {
    out.append(el('p', { class: 'lbl' }, 'Example with the PXT1 test token:'), cmdButton('ring-hunter scan 0xB6ea66422c14F64Cf66FaE50F7d4914D4bAaC09B --no-ai', 'ring-hunter scan 0xB6ea…C09B --no-ai'));
    tokenIn.removeAttribute('aria-invalid');
    return;
  }
  if (!ADDRESS_RE.test(v)) {
    tokenIn.setAttribute('aria-invalid', 'true');
    out.append(el('p', { class: 'err' }, 'Address format: 0x followed by 40 hex characters.'));
    return;
  }
  tokenIn.removeAttribute('aria-invalid');
  const items = [
    el('p', { class: 'lbl' }, 'Quick scan (local analysis):'),
    cmdButton(`ring-hunter scan ${v} --no-ai`),
    el('p', { class: 'lbl' }, 'Scan + save the report to ~/.ring-hunter/reports:'),
    cmdButton(`ring-hunter scan ${v} --save`),
    el('p', { class: 'lbl' }, 'View the token on the explorer:'),
    el('a', { class: 'cmd link', href: `${EXPLORER}/token/${v}`, target: '_blank', rel: 'noopener noreferrer' }, el('code', {}, `${EXPLORER.replace('https://', '')}/token/${short(v)} ↗`)),
  ];
  if (LAUNCHPAD) {
    items.push(
      el('p', { class: 'lbl' }, 'Open it on the launchpad:'),
      el('a', { class: 'cmd link', href: `${LAUNCHPAD}/token/${v}`, target: '_blank', rel: 'noopener noreferrer' }, el('code', {}, `${LAUNCHPAD.replace(/^https?:\/\//, '')}/token/${short(v)} ↗`)),
    );
  }
  out.append(...items);
}
tokenIn.addEventListener('input', renderBuilder);

// ---------- Official token (set by the site admin on the account server; hidden when unset or on a static host) ----------
async function renderOfficialToken() {
  const box = $('#officialToken');
  let t;
  try {
    const res = await fetch('/api/token', { credentials: 'omit' });
    t = res.ok ? (await res.json()).token : null;
  } catch {
    t = null;
  }
  if (!t || !ADDRESS_RE.test(t.address ?? '')) return;
  box.append(
    el('p', { class: 'lbl' }, el('span', { class: 'gold' }, '✦'), ` Official token · ${t.symbol ? `$${t.symbol}` : 'RING-HUNTER'}${t.name ? ` (${t.name})` : ''}`),
    el('button', { class: 'cmd', type: 'button', 'data-copy': t.address, 'aria-label': 'Copy the official contract address' }, el('code', {}, t.address)),
    el(
      'div',
      { class: 'token-ca-links' },
      el('a', { href: `${EXPLORER}/token/${t.address}`, target: '_blank', rel: 'noopener noreferrer' }, 'View on explorer ↗'),
      el('button', { class: 'linkish', type: 'button', 'data-copy': `ring-hunter scan ${t.address}` }, 'Copy scan command'),
    ),
    el('p', { class: 'small dim' }, 'This is the only official contract address. Any other “RING-HUNTER” token is not ours. Not financial advice.'),
  );
  box.hidden = false;
}
renderOfficialToken();

// ---------- Wallet state sync ----------
function syncWallet() {
  const st = wallet.state;
  const btn = $('#walletBtn');
  btn.textContent = st.connected ? short(st.address) : 'Connect wallet';
  btn.classList.toggle('connected', st.connected);
  renderWalletCard();
  if (wm.classList.contains('open')) renderModal();
  if (currentScene === 'wallet') playScene('wallet');
}
addEventListener('walletchange', syncWallet);
syncWallet();
renderBuilder();
