# RING-HUNTER AI

**Developer Trust & Insider Ring Scanner** — a *read-only* CLI tool that analyzes token risk on **Robinhood Chain** (EVM, chain ID 4663) from on-chain data. It focuses on funding links between wallets, coordinated early buyers, holder distribution, contract privileges, and developer activity.

> ⚠️ RING-HUNTER AI is a **heuristic analysis aid**. Its results are **not** a formal security audit, **not** proof of wallet identity or ownership, **not** a definitive rug-pull prediction, and **not** financial advice. On-chain correlation ≠ shared ownership.

---

## 1. Working features

| Feature | Status | Notes |
|---|---|---|
| `.env` config validation (zod) | ✅ | Secret values are never printed |
| RPC connection + chain ID check | ✅ | Stops if the network doesn't match |
| Token checks (name, symbol, decimals, totalSupply, bytecode) | ✅ | |
| Pons v2 token creator detection (`TokenLaunched`) | ✅ | Verified |
| Non-Pons token creator | ⚠️ | Needs `BLOCK_EXPLORER_API_KEY`; without it the result is only **indicative** (sender of the first mint tx) |
| Early trades (Pons CurveBuy/CurveSell, Uniswap V4 Swap) | ✅ | Owner attributed from Transfer logs in the receipt |
| Primary Uniswap V4 pool selection | ✅ | Other (permissionless) pools are recorded, not analyzed |
| Holder distribution (rebuilt from Transfer logs + `balanceOf` checks) | ✅ | Incomplete data → **sample mode** labeled `PARTIAL DATA` |
| Funding graph from token logs & receipts | ✅ | |
| Funding graph from native ETH transfers | ⚠️ | Needs `BLOCK_EXPLORER_API_KEY` (Blockscout). Adapter is built, **not yet tested live with a key** |
| Wallet cluster detection + false-positive handling | ✅ | |
| Contract risk analysis (selectors, EIP-1967/1167 proxies, owner, paused) | ✅ | Static/read-only, no transaction simulation |
| Deterministic 0–100 risk score + confidence + coverage | ✅ | |
| AI summary (Gemini / Groq) + local fallback | ✅ | Tested with mocks; **not yet tested with a real API key** |
| Interactive menu, per-stage progress, tables, cluster detail, tx hashes | ✅ | |
| Export/view/delete JSON reports | ✅ | Unique file names; deletion requires confirmation |
| Web info page (`npm run web`): guide, copy-ready commands, read-only connect wallet | ✅ | Analysis functions stay in the CLI; see section 7a |
| Optional account (website sign-in → API key → `ring-hunter login`) | ✅ | Tested with a local server and throwaway wallets; **not yet deployed**. Scans never need it — see section 7c |
| Cluster analysis from a wallet list (menu 2) | ⚠️ | Needs `BLOCK_EXPLORER_API_KEY` |
| Developer wallet analysis (menu 3) | ✅ / ⚠️ | Pons launches via RPC; funding sources/recipients need an explorer key |
| Uniswap V2 / V3 pools (besides Pons → Uniswap V4) | ✅ | Factories verified on chain 4663 (2026-11-02): official Uniswap docs + bytecode + topic0 |
| Other networks (Ethereum, Base, Solana, …) | ❌ | Out of scope by design: RING-HUNTER is Robinhood Chain only |

## 2. Architecture

