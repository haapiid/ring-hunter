// Secret redaction: API keys and private RPC URLs must never appear in logs, reports, or LLM prompts.

const registered = new Set();

/** Register a secret value (API key, full RPC URL) so it is always masked. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) registered.add(value);
}

export function clearSecrets() {
  registered.clear();
}

/**
 * Safe label for an RPC URL: protocol + host only. Path and query often contain an API key
 * (e.g. https://host/v2/<key>), so both are dropped.
 */
export function safeUrlLabel(url) {
  try {
    const u = new URL(url);
    const hidden = (u.pathname && u.pathname !== '/') || u.search || u.username ? '/***' : '';
    return `${u.protocol}//${u.host}${hidden}`;
  } catch {
    return '[invalid url]';
  }
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
// Common key patterns: RING-HUNTER account keys (rh_…), Gemini (AIza…), Groq (gsk_…), Blockscout PRO (proapi_…), and apikey= in queries.
const KEY_PATTERNS = [/rh_[0-9A-Za-z_-]{43}/g, /AIza[0-9A-Za-z_-]{20,}/g, /gsk_[0-9A-Za-z]{20,}/g, /proapi_[0-9A-Za-z]{8,}/g, /(apikey|api_key|key|token)=([^&\s"']+)/gi];

/** Mask all registered secrets, common key patterns, and URL paths/queries. */
export function redact(input) {
  if (input == null) return input;
  let s = typeof input === 'string' ? input : String(input);
  for (const secret of registered) s = s.split(secret).join('***');
  for (const re of KEY_PATTERNS) s = s.replace(re, (m, k) => (k && m.includes('=') ? `${k}=***` : '***'));
  s = s.replace(URL_RE, (u) => safeUrlLabel(u));
  return s;
}

/** Error message that is safe to display. */
export function safeErrorMessage(err) {
  if (!err) return 'Unknown error';
  return redact(err.message || String(err));
}
