---
name: ai-risk-analysis
description: LLM integration rules (Gemini/Groq) for RING-HUNTER AI — limited input, zod-validated structured output, anti-hallucination, separating facts from interpretation, and the local fallback. Use this skill whenever changing src/ai/, src/scoring/, LLM prompts, the report schema, or how scores/verdicts are displayed.
---

# AI Risk Analysis

## Core principle
The LLM is a **summary writer**, not a source of facts. Every number (score, supply percentages, wallet counts, cluster counts) comes from the deterministic engine and is **overwritten again** after the LLM response arrives. If the LLM mentions an address/tx hash that isn't in the input, the response is treated as invalid.

## Flow
1. `scoring/riskScoring.js` computes the 0–100 score + components + coverage + confidence.
2. `ai/prompts.js` builds a compact input: only normalized data, truncated (max N clusters, M evidence items, K txs). No secrets, no RPC URLs.
3. The provider (`gemini`/`groq`) is called with a timeout and no unbounded retries (max 1 repair attempt).
4. The response is parsed → validated with `ai/schema.js` (zod) → numeric fields overwritten from the engine → addresses/tx hashes in the text checked against the input allowlist.
5. A failure at any step → `ai/fallbackAnalysis.js` builds a template summary from engine data. The report stays honest and complete; `ai.source` = `"fallback"` with the reason.

## Allowed language
- Use "correlated", "indicated", "observed". Avoid "certainly", "proven to belong to", "a rug pull will happen".
- Verdicts only from the enum: `HIGH_OBSERVED_RISK_AVOID_OR_VERIFY`, `BE_CAUTIOUS`, `LOWER_OBSERVED_RISK_STILL_DYOR`, `INSUFFICIENT_DATA`. There is no "SAFE ENTRY".
- The score is a heuristic, not a rug-pull probability.

## Security rules
- Never send API keys, private RPC URLs, private keys, or `.env` contents to the LLM.
- Limit prompt size (characters) and `max_output_tokens`.
- The model name comes from `.env`; never hardcode/guess model names.

## Success criteria
- Tests: valid response, broken JSON, missing fields, LLM-invented score (must be overwritten), invented address (must be rejected), provider timeout/quota → fallback.
- `AI_PROVIDER=none` mode produces a complete report.