```text
ring-hunter-ai/
├── src/
│   ├── index.js                 # entry point (menu / scan / check)
│   ├── config/                  # env.js (zod), networks.js (verified addresses), analysis.js (weights & thresholds), labels.js, paths.js
│   ├── adapters/evm/            # rpcClient (read-only, retry, chunking), tokenAdapter, ponsAdapter, dexAdapter (V4), explorerAdapter (Blockscout), abis
│   ├── scanner/                 # tokenScanner (orchestrator), creatorDetector, transactionScanner, holderAnalysis, fundingGraph, walletCluster, contractRisk, walletAnalysis
│   ├── scoring/                 # riskScoring (deterministic), confidence
│   ├── ai/                      # providers (Gemini/Groq), prompts, schema (zod), aiEngine (validation + anti-hallucination), fallbackAnalysis
│   ├── reports/                 # reportBuilder, exportJson
│   ├── core/pipeline.js         # scan → AI/fallback → report
│   ├── cli/                     # banner, theme, menu, app (flow), prompts, progress, reportTable
│   ├── web/                     # static server for the info page (npm run web)
│   └── utils/                   # errors, redact, retry, rateLimiter, validation, logger, format
├── web/                         # info page + account page: index.html, account.html, css/, js/ (site, terminal demo, wallet, account)
├── server/                      # account server for the VPS (SIWE sign-in, API keys, node:sqlite) — not in the npm package
├── tests/                       # unit/, integration/, live/ (manual), fixtures/ & helpers/ (SYNTHETIC data)
├── scripts/check.js             # npm run check
├── .claude/skills/              # project skills for Claude Code
└── reports/                     # dev clone only: JSON reports (installed CLI uses ~/.ring-hunter/reports)
```

Dependencies flow one way: `cli → scanner → adapters → utils`. The scanner doesn't depend on the terminal (progress goes through callbacks), so the whole flow can be tested without a UI. The LLM only writes the narrative; every number comes from the deterministic engine.

## 3. Requirements

- **Node.js ≥ 22.13** (developed & tested with Node **24.21.0**) and npm.
- Internet access to the Robinhood Chain RPC.
- Optional: a Blockscout API key (free), Gemini, or Groq.

## 4. Installation

Install it once as a global command, like other CLI installers:

```bash
npm install -g ring-hunter-ai
ring-hunter init        # creates ~/.ring-hunter/.env (public RPC + chain ID 4663)
ring-hunter check       # tests the connection
```

Update with `npm update -g ring-hunter-ai`; remove with `npm uninstall -g ring-hunter-ai`.

> **Not published yet.** Until the package is on npm, install from a local copy:
> `npm install -g .` inside this folder, or `npm pack` and then `npm install -g ./ring-hunter-ai-<version>.tgz`.

**Where your data lives.** The installed package is replaced on every update, so your files are kept in a separate
config directory:

| Order | Config directory |
|---|---|
| 1 | `RING_HUNTER_HOME`, if set |
| 2 | the project folder, if it already has a `.env` (development clone) |
| 3 | `~/.ring-hunter` (default; `C:\Users\<you>\.ring-hunter` on Windows) |

It holds `.env`, the optional `labels.local.json`, and `reports/`. `ring-hunter check` prints which config file is in use.
`ring-hunter init` never overwrites an existing `.env`.

Dependencies (pinned versions): `ethers`, `zod`, `chalk`, `figlet`, `ora`, `cli-progress`, `cli-table3`, `@inquirer/prompts`, `@google/genai`, `groq-sdk`. The published package contains only `src/` (without the web page), `.env.example`, and this README.

## 5. Configuration (`~/.ring-hunter/.env`)

`ring-hunter init` creates the file from `.env.example` (public values only). Adjust:

