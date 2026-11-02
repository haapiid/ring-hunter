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
      db.exec('BEGIN');
      try {
        st.delKey.run(address);
        st.addKey.run(hash, address, prefix, now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    revokeKey: (address) => st.delKey.run(address).changes > 0,
    prune(now) {
      st.pruneNonces.run(now);
      st.pruneSessions.run(now);
    },
    close: () => db.close(),
  };
}
