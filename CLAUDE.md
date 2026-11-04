# RING-HUNTER AI — project instructions

A read-only CLI that analyzes token risk on **Robinhood Chain (chain ID 4663)**: token origin (Pons v2), early transactions, funding graph, wallet clusters, holder distribution, contract risk, a deterministic score, and an AI summary (Gemini/Groq) with a local fallback.

## Read before changing code
Local skills in `.claude/skills/`:
- `blockchain-forensics` — anything touching adapters/scanners/interpretation of on-chain data.
- `smart-contract-security` — `src/scanner/contractRisk.js`.
- `ai-risk-analysis` — `src/ai/`, `src/scoring/`.
- `cli-architecture-and-ux` — `src/cli/`, `src/index.js`.
- `testing-quality-assurance` — all tests & fixtures.
- `safe-changes-and-secrets` — files, dependencies, config, logging, secrets.

## Core rules
- JavaScript ESM, Node ≥ 22.13 (developed on Laragon's Node 24). Runtime validation with `zod`.
- Read-only blockchain access. No signers/private keys/transactions.
- Don't add contract/RPC addresses without verification (official source + bytecode + topic0). Record `source` and `verifiedAt` in `src/config/networks.js`.
- Unavailable data → state `PARTIAL DATA` / `NOT_CHECKED`; never fill it with assumptions or treat it as safe.
- Comments, docs, and all user-facing text (CLI, reports, web page) are in English; identifiers are in English (user request).
- Don't modify other projects in the parent folder. No `git init`/commits unless asked.

## Network scope
- **Robinhood Chain only** (user decision 2026-11-02, after multi-chain support was built and then removed). Don't re-add other networks, `--chain`, or a chains command.
- `NETWORK` in `src/config/networks.js` lists the verified venues: Pons v2 → Uniswap V4, plus Uniswap V3 and V2 factories (`network.dexes`, used by `dexAdapter.findPools`).
- Explorer: Blockscout PRO (`BLOCK_EXPLORER_API_KEY`, `chain_id=` param), optional.

## Account (optional, orex-style flow)
- Flow: `web/account.html` → connect wallet → sign a server-built SIWE (EIP-4361) message → dashboard API key (`rh_…`, shown once) → `ring-hunter login` (`src/cli/account.js`, `credentials.json` in the config dir).
- **The account never gates scanning.** Don't import `cli/account.js` from the scanner (only `cli/app.js` reads credentials, for the opt-in hosted RPC).
- `server/` (Node + `node:sqlite`, VPS, not in the npm package): stores only addresses, nonces, and sha256 hashes of session tokens/API keys. 127.0.0.1 behind a TLS proxy; Origin + JSON checks on POST; rate limits.
- Web signing rule: `personal_sign` appears exactly once, in `wallet.signIn`, after the checks that bind the message to this site/address/chain 4663 (enforced by `tests/integration/web.test.js`). Never add transactions, `eth_sign`, typed-data signatures, or approvals.
- Pro (user decision 2026-11-02) = server-side extras only: hosted scans/report history/share links, watchlist, Pons launch feed, hosted read-only RPC (`server/hosted.js`, `server/pro.js`, `/api/rpc`). **Never move an existing CLI scan feature behind Pro.** Payment = the user sends ETH manually and pastes the tx hash; the server verifies it read-only. Holder Pro = `balanceOf` ≥ `RH_PRO_TOKEN_MIN`. Treasury, price, token come from server env only — never hard-code or guess them.
- Official token panel (user decision 2026-11-04): homepage hero shows the CA from `GET /api/token`; only an `RH_ADMIN` wallet session can set it (`POST /api/admin/token`, verified read-only as an ERC-20 on chain 4663). Hidden when unset or on a static host. It is display-only and separate from `RH_PRO_TOKEN` (holder Pro).
- The API key is sent only to the account server: `/api/cli/whoami`, and `/api/rpc` when the user opts into `--hosted-rpc` / `USE_HOSTED_RPC`.
- Account server URL: `DEFAULT_ACCOUNT_API_URL` in `src/config/env.js` = https://www.ringhunter.fun (the user's own deployed site, verified 2026-11-02); `RING_HUNTER_API_URL` overrides it. Never point it at any other host.

## Distribution
- Shipped as a global npm CLI: `npm install -g ring-hunter-ai` → `ring-hunter` command (`bin` in package.json, `files` whitelist: `src/` without `src/web/`, `.env.example`, README). Published on npm (account haapiid, security-key 2FA → the user runs `npm publish` in their own terminal and approves the staged release on npmjs.com).
- User data never lives in the package folder: `src/config/paths.js` → `CONFIG_DIR` = `RING_HUNTER_HOME` | project folder if it has `.env` (dev clone) | `~/.ring-hunter`. `ring-hunter init` creates `.env` from `.env.example` and never overwrites it.
- User-facing hints/help must use `ring-hunter …` commands, not `npm run …` / `node src/…`.

## Commands
- `ring-hunter` / `ring-hunter init` / `ring-hunter check` / `ring-hunter scan <token>` — installed CLI
- `npm start` — interactive menu (dev clone)
- `npm run scan -- <tokenAddress> [--json] [--no-ai]` — non-interactive scan
- `npm run web` / `npm run dev` — info/guide page at http://localhost:3000 (static server `src/web/server.js` + `web/`). It is **not** a place for analysis functions — all functions stay in the CLI (user decision); the only exception is the Pro dashboard's hosted scans on the account server (`server/`, user decision 2026-11-02), which run the same read-only pipeline. Connect wallet in `web/js/wallet.js` uses only read methods + switch/add chain, plus the guarded SIWE `signIn` (see Account); never add transactions or other signing. Frontend: vanilla JS, `textContent` (no `innerHTML`), styling via CSSOM (the CSP forbids inline `style`). Numbers/examples in the terminal demo (`web/js/terminal.js`) must come from real reports, not invented. The page is public (deployable to any static host): it must only show installed-CLI commands — no local paths, `localhost`, or dev scripts (enforced by `tests/integration/web.test.js`). The launchpad is a separate project; its public URL goes in `LAUNCHPAD` in `web/js/site.js` (empty = link hidden). Don't modify the launchpad project from here.
- `npm run server` — account server (`RH_PUBLIC_ORIGIN`, `RH_SERVER_PORT`, `RH_DB_FILE`)
- `npm test` (unit) / `npm run test:integration` (mock chain + CLI menu flow) / `npm run test:live` (manual, needs internet)
- `npm run check` — syntax check of all files + config validation

## Key findings from real data (don't repeat these mistakes)
- The `buyer`/`seller` field in `CurveBuy`/`CurveSell` is often the router. A router can sell wallet A's tokens in a tx sent by wallet B (approval). Owner attribution → `transactionScanner.attributeTrade()` from Transfer logs in the receipt.
- The V4 PoolManager is permissionless: one token can appear in hundreds of pools. Use `dexAdapter.selectPrimaryPools()`.
- Active tokens can have >200,000 Transfers → holders switch to `balanceOf` sample mode (`PARTIAL DATA`); don't show stale reconstructed balances.
