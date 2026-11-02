---
name: safe-changes-and-secrets
description: Safe-change and secret-management rules for RING-HUNTER AI — don't touch sibling projects in the "project solana" folder, .env/.gitignore, redaction of API keys & RPC URLs, no automatic git commit/init, read-only blockchain. Use this skill before writing/deleting files, installing dependencies, handling configuration, logging, or anything that touches API keys.
---

# Safe Changes & Secrets

## Environment boundaries
- This project lives in `C:\laragon\www\project solana\ring-hunter-ai\`. The parent folder holds other projects (`apex-utility`, `betta-arena`, `engine-buyback-and-burn`, `kopin`, `solana-launchpad`) — **don't modify them, don't read their `.env`**, and don't put a `package.json`/`node_modules` in the parent folder (it would affect their module resolution).
- No `git init`, commits, or global installs without the user's request.
- Before overwriting/deleting a file: read it first and understand what it does.
- Reports in `reports/` are never overwritten (unique file names); deletion only on explicit choice + confirmation.

## Secrets
- `.env` is in `.gitignore`; `.env.example` holds only placeholders/public values.
- `utils/redact.js` masks: API keys (Gemini/Groq/Blockscout), and keyed query strings & paths in RPC URLs (`https://host/***`).
- Never print the whole `process.env`. The config check shows "set / empty", not values.
- Secrets never go into LLM prompts or report files. Reports only store the RPC host (no path/query).

## Blockchain
Fully read-only: no signer, private key, seed phrase, `sendTransaction`, or write calls.

## Success criteria
- `grep` finds no real keys in the code; redaction tests pass; JSON reports contain no keys/keyed URLs.
