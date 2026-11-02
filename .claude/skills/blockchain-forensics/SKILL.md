---
name: blockchain-forensics
description: On-chain forensics guide for RING-HUNTER AI — funding graph, wallet clusters, early buyers, holder distribution, Pons/Uniswap V4 events, and Robinhood Chain RPC limits. Use this skill whenever writing or changing code in src/adapters/evm/, src/scanner/, or any logic that interprets transactions, logs, balances, or relationships between wallets — even if the change looks small.
---

# Blockchain Forensics (RING-HUNTER AI)

## Goal
Produce findings that are **traceable to on-chain evidence** (tx hash, block, log index) and never equate correlation with ownership.

## Verified network facts (2026-10-27)
See `src/config/networks.js` for values and their sources. In short:
- Robinhood Chain mainnet, chain ID **4663** (`0x1237`). Testnet 46630 is a different network.
- Public RPC `https://rpc.mainnet.chain.robinhood.com`:
  - `eth_getLogs` max **10,000,000 blocks** per query AND max **10,000 logs** per result → always use adaptive chunking (shrink the range on limit errors).
  - **Not archive**: historical state (`eth_getBalance`/`eth_call` at old blocks) fails. Historical balances must be reconstructed from Transfer logs.
  - `debug_*` and `trace_*` are **not available** → internal calls aren't visible.
- Pons v2 (docs.ponsfamily.com/v2): tokens launch through the Factory `0x7eD5…EC7e`, trade on a per-token bonding curve, then **graduate to Uniswap V4** (not V3).
- Uniswap V4 PoolManager on this chain: `0x8366a39C…e40951`. The canonical address `0x0000…4444…` **has no bytecode** on chain 4663 — don't use it.

## Events verified against real logs
| Event | Contract | Notes |
|---|---|---|
| `TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)` | Factory | `deployer` = the launcher's `tx.from`. `pairToken = 0x0` means ETH. |
| `CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)` | Curve | Pre-graduation buy evidence. `buyer` is often the router. |
| `CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)` | Curve | Pre-graduation sell evidence. |
| `Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)` | PoolManager | Pons pools have `hooks` = the Meme hook. |
| `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)` | PoolManager | `sender` = router, **not** the buyer. Deltas from the swapper's side: positive = received by the swapper. |

Other events (PoolGraduated, Escrow, Vault) don't have verified signatures yet — don't decode them until the signature is matched against a real log's topic0.

## Workflow
1. **Ordering**: store `(blockNumber, transactionIndex, logIndex)`; sort by all three. Don't assume array order = chronological order.
2. **Buy/sell classification** only from swap evidence (`CurveBuy/CurveSell` or `Swap` in a pool tied to the token). A plain token transfer = `TRANSFER`, not a buy.
3. **Trade owner attribution** (`transactionScanner.attributeTrade`): don't use the event's `buyer`/`seller` field (often a router) and don't use `tx.from` directly. Verified on real data (Pons token 0xB6ea…C09B): a router can sell wallet A's tokens via `transferFrom` in a tx sent by wallet B. Rules:
   - BUY → the recipient of the token `Transfer` leaving the curve/pool/router to a non-router address.
   - SELL → the sender of the token `Transfer` entering the curve/pool/router from a non-router address.
   - Prefer an amount that exactly matches the event; fall back to `event.recipient` (BUY), then `tx.from`.
   - `tx.from` ≠ owner → `EXECUTED_FOR_OTHER` edge (a strong link: buying for / selling on behalf of another wallet, requires approval).
   - Routers/aggregators/smart wallets can still hide the owner; record `attribution` on every trade.
4. **Funding edges** must contain: `from, to, txHash, blockNumber, timestamp|null, asset, amount, relation, source ("rpc-log"|"blockscout"|...), verification`.
5. **Native ETH produces no logs.** ETH funding can only come from the Blockscout API (`txlist`, `txlistinternal`). Without a key → state `PARTIAL DATA`; don't pretend the graph is complete.
6. **Exclude infrastructure addresses** (factory, curve, hook, escrow, vault, PoolManager, router, dead, zero, addresses labeled exchange/bridge) as "insider" sources. Recipients of funds from public services aren't automatically correlated.
7. **Cluster labels** only: `OBSERVED_LINK`, `POSSIBLE_CLUSTER`, `STRONG_CORRELATION`, `UNVERIFIED`. There is no "same owner" label.
8. **Supply**: use the terms `ESTIMATED CLUSTER-ASSOCIATED SUPPLY` / `ESTIMATED DEVELOPER-ASSOCIATED SUPPLY`; don't double-count; separate LP, contracts, dead.
9. Every reported number must state its data coverage (`complete` / `partial` + reason).

## Security rules
- Read-only: no `sendTransaction`, no signer, no private key.
- Don't add contract addresses to `networks.js` without: an official source + bytecode present on-chain + (for events) topic0 matching a real log.

## Success criteria
- Every finding has at least one tx hash that can be opened in the explorer.
- Data that couldn't be fetched is stated, not filled with assumptions.
- Test fixtures cover shared funding sources, exchanges, bridges, and unrelated wallets.