| Variable | Required | Description |
|---|---|---|
| `ROBINHOOD_CHAIN_RPC` | ✅ | Defaults to the public RPC `https://rpc.mainnet.chain.robinhood.com`. A private RPC (Alchemy/Chainstack/etc.) is fine; URL path & query are masked in output |
| `ROBINHOOD_CHAIN_ID` | ✅ | `4663` (mainnet). Testnet `46630` is not supported |
| `AI_PROVIDER` | – | `none` (default), `gemini`, or `groq` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | – | Both required if `AI_PROVIDER=gemini`. **The model name is never guessed** — use a model available on your account |
| `GROQ_API_KEY` / `GROQ_MODEL` | – | Both required if `AI_PROVIDER=groq` |
| `AI_TIMEOUT_MS` | – | Default 30000 |
| `BLOCK_EXPLORER_API_KEY` | – (recommended) | Blockscout PRO API key from https://dev.blockscout.com (free tier: 5 req/sec). Enables native ETH funding, non-Pons creators, menu 2 |
| `RING_HUNTER_API_URL` | – | URL of the RING-HUNTER website, only for `ring-hunter login / whoami`. https only (http allowed for localhost). Empty = account features off |
| `MAX_INITIAL_TRANSACTIONS` | – | 5–50, default 50 |
| `RPC_TIMEOUT_MS` | – | Default 15000 |
| `LOG_CHUNK_BLOCKS` | – | Initial `eth_getLogs` chunk size (adaptive), default 500000 |
| `HOLDER_SCAN_MAX_SECONDS` | – | Time limit for holder reconstruction; past the limit → sample mode `PARTIAL DATA` |

**Local labels (optional):** put a `labels.local.json` (format: `labels.local.example.json` in the repository) in the config directory to tag exchange/bridge/service addresses **you have verified yourself**. Funders with these labels are not used to group insiders.

## 6. Checking the RPC connection

```bash
ring-hunter check
```

Shows the config file in use and its status (without secret values), tests the chain ID & latest block, and tests Blockscout if a key is set. From the interactive menu: **6. Configuration Check** (it can also send a small test request to the AI provider after confirmation).

If the RPC fails with `fetch failed` while your internet works, your provider's DNS may be blocking `rpc.mainnet.chain.robinhood.com` (some Indonesian ISPs do). These providers also intercept plain DNS, so changing the DNS server to 1.1.1.1 alone often does not help (verified 2026-11-02: queries to 1.1.1.1 still returned the block-page IP). Use **encrypted DNS** — Windows 11: Settings → Network & internet → your connection → DNS server assignment → Edit → Manual → `1.1.1.1` / `1.0.0.1` with **DNS over HTTPS: On** — or a VPN, or a private RPC on another domain.

## 7. Running the app

```bash
ring-hunter                                  # interactive menu (needs a terminal/TTY)
ring-hunter scan <tokenAddress>              # non-interactive scan
ring-hunter scan <tokenAddress> --no-ai      # without an AI provider
ring-hunter scan <tokenAddress> --json       # JSON report to stdout (progress to stderr)
ring-hunter scan <tokenAddress> --save       # save the report to ~/.ring-hunter/reports
ring-hunter login                            # optional: link the CLI to your account (asks for the API key)
ring-hunter whoami                           # which wallet the CLI is linked to
ring-hunter logout                           # remove the API key from this computer
ring-hunter --help
ring-hunter --version
```

**Network.** RING-HUNTER scans Robinhood Chain (chain ID 4663) only. Pools are found on Uniswap V4 (Pons
graduations), Uniswap V3, and Uniswap V2 — all verified on-chain. A non-EVM address exits with code `2`.

Exit codes: `0` success · `1` error · `2` invalid input · `130` cancelled (Ctrl+C). Ctrl+C during a scan cancels once the in-flight request finishes; a second Ctrl+C forces exit.

Main menu:
1. Scan Token Contract
2. Analyze Wallet Cluster *(needs an explorer key)*
3. Analyze Developer Wallet
4. View Previous Reports
5. Export Report
6. Configuration Check
7. Exit

After a scan: rescan, view cluster detail, view transaction hashes, export JSON, scan another token, back to the menu.

**Development (from a clone of this repository):** `npm install`, then `npm start` / `npm run scan -- <tokenAddress>` run the same CLI without installing it globally.

### 7a. Info page (web)

A landing-page-style guide in `web/` (static HTML/CSS/JS, no build step). It contains:
- installation steps for the global CLI (`npm install -g ring-hunter-ai`, `ring-hunter init`, …)
- commands you can copy with one click
- explanations of clusters, scoring, and AI
- a troubleshooting FAQ
- a terminal demo that shows sample CLI output as you scroll

