// Small DOM/API helpers shared by the account, Pro, and report pages. All text goes in via textContent/append
// (no innerHTML); requests go only to this site's own /api/* (same origin).
export const $ = (sel) => document.querySelector(sel);

export function el(tag, props = {}, ...children) {
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

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
export const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
export const EXPLORER = 'https://robinhoodchain.blockscout.com';

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
export async function copy(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Copy failed — select the text and copy it manually');
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'The account server could not be reached.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? (res.status === 404 ? 'The account server is not available on this site.' : `Request failed (HTTP ${res.status}).`));
  return data;
}

/** Risk level → pill class + readable text (text is always shown; color is never the only signal). */
export function levelPill(level, score) {
  const cls = /HIGH/.test(level ?? '') ? 'pill bad' : /MODERATE/.test(level ?? '') ? 'pill warn' : level ? 'pill ok' : 'pill';
  const text = level ? `${score ?? '–'}/100 · ${level.replace(/_/g, ' ')}` : 'no score';
  return el('span', { class: cls }, text);
}
