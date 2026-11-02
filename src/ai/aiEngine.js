// AI engine: calls the provider, validates the response, rejects hallucinations, then merges it with
// the engine numbers. A failure at any point → local fallback (the report stays honest & complete).
import { AiNarrativeSchema, AnalysisReportSchema } from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildRepairPrompt } from './prompts.js';
import { buildFallbackNarrative } from './fallbackAnalysis.js';
import { createProvider } from './providers.js';
import { aiStatus } from '../config/env.js';
import { AiError } from '../utils/errors.js';
import { toJson } from '../utils/format.js';

const HEX_RE = /0x[0-9a-fA-F]{40,64}/g;

/** Parse JSON from LLM text (strips ```json fences if present). */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AiError('Empty AI response');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('AI response contains no JSON object');
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new AiError(`Invalid AI JSON: ${e.message}`);
  }
}

/** Collect all valid addresses/hashes and percentages from the facts. */
export function allowedTokens(facts) {
  const json = toJson(facts, 0);
  const hex = new Set((json.match(HEX_RE) || []).map((h) => h.toLowerCase()));
  // Valid numbers = every number that appears in the input, including those written inside reason strings.
  // Hex is removed first so digits inside addresses/hashes are not counted as numbers.
  const numbers = (json.replace(HEX_RE, ' ').match(/\d+(?:\.\d+)?/g) || []).map(Number);
  return { hex, numbers };
}

/**
 * Anti-hallucination guard: addresses/hashes must exist in the input; "N/100" must equal the engine score;
 * percentages must match one of the numbers in the input (tolerance 0.05).
 * @returns {string|null} error message, or null if it passes
 */
export function guardNarrative(narrative, facts) {
  const { hex, numbers } = allowedTokens(facts);
  const text = [narrative.summary, ...narrative.risk_factors, ...narrative.positive_signals, ...narrative.false_positive_notes, ...narrative.limitations].join('\n');
  for (const h of text.match(HEX_RE) || []) {
    if (!hex.has(h.toLowerCase())) return `mentions an address/hash that is not in the input (${h.slice(0, 12)}…)`;
  }
  const score = facts.engine_score.dev_risk_score;
  for (const m of text.matchAll(/(\d{1,3})\s*\/\s*100/g)) {
    if (score == null || Number(m[1]) !== score) {
      // Component weights & component scores are also valid.
      if (!numbers.includes(Number(m[1]))) return `mentions a score of ${m[1]}/100 that did not come from the engine`;
    }
  }
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    const v = Number(m[1].replace(',', '.'));
    if (!numbers.some((n) => Math.abs(n - v) <= 0.05 || Math.abs(Math.round(n) - v) < 0.5)) return `mentions a percentage of ${m[1]}% that is not in the input`;
  }
  return null;
}

/**
 * Run the AI analysis with fallback.
 * @param {object} facts result of buildAiFacts
 * @param {object} config result of buildConfig
 * @param {{provider?:object, onStart?:Function}} [opts] the provider can be injected for tests
 */
export async function runAiAnalysis(facts, config, opts = {}) {
  const status = aiStatus(config);
  if (!opts.provider && !status.ready) {
    return { source: 'fallback', provider: null, model: null, narrative: buildFallbackNarrative(facts), attempts: 0, fallbackReason: status.reason };
  }
  let provider = opts.provider;
  try {
    provider ??= await createProvider(config.ai);
  } catch (e) {
    return { source: 'fallback', provider: config.ai.provider, model: null, narrative: buildFallbackNarrative(facts), attempts: 0, fallbackReason: e.message };
  }

  opts.onStart?.(provider);
  const messages = [{ role: 'user', content: buildUserPrompt(facts) }];
  let lastError = null;
  // At most 2 attempts: 1 request + 1 repair. No unbounded retries.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text;
    try {
      text = await provider.generate(SYSTEM_PROMPT, messages);
    } catch (e) {
      // Transport/quota errors are not fixed by repeating the prompt → fall back immediately.
      lastError = e.message;
      return { source: 'fallback', provider: provider.name, model: provider.model, narrative: buildFallbackNarrative(facts), attempts: attempt, fallbackReason: lastError };
    }
    try {
      const parsed = AiNarrativeSchema.safeParse(parseJsonLoose(text));
      if (!parsed.success) throw new AiError(`schema mismatch: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      const guard = guardNarrative(parsed.data, facts);
      if (guard) throw new AiError(guard);
      return { source: 'ai', provider: provider.name, model: provider.model, narrative: parsed.data, attempts: attempt, fallbackReason: null };
    } catch (e) {
      lastError = e.message;
      messages.push({ role: 'assistant', content: String(text).slice(0, 4000) }, { role: 'user', content: buildRepairPrompt(lastError) });
    }
  }
  return { source: 'fallback', provider: provider.name, model: provider.model, narrative: buildFallbackNarrative(facts), attempts: 2, fallbackReason: `Invalid AI response: ${lastError}` };
}

/** Merge the narrative (AI/fallback) with the engine numbers into a validated analysis report. */
export function assembleAnalysis(scan, facts, aiResult) {
  const s = scan.risk;
  const cs = scan.clusters.summary;
  const evidence = [];
  for (const c of scan.clusters.clusters) {
    for (const e of c.evidence.slice(0, 3)) if (e.txHash) evidence.push({ txHash: e.txHash, note: `${c.id} ${c.label}: ${e.relation}` });
  }
  if (scan.origin.deployTxHash) evidence.unshift({ txHash: scan.origin.deployTxHash, note: `Deployment/launch (${scan.origin.method})` });
  const report = {
    source: aiResult.source,
    provider: aiResult.provider ?? null,
    model: aiResult.model ?? null,
    summary: aiResult.narrative.summary,
    dev_risk_score: s.score,
    risk_level: s.displayLevel,
    confidence: s.confidence,
    cluster_detected: { count: cs.meaningfulCount, wallet_count: cs.meaningfulWalletCount, strongest_label: cs.strongest },
    estimated_cluster_associated_supply_pct: clampPct(cs.estimatedClusterSupplyPct),
    estimated_developer_associated_supply_pct: clampPct(cs.estimatedDeveloperSupplyPct),
    data_coverage_pct: Math.round(s.coverage * 100),
    risk_factors: aiResult.narrative.risk_factors,
    positive_signals: aiResult.narrative.positive_signals,
    false_positive_notes: aiResult.narrative.false_positive_notes,
    evidence: dedupe(evidence).slice(0, 20),
    limitations: [...new Set([...aiResult.narrative.limitations, ...scan.limitations])],
    verdict: scan.verdict,
    fallback_reason: aiResult.fallbackReason ?? null,
  };
  return AnalysisReportSchema.parse(report);
}

// Partial reconstruction can yield >100%; show the upper bound and let the PARTIAL status explain it.
const clampPct = (v) => (v == null ? null : Math.max(0, Math.min(100, v)));

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => (seen.has(e.txHash) ? false : (seen.add(e.txHash), true)));
}
