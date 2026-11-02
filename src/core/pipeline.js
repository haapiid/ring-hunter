// Full UI-less scan pipeline: on-chain scan → AI/fallback → report.
// Used by the CLI (src/cli/app.js).
import { runTokenScan } from '../scanner/tokenScanner.js';
import { buildAiFacts } from '../ai/prompts.js';
import { runAiAnalysis, assembleAnalysis } from '../ai/aiEngine.js';
import { buildReport } from '../reports/reportBuilder.js';

/**
 * @param {object} ctx session context (config, rpc, explorer, labels)
 * @param {string} address token address (already normalized)
 * @param {{useAi?:boolean, onStage?:Function, onAiStart?:Function, onAiDone?:Function, signal?:AbortSignal}} opts
 */
export async function runFullScan(ctx, address, { useAi = true, onStage, onAiStart, onAiDone, signal } = {}) {
  const scan = await runTokenScan({ address, config: ctx.config, rpc: ctx.rpc, explorer: ctx.explorer, labels: ctx.labels, onStage, signal });
  const facts = buildAiFacts(scan);
  const aiConfig = useAi ? ctx.config : { ...ctx.config, ai: { ...ctx.config.ai, provider: 'none' } };
  // onAiStart is only called when the AI request actually starts.
  const aiResult = await runAiAnalysis(facts, aiConfig, { onStart: onAiStart });
  onAiDone?.(aiResult);
  const analysis = assembleAnalysis(scan, facts, aiResult);
  return buildReport(scan, analysis);
}
