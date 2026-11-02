// Account page (orex-style flow): connect wallet → sign the SIWE message → dashboard with the CLI API key.
// Talks only to this site's own /api/* (same origin; the session is an HttpOnly cookie this script cannot read).
// The full API key is shown once, right after it is created. All text goes in via textContent.
import { wallet } from './wallet.js';
import { $, el, short, when, toast, copy as copyText, api, ApiError } from './ui.js';
import { mountPro } from './pro.js';

const body = $('#acctBody');
const copy = (text) => copyText(text, 'Copied — paste it in your terminal');

function errText(e) {
  if (e?.code === 4001) return 'Request rejected in the wallet.';
  if (e?.code === -32002) return 'A request is already open in the wallet — check your wallet extension.';
  return e?.message || 'Something went wrong.';
}

function setStep(n) {
  ['#stepConnect', '#stepSign', '#stepKey'].forEach((id, i) => {
    $(id).classList.toggle('done', i < n);
    $(id).classList.toggle('now', i === n);
  });
}

const msgLine = () => el('p', { class: 'wm-msg' });
function showError(line, e) {
  line.className = 'wm-msg err';
  line.textContent = errText(e);
}

// ---------- Step 1: connect ----------
function renderConnect() {
  setStep(0);
  body.textContent = '';
  const items = wallet.list();
  const line = msgLine();
  if (!items.length) {
    body.append(el('p', { class: 'wm-msg' }, 'No browser wallet detected. Install an EVM wallet extension (MetaMask, Rabby, …), then reload this page.'));
    return;
  }
  const list = el('div', { class: 'wm-list' });
  for (const entry of items) {
    const icon = entry.info.icon?.startsWith('data:image/') ? el('img', { src: entry.info.icon, alt: '' }) : el('span', { class: 'ph' });
    list.append(
      el(
        'button',
        {
          class: 'wm-pick',
          type: 'button',
          onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            line.className = 'wm-msg';
            line.textContent = `Waiting for approval in ${entry.info.name}…`;
            try {
              await wallet.connect(entry);
              renderSign();
            } catch (e) {
              showError(line, e);
              ev.currentTarget.disabled = false;
            }
          },
        },
        icon,
        entry.info.name,
      ),
    );
  }
  body.append(el('h2', {}, 'Connect your wallet'), list, line);
}

// ---------- Step 2: sign in ----------
function renderSign() {
  const st = wallet.state;
  if (!st.connected) return renderConnect();
  setStep(1);
  body.textContent = '';
  const line = msgLine();
  const btn = el(
    'button',
    {
      class: 'btn-sm gold',
      type: 'button',
      onclick: async () => {
        btn.disabled = true;
        line.className = 'wm-msg';
        line.textContent = 'Check your wallet — it shows the message to sign.';
        try {
          const { nonce, message } = await api('/api/auth/nonce', { address: st.address });
          const signature = await wallet.signIn(message);
          await api('/api/auth/verify', { nonce, signature });
          await renderDashboard();
        } catch (e) {
          showError(line, e);
          btn.disabled = false;
        }
      },
    },
    'Sign in',
  );
  body.append(
    el('h2', {}, 'Sign in'),
    el('div', { class: 'wm-rows' }, el('div', {}, el('span', {}, 'Wallet'), el('b', { class: 'mono' }, short(st.address)))),
    el('p', { class: 'wm-msg' }, 'Your wallet will show a text message starting with this site’s name. Signing it proves you own the address — no transaction, no gas.'),
    el('div', { class: 'wm-actions' }, btn, el('button', { class: 'btn-sm', type: 'button', onclick: () => (wallet.disconnect(), renderConnect()) }, 'Use another wallet')),
    line,
  );
}

// ---------- Step 3: dashboard ----------
function keyBlock(fullKey) {
  const cmd = `ring-hunter login ${fullKey}`;
  return el(
    'div',
    { class: 'acct-key' },
    el('p', { class: 'lbl' }, 'Your API key — shown only once. Store it like a password:'),
    el('button', { class: 'cmd', type: 'button', onclick: () => copy(fullKey) }, el('code', {}, fullKey)),
    el('p', { class: 'lbl' }, 'Link the CLI on your computer:'),
    el('button', { class: 'cmd', type: 'button', onclick: () => copy(cmd) }, el('code', {}, 'ring-hunter login rh_…')),
    el('p', { class: 'small dim' }, 'Or run ring-hunter login without the key and paste it when asked (keeps it out of your shell history).'),
  );
}

async function renderDashboard(newKey = null) {
  setStep(2);
  const me = await api('/api/me');
  body.textContent = '';
  const line = msgLine();
  const run = (fn) => async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await fn();
    } catch (e) {
      showError(line, e);
      ev.currentTarget.disabled = false;
    }
  };
  const k = me.apiKey;
  body.append(
    el('h2', {}, 'Dashboard'),
    el(
      'div',
      { class: 'wm-rows' },
      el('div', {}, el('span', {}, 'Signed in as'), el('b', { class: 'mono' }, short(me.address))),
      el('div', {}, el('span', {}, 'API key'), k ? el('b', { class: 'mono' }, `${k.prefix}…`) : el('span', { class: 'pill warn' }, 'none yet')),
      k ? el('div', {}, el('span', {}, 'Created'), el('span', {}, when(k.createdAt))) : null,
      k ? el('div', {}, el('span', {}, 'Last used by the CLI'), el('span', {}, when(k.lastUsedAt))) : null,
    ),
    ...(newKey ? [keyBlock(newKey)] : []),
    el(
      'div',
      { class: 'wm-actions' },
      el(
        'button',
        {
          class: 'btn-sm gold',
          type: 'button',
          onclick: run(async () => {
            if (k && !confirm('Create a new key? The current key stops working immediately.')) throw new Error('Cancelled — your current key still works.');
            const r = await api('/api/key', {});
            await renderDashboard(r.apiKey);
          }),
        },
        k ? 'Create a new key' : 'Create API key',
      ),
      k
        ? el(
            'button',
            {
              class: 'btn-sm',
              type: 'button',
              onclick: run(async () => {
                if (!confirm('Revoke the API key? The CLI will be logged out on every computer using it.')) throw new Error('Cancelled.');
                await api('/api/key/revoke', {});
                await renderDashboard();
                toast('API key revoked');
              }),
            },
            'Revoke key',
          )
        : null,
      el(
        'button',
        {
          class: 'btn-sm',
          type: 'button',
          onclick: run(async () => {
            await api('/api/logout', {});
            wallet.disconnect();
            $('#proBody').hidden = true;
            renderConnect();
          }),
        },
        'Sign out',
      ),
    ),
    line,
    el('p', { class: 'small dim' }, 'Check the link from your terminal any time with ring-hunter whoami.'),
  );
  mountPro($('#proBody'), { address: me.address, hasKey: !!k });
}

// ---------- Start: already signed in? ----------
(async () => {
  try {
    await renderDashboard();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return renderConnect();
    setStep(-1);
    body.textContent = '';
    body.append(el('p', { class: 'wm-msg err' }, e.message), el('p', { class: 'small dim' }, 'You can still use every RING-HUNTER feature from the CLI without an account.'));
  }
})();
