// Number & address formatting helpers (no colors; the cli layer handles colors).
import { formatUnits } from 'ethers';

export const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '-');
export const shortHash = (h) => (h && h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h || '-');

/** Percentage with 2 decimals, or '-' if null. */
export const pct = (v, digits = 2) => (v == null || Number.isNaN(v) ? '-' : `${v.toFixed(digits)}%`);

/** Bigint percentage a/b as a number (1e-6 precision). */
export function ratioPct(part, whole) {
  const p = BigInt(part);
  const w = BigInt(whole);
  if (w === 0n) return null;
  return Number((p * 100_000_000n) / w) / 1_000_000;
}

/** Format a token amount with decimals, truncated for readability. */
export function tokenAmount(raw, decimals = 18, maxFrac = 4) {
  if (raw == null) return '-';
  const s = formatUnits(BigInt(raw), decimals);
  const [i, f = ''] = s.split('.');
  const intPart = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : intPart;
}

/** bigint-safe JSON.stringify. */
export function toJson(value, space = 2) {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), space);
}

export const isoTime = (unixSeconds) => (unixSeconds == null ? null : new Date(unixSeconds * 1000).toISOString());
