---
name: testing-quality-assurance
description: RING-HUNTER AI testing standards with node:test — unit tests, integration tests with mock RPC/AI, clearly marked synthetic fixtures, and optional live smoke tests. Use this skill whenever adding/changing logic in src/, writing tests, creating fixtures, or before declaring a feature done.
---

# Testing & Quality Assurance

## Structure
- `tests/unit/` — pure functions: funding graph, clusters, supply, scoring, confidence, schema, table formatting, env.
- `tests/integration/` — the full scan flow with `tests/helpers/mockRpc.js` (a fake provider answering from fixtures) and a mock AI.
- `tests/live/` — optional, read-only against the public RPC; run manually (`npm run test:live`). Must never run under `npm test`.
- `tests/fixtures/` — **every synthetic fixture** must have `"synthetic": true` and use obviously fake addresses (e.g. `0x000000000000000000000000000000000000a001`). Never present synthetic data as real data.

## Minimum cases
Single funding source, exchange, bridge, correlated buys, unrelated wallets, concentrated supply, mint, owner privileges, incomplete data, RPC timeout, network mismatch, AI failure, invalid AI output, non-token address, invalid input.

## Rules
- Tests must be deterministic: no network, no wall clock (inject `now`), no API keys.
- Every fixed bug → add a regression test.
- Report actual results (`# pass`, `# fail`) — never claim tests pass without running them.

## Success criteria
`npm test`, `npm run test:integration`, and `npm run check` pass; test counts are reported as they are.
