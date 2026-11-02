// Account store (SQLite via Node's built-in node:sqlite — no extra dependency).
// Holds public wallet addresses, single-use login nonces, and HASHES of session tokens and API keys.
// No private keys, seed phrases, or signatures are stored; raw tokens/keys never touch the disk.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  address    TEXT PRIMARY KEY,           -- EIP-55 checksummed
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  message    TEXT NOT NULL,              -- the exact SIWE text the server asked the wallet to sign
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,           -- sha256 of the cookie value
  address    TEXT NOT NULL REFERENCES users(address),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash     TEXT PRIMARY KEY,         -- sha256 of the key; the key itself is shown once
  address      TEXT NOT NULL UNIQUE REFERENCES users(address),
  prefix       TEXT NOT NULL,            -- first characters, for display only
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
-- RING-HUNTER Pro: one row per verified ETH payment (tx hash = primary key, so a payment is credited once).
CREATE TABLE IF NOT EXISTS payments (
  tx_hash    TEXT PRIMARY KEY,
  address    TEXT NOT NULL REFERENCES users(address),
  value_wei  TEXT NOT NULL,
  block      INTEGER NOT NULL,
  days       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pro (
  address    TEXT PRIMARY KEY REFERENCES users(address),
  until      INTEGER NOT NULL
);
-- Hosted scans. id = random, unguessable (also the share link). owner NULL = watchlist scan.
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  owner       TEXT,
  token       TEXT NOT NULL,
  status      TEXT NOT NULL,             -- queued | running | done | failed
  error       TEXT,
  symbol      TEXT,
  score       INTEGER,
  level       TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  json        TEXT
);
CREATE INDEX IF NOT EXISTS reports_owner ON reports(owner, created_at);
CREATE TABLE IF NOT EXISTS watchlist (
  address     TEXT NOT NULL REFERENCES users(address),
  token       TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (address, token)
);
-- Latest two watchlist scans per token (shared by all watchers), to flag score changes.
CREATE TABLE IF NOT EXISTS watch_state (
  token          TEXT PRIMARY KEY,
  last_report_id TEXT,
  last_score     INTEGER,
  prev_score     INTEGER,
  last_level     TEXT,
  prev_level     TEXT,
  scanned_at     INTEGER
);
-- New Pons v2 launches (TokenLaunched logs); only the newest are kept.
CREATE TABLE IF NOT EXISTS launches (
  token      TEXT PRIMARY KEY,
  deployer   TEXT NOT NULL,
  block      INTEGER NOT NULL,
  tx_hash    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

/** @param {string} file path of the database file, or ':memory:' (tests) */
export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const st = {
    addNonce: q('INSERT INTO nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)'),
    // Single use: the row is deleted in the same statement that reads it.
    takeNonce: q('DELETE FROM nonces WHERE nonce = ? RETURNING address, message, expires_at'),
    pruneNonces: q('DELETE FROM nonces WHERE expires_at < ?'),
    addUser: q('INSERT OR IGNORE INTO users (address, created_at) VALUES (?, ?)'),
    addSession: q('INSERT INTO sessions (token_hash, address, expires_at) VALUES (?, ?, ?)'),
    getSession: q('SELECT address, expires_at FROM sessions WHERE token_hash = ?'),
    delSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    pruneSessions: q('DELETE FROM sessions WHERE expires_at < ?'),
    getKeyByAddress: q('SELECT prefix, created_at, last_used_at FROM api_keys WHERE address = ?'),
    getKeyByHash: q('SELECT address, created_at FROM api_keys WHERE key_hash = ?'),
    delKey: q('DELETE FROM api_keys WHERE address = ?'),
    addKey: q('INSERT INTO api_keys (key_hash, address, prefix, created_at) VALUES (?, ?, ?, ?)'),
    touchKey: q('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?'),
    getPayment: q('SELECT address FROM payments WHERE tx_hash = ?'),
    addPayment: q('INSERT INTO payments (tx_hash, address, value_wei, block, days, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    listPayments: q('SELECT tx_hash, value_wei, days, created_at FROM payments WHERE address = ? ORDER BY created_at DESC LIMIT 20'),
    getPro: q('SELECT until FROM pro WHERE address = ?'),
    setPro: q('INSERT INTO pro (address, until) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET until = excluded.until'),
    addReport: q("INSERT INTO reports (id, owner, token, status, created_at) VALUES (?, ?, ?, 'queued', ?)"),
    startReport: q("UPDATE reports SET status = 'running' WHERE id = ?"),
    finishReport: q("UPDATE reports SET status = 'done', symbol = ?, score = ?, level = ?, finished_at = ?, json = ? WHERE id = ?"),
    failReport: q("UPDATE reports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?"),
    getReport: q('SELECT id, owner, token, status, error, symbol, score, level, created_at, finished_at, json FROM reports WHERE id = ?'),
    listReports: q('SELECT id, token, status, error, symbol, score, level, created_at, finished_at FROM reports WHERE owner = ? ORDER BY created_at DESC LIMIT ?'),
    countReportsSince: q('SELECT COUNT(*) AS n FROM reports WHERE owner = ? AND created_at >= ?'),
    resetStale: q("UPDATE reports SET status = 'failed', error = 'The server restarted during the scan — run it again' WHERE status IN ('queued', 'running')"),
    addWatch: q('INSERT OR IGNORE INTO watchlist (address, token, added_at) VALUES (?, ?, ?)'),
    delWatch: q('DELETE FROM watchlist WHERE address = ? AND token = ?'),
    countWatch: q('SELECT COUNT(*) AS n FROM watchlist WHERE address = ?'),
    listWatch: q('SELECT w.token, w.added_at, s.last_report_id, s.last_score, s.prev_score, s.last_level, s.prev_level, s.scanned_at FROM watchlist w LEFT JOIN watch_state s ON s.token = w.token WHERE w.address = ? ORDER BY w.added_at'),
    watchedTokens: q('SELECT DISTINCT w.token, s.scanned_at FROM watchlist w LEFT JOIN watch_state s ON s.token = w.token ORDER BY COALESCE(s.scanned_at, 0)'),
    getWatchState: q('SELECT last_score, last_level FROM watch_state WHERE token = ?'),
    setWatchState: q('INSERT INTO watch_state (token, last_report_id, last_score, prev_score, last_level, prev_level, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET last_report_id = excluded.last_report_id, last_score = excluded.last_score, prev_score = excluded.prev_score, last_level = excluded.last_level, prev_level = excluded.prev_level, scanned_at = excluded.scanned_at'),
    addLaunch: q('INSERT OR IGNORE INTO launches (token, deployer, block, tx_hash) VALUES (?, ?, ?, ?)'),
    listLaunches: q('SELECT token, deployer, block, tx_hash FROM launches ORDER BY block DESC LIMIT ?'),
    trimLaunches: q('DELETE FROM launches WHERE token NOT IN (SELECT token FROM launches ORDER BY block DESC LIMIT ?)'),
    getKv: q('SELECT v FROM kv WHERE k = ?'),
    setKv: q('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  };
  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  return {
    addNonce: (nonce, address, message, expiresAt) => st.addNonce.run(nonce, address, message, expiresAt),
    takeNonce: (nonce) => st.takeNonce.get(nonce) ?? null,
    addUser: (address, now) => st.addUser.run(address, now),
    addSession: (hash, address, expiresAt) => st.addSession.run(hash, address, expiresAt),
    getSession: (hash) => st.getSession.get(hash) ?? null,
    deleteSession: (hash) => st.delSession.run(hash),
    getKeyInfo: (address) => st.getKeyByAddress.get(address) ?? null,
    findKey: (hash) => st.getKeyByHash.get(hash) ?? null,
    touchKey: (hash, now) => st.touchKey.run(now, hash),
    /** Replace the address's API key (at most one per address). */
    replaceKey(address, hash, prefix, now) {
      tx(() => {
        st.delKey.run(address);
        st.addKey.run(hash, address, prefix, now);
      });
    },
    revokeKey: (address) => st.delKey.run(address).changes > 0,
    // --- Pro ---
    getProUntil: (address) => st.getPro.get(address)?.until ?? 0,
    paymentOwner: (txHash) => st.getPayment.get(txHash)?.address ?? null,
    listPayments: (address) => st.listPayments.all(address),
    /** Record a verified payment and extend Pro atomically. Returns the new "until", or null if the tx was already used. */
    creditPayment({ txHash, address, valueWei, block, days, now }) {
      return tx(() => {
        if (st.getPayment.get(txHash)) return null;
        st.addPayment.run(txHash, address, valueWei, block, days, now);
        const until = Math.max(now, st.getPro.get(address)?.until ?? 0) + days * 86_400_000;
        st.setPro.run(address, until);
        return until;
      });
    },
    // --- Hosted scans ---
    addReport: (id, owner, token, now) => st.addReport.run(id, owner, token, now),
    startReport: (id) => st.startReport.run(id),
    finishReport: (id, { symbol, score, level, json }, now) => st.finishReport.run(symbol, score, level, now, json, id),
    failReport: (id, error, now) => st.failReport.run(error, now, id),
    getReport: (id) => st.getReport.get(id) ?? null,
    listReports: (owner, limit = 50) => st.listReports.all(owner, limit),
    countReportsSince: (owner, since) => st.countReportsSince.get(owner, since).n,
    resetStaleReports: () => st.resetStale.run().changes,
    // --- Watchlist ---
    addWatch: (address, token, now) => st.addWatch.run(address, token, now).changes > 0,
    removeWatch: (address, token) => st.delWatch.run(address, token).changes > 0,
    countWatch: (address) => st.countWatch.get(address).n,
    listWatch: (address) => st.listWatch.all(address),
    watchedTokens: () => st.watchedTokens.all(),
    recordWatchScan(token, reportId, score, level, now) {
      const prev = st.getWatchState.get(token);
      st.setWatchState.run(token, reportId, score, prev?.last_score ?? null, level, prev?.last_level ?? null, now);
    },
    // --- Pons launches feed ---
    addLaunches(rows, keep = 500) {
      tx(() => {
        for (const l of rows) st.addLaunch.run(l.token, l.deployer, l.block, l.txHash);
        st.trimLaunches.run(keep);
      });
    },
    listLaunches: (limit = 100) => st.listLaunches.all(limit),
    getKv: (k) => st.getKv.get(k)?.v ?? null,
    setKv: (k, v) => st.setKv.run(k, String(v)),
    prune(now) {
      st.pruneNonces.run(now);
      st.pruneSessions.run(now);
    },
    close: () => db.close(),
  };
}
