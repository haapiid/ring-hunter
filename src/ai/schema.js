// AI output schema. The LLM may only fill in the NARRATIVE; all numbers come from the deterministic engine.
import { z } from 'zod';

const line = z.string().trim().min(3).max(400);

/** The part requested from the LLM. */
export const AiNarrativeSchema = z
  .object({
    summary: z.string().trim().min(20).max(1500),
    risk_factors: z.array(line).max(10),
    positive_signals: z.array(line).max(8),
    false_positive_notes: z.array(line).max(8),
    limitations: z.array(line).max(10),
  })
  .strict();

export const RISK_LEVELS = ['LOWER_OBSERVED_RISK', 'MODERATE_RISK', 'HIGH_OBSERVED_RISK', 'INSUFFICIENT_DATA'];
export const VERDICTS = ['HIGH_OBSERVED_RISK_AVOID_OR_VERIFY', 'BE_CAUTIOUS', 'LOWER_OBSERVED_RISK_STILL_DYOR', 'INSUFFICIENT_DATA'];
export const CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'];

/** Final analysis report (narrative + engine numbers). Validated before being shown/saved. */
export const AnalysisReportSchema = z
  .object({
    source: z.enum(['ai', 'fallback']),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    summary: z.string().min(1),
    dev_risk_score: z.number().int().min(0).max(100).nullable(),
    risk_level: z.enum(RISK_LEVELS),
    confidence: z.enum(CONFIDENCE),
    cluster_detected: z.object({
      count: z.number().int().min(0),
      wallet_count: z.number().int().min(0),
      strongest_label: z.string().nullable(),
    }),
    estimated_cluster_associated_supply_pct: z.number().min(0).max(100).nullable(),
    estimated_developer_associated_supply_pct: z.number().min(0).max(100).nullable(),
    data_coverage_pct: z.number().min(0).max(100),
    risk_factors: z.array(z.string()),
    positive_signals: z.array(z.string()),
    false_positive_notes: z.array(z.string()),
    evidence: z.array(z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), note: z.string() })),
    limitations: z.array(z.string()),
    verdict: z.enum(VERDICTS),
    fallback_reason: z.string().nullable(),
  })
  .strict();
