---
name: smart-contract-security
description: Read-only token contract risk checks for RING-HUNTER AI — owner/admin privileges, mint, pause, blacklist, fee setters, proxy/upgradeability, and honeypot patterns. Use this skill whenever touching src/scanner/contractRisk.js, adding selector/function detection, or writing text that draws conclusions about a contract's safety.
---

# Smart Contract Security (read-only)

## Goal
Find **privileges and risky mechanisms** in token contracts without ever changing blockchain state, and report them with an honest level of evidence.

## Evidence levels (required on every finding)
- `STATIC` — found in the bytecode (e.g. a function selector is present). It means the *capability exists*, not that it *was ever used*.
- `ONCHAIN_STATE` — proven by reading current state (e.g. `owner()` ≠ 0x0, `paused() == true`, the EIP-1967 slot holds an implementation).
- `TX_EVIDENCE` — proven by transactions/logs (e.g. an `OwnershipTransferred` exists, a mint happened after launch).
- `NOT_CHECKED` — couldn't be checked (state the reason).

## Workflow
1. Fetch the bytecode (`eth_getCode`). Empty → not a contract; stop the token analysis.
2. **Proxy**: read the EIP-1967 implementation (`0x3608…2bbc`), admin (`0xb531…6103`), and beacon (`0xa3f0…3d50`) slots. If it's a proxy, also analyze the implementation bytecode and mark it `upgradeable`.
3. **Selector scan**: look for 4-byte selectors in the bytecode (`PUSH4 <selector>`). Group them: mint, pause, blacklist/whitelist, fee/tax setter, max tx/wallet, trading toggle, ownership, rescue/withdraw. Remember: a selector can be in the bytecode without anyone being able to call it — that's why the level is `STATIC`.
4. **State calls** (`eth_call`, latest): `owner()`, `getOwner()`, `paused()`. A failure is not proof of "absent"; record `NOT_CHECKED`.
5. **Pons template**: tokens launched through the Pons Factory can be compared with other Pons tokens. Template similarity is an informative signal, not a safety guarantee.
6. **Honeypot**: may only be concluded from evidence (e.g. a sell `eth_call` simulation that fails due to contract logic, or not a single successful sell despite many buys). Without enough evidence → "indication", not "honeypot".

## Report language
- Never declare a token "safe" — even if ownership is renounced or the source is verified.
- Never call this analysis a "formal security audit".
- Distinguish "the contract has a mint function" vs "an active owner can mint" vs "a mint happened after launch".

## Security rules
- No real transactions, no signer, no fork without the user's approval.
- `eth_call` only for `view` functions/simulation; never include a user-owned `from`.

## Success criteria
- Every warning has an evidence level and a reason.
- Test fixtures: a token with mint, with an active owner, a proxy, and a minimal token without privileges.
