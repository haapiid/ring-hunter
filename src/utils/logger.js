// Debug logger to stderr. Active only when RING_HUNTER_DEBUG=1. All messages are redacted.
import { redact } from './redact.js';

const enabled = () => process.env.RING_HUNTER_DEBUG === '1';

export const logger = {
  debug(...args) {
    if (!enabled()) return;
    const msg = args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
    process.stderr.write(`[debug] ${redact(msg)}\n`);
  },
};

function safeJson(v) {
  try {
    return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  } catch {
    return String(v);
  }
}