**All analysis functions stay in the CLI**; this page doesn't run scans. It is not part of the npm package.

**Deploying it:** upload the contents of `web/` to any static host (Netlify, Vercel, Cloudflare Pages, GitHub Pages, or Nginx). No server code is needed.

**Previewing it locally** (from a clone):

```bash
npm run web                  # start + open the browser → http://localhost:3000
npm run dev                  # same, auto-restarts when files change
npm run web -- --port 3100   # if port 3000 is taken (or set WEB_PORT)
```

The local preview server only listens on `127.0.0.1`, checks the `Host` header, serves only `web/`, and sets a strict CSP. When you deploy to a static host, set the same headers there (CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`) — see `src/web/server.js`.

**Connect wallet** (MetaMask, Rabby, or another EVM wallet; discovered via EIP-6963):
- Only reads the address, network, and ETH balance. The page can offer to switch to Robinhood Chain (chain ID 4663), but only after you click.
- Never asks for seed phrases or transactions. Methods outside the read allowlist are rejected in code (`web/js/wallet.js`). The only signature on the site is the optional account sign-in (section 7c).
- Once connected, the page builds copy-ready CLI commands, both for that wallet (menu 3 Analyze Developer Wallet) and for any token address you type.

### 7b. Launchpad

The launchpad is a separate project (Next.js), not part of RING-HUNTER. Its Robinhood side uses Pons v2 with factory
`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, the same address already verified in `src/config/networks.js`, so any
Pons token found there can be scanned with `ring-hunter scan <tokenAddress>`.

The info page explains this flow. Once the launchpad has a public URL, set `LAUNCHPAD` in `web/js/site.js`; the
token address builder then also shows an "open it on the launchpad" link (it is hidden while `LAUNCHPAD` is empty).

Limitations:
- The launchpad **signs transactions** through your wallet (launch, buy, sell, claim). RING-HUNTER stays read-only.

### 7c. Account (optional, orex-style)

Same flow as other CLI tools with a web account: **connect wallet → sign in → copy the API key → `ring-hunter login`**.
The account only identifies you; every scan feature works exactly the same without it.

1. Open `account.html` on the site and connect a wallet.
2. Click **Sign in**: the wallet shows a plain-text Sign-In with Ethereum (EIP-4361) message naming the site, your
   address, Robinhood Chain (4663), a one-time code, and a 10-minute expiry. It is **not a transaction**, costs no gas,
   and grants no approval. The page refuses to sign any message that isn't for this site and the connected address.
3. Click **Create API key**. The key (`rh_…`) is shown **once**; the dashboard afterwards shows only its prefix and
   when the CLI last used it. You can create a new key (the old one stops working) or revoke it.
4. In the terminal: set `RING_HUNTER_API_URL` in `~/.ring-hunter/.env` to the site's URL, then run
   `ring-hunter login` and paste the key (or `ring-hunter login <KEY>`). It is saved in
   `~/.ring-hunter/credentials.json` (file mode 0600) and masked in all output. `ring-hunter whoami` checks it,
   `ring-hunter logout` removes it.

**Running the account server (VPS).** The account page needs `server/` — a single Node process (no extra
dependencies; SQLite via the built-in `node:sqlite`) that serves `web/` plus the `/api` endpoints:

```bash
RH_PUBLIC_ORIGIN=https://<your-domain> RH_SERVER_PORT=8787 npm run server
```

| Variable | Description |
|---|---|
| `RH_PUBLIC_ORIGIN` | Public origin of the site (required in production). Used as the SIWE domain and for the CSRF Origin check |
| `RH_SERVER_PORT` | Port on `127.0.0.1`, default 8787. Put a TLS reverse proxy (nginx/Caddy) in front of it |
| `RH_DB_FILE` | SQLite file, default `server/data/accounts.db` (git-ignored). Back it up |
| `RH_TRUST_PROXY` | `1` = take the client IP from `X-Real-IP` for rate limiting (only if your proxy sets it) |

What the server stores: wallet addresses, single-use nonces, and **SHA-256 hashes** of session tokens and API keys —
never the keys themselves, never signatures or private keys. Sessions are HttpOnly + SameSite=Strict cookies (Secure
on https), valid 7 days. POST requests need the site's `Origin` and a JSON body; sign-in endpoints are rate limited.
A static-only deployment of `web/` still works — the account page then says the account server isn't available.

## 8. Example token scan

```bash
ring-hunter scan 0xB6ea66422c14F64Cf66FaE50F7d4914D4bAaC09B --no-ai
```

The stages shown follow the real work: RPC connection → network check → token contract → creator → pools → early transactions → holders → funding graph → clusters → contract risk → score. Result on the Pons test token above (2026-10-27): creator verified via `TokenLaunched`, and one `STRONG_CORRELATION` cluster that includes the deployer. The evidence: two early buyers sent tokens to the deployer, and one wallet's tokens were sold by another wallet through an approval, after which the deployer sold the same total.

## 9. Risk score explained

The 0–100 `DEV RISK SCORE` is computed **deterministically** (no LLM, no random numbers) as a weighted average of the components that **can be scored**:

| Component | Weight | Summary |
|---|---|---|
| Funding correlation | 25 | Share of early buyers in funding/transfer-based clusters; +15 if any STRONG; +20 if the deployer is linked |
| Cluster-linked supply | 20 | max(cluster supply / 30%, developer supply / 20%) |
| Early-buyer coordination | 15 | Share of early buyers in a timing group or cluster |
| Contract privileges | 20 | Sum of finding severities (mint, proxy, pause, blacklist, fee setter, etc.), max 100 |
| Liquidity | 10 | Pons = 25 (partial), non-Pons V4 pool = 50 (partial), no verified venue = 70 |
| Holder concentration | 10 | (top-10 wallet% − 10) / 50 |

Key rules:
- Components with unavailable data are **excluded** and the remaining weights are normalized. **Missing data is never treated as safe.**
- `DATA COVERAGE` = weight of the scored components (`partial` components count as half). Coverage < 50% → shown as `INSUFFICIENT DATA`.
- `CONFIDENCE` (LOW/MEDIUM/HIGH) is computed separately; it is capped at MEDIUM while native ETH funding is incomplete.
- Classification: `0–39` LOWER OBSERVED RISK · `40–69` MODERATE RISK · `70–100` HIGH OBSERVED RISK.
- Verdicts: `HIGH_OBSERVED_RISK_AVOID_OR_VERIFY`, `BE_CAUTIOUS`, `LOWER_OBSERVED_RISK_STILL_DYOR`, `INSUFFICIENT_DATA`. There is no "SAFE ENTRY".
- The score is a **heuristic model**, not a calibrated rug-pull probability.

Weights & thresholds live in `src/config/analysis.js` (tested: weights must total 100).

## 10. Cluster detection explained

1. **Wallets of interest**: deployer, early buyers/sellers, top 10 holder wallets.
2. **Edges (evidence)**, each storing tx hash, block, asset, amount, relation, source, and verification status:
   - `TOKEN_TRANSFER`: token transfers between wallets of interest (from logs).
   - `EXECUTED_FOR_OTHER`: tx sender ≠ token owner in a trade, e.g. selling another wallet's tokens via an approval (from the receipt).
   - `NATIVE_FUNDING` / `INTERNAL_FUNDING`: ETH transfers (from Blockscout, needs a key).
3. **Grouping**: direct transfers between members, or a shared funder that funded ≥2 members.
4. **False-positive protection**: funders labeled exchange/bridge/protocol, funders with a very high nonce (hot-wallet pattern), and contracts that fund many wallets are **excluded** and reported.
5. **Indicators** (thresholds in `CLUSTER_THRESHOLDS`):
   - funding: `SHARED_FUNDER`, `DIRECT_TRANSFER`, `DEPLOYER_LINKED`, `FUNDING_TIME_PROXIMITY`, `SIMILAR_FUNDING_AMOUNTS`
   - behavior: `FRESH_WALLET_BUY`, `COORDINATED_BUY_TIMING`, `SIMILAR_SELL_PATTERN`
6. **Labels**:
   - `OBSERVED_LINK`: one direct link.
   - `POSSIBLE_CLUSTER`: ≥2 indicators.
   - `STRONG_CORRELATION`: ≥3 indicators, including both a funding and a behavior indicator.
   - `UNVERIFIED`: not enough evidence, including groups based only on timing proximity.

   **There is no "same owner" label.**
7. Each cluster includes wallets, indicators, tx evidence, reasons, **alternative explanations**, and limitations.
8. Supply is reported as `ESTIMATED CLUSTER-ASSOCIATED SUPPLY` / `ESTIMATED DEVELOPER-ASSOCIATED SUPPLY` from current balances. Each address is counted once, and infrastructure addresses (LP, curve, burn, protocol) are excluded.

## 11. JSON report format

Saved to `~/.ring-hunter/reports/<SYMBOL>-<address8>-<timestamp>.json` (never overwritten). Top-level structure:

```json
{
  "schemaVersion": 1,
  "app": { "name": "RING-HUNTER AI", "version": "0.1.0" },
  "analyzedAt": "2026-10-27T…Z",
  "network": { "name": "Robinhood Chain", "chainId": 4663, "explorerUrl": "https://robinhoodchain.blockscout.com" },
  "source": { "rpc": "https://host (no path/key)", "explorer": null, "latestBlock": 98599491, "holderBlockRange": { "fromBlock": 0, "toBlock": 0 } },
  "token": { "address": "0x…", "name": "…", "symbol": "…", "decimals": 18, "totalSupply": "…" },
  "origin": { "status": "VERIFIED", "method": "PONS_TOKEN_LAUNCHED", "creator": "0x…", "deployTxHash": "0x…" },
  "pools": [], "poolSelection": { "method": "…", "othersCount": 0 },
  "earlyActivity": { "coverage": {}, "activities": [], "traders": [] },
  "holders": { "status": "COMPLETE|PARTIAL", "summary": {}, "topHolders": [] },
  "fundingGraph": { "coverage": {}, "nodes": [], "edges": [ { "from": "0x…", "to": "0x…", "txHash": "0x…", "relation": "…" } ] },
  "clusters": { "clusters": [], "excludedFunders": [], "summary": {} },
  "contract": { "findings": [], "checks": [], "ownerStatus": "…" },
  "scoring": { "score": 43, "displayLevel": "MODERATE_RISK", "coverage": 0.83, "confidence": "MEDIUM", "components": {} },
  "analysis": { "source": "ai|fallback", "summary": "…", "verdict": "BE_CAUTIOUS", "evidence": [] },
  "limitations": [],
  "disclaimer": "…"
}
```

## 12. Running tests

```bash
npm test                    # unit tests (76) — no network, no API key
npm run test:integration    # full scan flow + CLI menu flow on a mock chain, plus the web page (21)
npm run check               # syntax check of all files + config validation
npm run test:live           # MANUAL, read-only against the public RPC (needs internet)
```

All fixtures in `tests/fixtures` and `tests/helpers` are **synthetic data** (`synthetic: true`, obviously fake addresses like `0x…a0001`). The mock RPC mimics Robinhood RPC limits (10 million block range, 10 thousand logs).

## 13. Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `ROBINHOOD_CHAIN_RPC` is not set | Run `ring-hunter init`, then check `ring-hunter check` |
| Network mismatch | The RPC isn't chain 4663 (e.g. testnet 46630). Change the RPC or fix `ROBINHOOD_CHAIN_ID` |
| `RPC timeout` / `rate limit` | The public RPC is busy. Retry, raise `RPC_TIMEOUT_MS`, or use a private RPC |
| Holders `PARTIAL` | The token is very active (>200,000 transfers) or the time limit was hit. Percentages come from a `balanceOf` **sample**; raise `HOLDER_SCAN_MAX_SECONDS` if needed |
| `Native ETH funding: NONE` | Set `BLOCK_EXPLORER_API_KEY` |
| AI not used | See the reason in the report. Usually an empty key/model, exhausted quota, or the AI response failed validation. The local fallback still produces a report |
| Interactive menu requires a terminal | Run it in a terminal (Windows Terminal / cmd / PowerShell), or use `ring-hunter scan <address>` |
| Garbled colors | Set `NO_COLOR=1` |
| Debug | `RING_HUNTER_DEBUG=1` (logs are redacted) |

## 14. Analysis limitations

- The public Robinhood RPC is **not an archive node**, so historical balances can't be read. `debug_*`/`trace_*` aren't available either, so internal calls aren't visible.
- **Native ETH transfers don't produce logs.** Without an explorer key, ETH funding sources aren't observed (`PARTIAL DATA`).
- Trade owner attribution uses Transfer logs in the receipt. Routers, aggregators, and smart wallets can still hide the real owner.
- Pons graduation pool selection uses a heuristic (Pons hook + pair = `pairToken`) that has only been matched against one real token. The `PoolGraduated` event isn't used yet because its signature hasn't been verified.
- Liquidity withdrawal rights (V4 LP / Pons) are **not verified**.
- Contract analysis is static/heuristic. A selector in the bytecode means the capability exists, not necessarily that it can be called. No honeypot simulation is done.
- Exchange/bridge labels for Robinhood Chain aren't available from an official source yet. Service detection uses nonce heuristics and local labels.
- The Blockscout adapter and AI providers (Gemini/Groq) are **not yet tested with real keys**.

## 15. Security notes

- **Fully read-only**: no private keys, seed phrases, signers, or `sendTransaction`. Write RPC methods are blocked in `rpcClient`.
- The only wallet signature anywhere is the optional website sign-in: a plain-text SIWE message (no transactions, no typed data, no approvals). The account API key is stored hashed on the server and masked in CLI output.
- `.env` is git-ignored; `.env.example` only holds placeholders/public values.
- API keys and private RPC URLs are masked in logs, errors, and reports, and are never sent to the LLM.
- Reports contain no secrets. Reports are deleted only after explicit confirmation.
- LLM output is schema-validated (zod). Responses that mention addresses/hashes/scores/percentages outside the input data are rejected, and the local fallback is used instead.

## 16. Verified networks & deployments (2026-10-27)

| Item | Value | Evidence |
|---|---|---|
| Robinhood Chain mainnet | chain ID **4663** (`0x1237`) | live `eth_chainId`; Alchemy/Chainstack/GetBlock |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | Tested live (getLogs limits: 10 million blocks, 10 thousand logs; not archive; no trace) |
| Explorer | Blockscout `robinhoodchain.blockscout.com`, API `api.blockscout.com/v2/api?chainid=4663` | docs.blockscout.com/robinhood-api; rejected without a key |
| Pons v2 Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | docs.ponsfamily.com/v2; bytecode; `TokenLaunched` topic matches |
| Pons v2 Meme Hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | docs; used in PoolManager `Initialize` |
| Pons Escrow / Vault / Locker / Router / Deployer / Graduation | see `src/config/networks.js` | docs.ponsfamily.com/v2 |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | bytecode; `Initialize`/`Swap` topics match; Pons-hooked pools found. The canonical address `0x0000…4444…` **does not exist** on this chain |
| Verified events | `TokenLaunched`, `CurveBuy`, `CurveSell`, V4 `Initialize`, `Swap`, ERC-20 `Transfer` | topic0 matched against real logs |
| Uniswap V3 | — | Not verified, not used |
| Underlying stack (Arbitrum Orbit?) | — | `docs.robinhood.com/chain` was unreachable during the audit; **not assumed** |
