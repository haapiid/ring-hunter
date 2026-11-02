// AI provider abstraction (Gemini / Groq). SDKs are imported lazily so CLI startup stays fast.
// The model name always comes from config; no default model name is guessed.
import { AiError } from '../utils/errors.js';
import { redact } from '../utils/redact.js';

const MAX_OUTPUT_TOKENS = 1500;

function mapSdkError(provider, e) {
  const status = e?.status ?? e?.code ?? e?.response?.status;
  const msg = redact(e?.message || String(e));
  if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(msg)) return new AiError(`${provider}: quota/rate limit reached`, { cause: e });
  if (status === 401 || status === 403 || /api key|unauthori|permission/i.test(msg)) return new AiError(`${provider}: API key rejected`, { cause: e });
  if (status === 404 || /not found|model/i.test(msg)) return new AiError(`${provider}: model not found/unavailable (${msg})`, { cause: e });
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|timed out/i.test(msg)) return new AiError(`${provider}: timeout`, { cause: e });
  return new AiError(`${provider}: ${msg}`, { cause: e });
}

/** @returns {{name:string, model:string, generate:(system:string, messages:{role:'user'|'assistant', content:string}[])=>Promise<string>}} */
export async function createProvider(aiConfig) {
  const { provider, timeoutMs } = aiConfig;
  if (provider === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: aiConfig.geminiKey });
    const model = aiConfig.geminiModel;
    return {
      name: 'gemini',
      model,
      async generate(system, messages) {
        try {
          const res = await client.models.generateContent({
            model,
            contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
            config: { systemInstruction: system, responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS, abortSignal: AbortSignal.timeout(timeoutMs) },
          });
          return res.text ?? '';
        } catch (e) {
          throw mapSdkError('Gemini', e);
        }
      },
    };
  }
  if (provider === 'groq') {
    const { default: Groq } = await import('groq-sdk');
    const client = new Groq({ apiKey: aiConfig.groqKey, timeout: timeoutMs, maxRetries: 0 });
    const model = aiConfig.groqModel;
    return {
      name: 'groq',
      model,
      async generate(system, messages) {
        try {
          const res = await client.chat.completions.create({
            model,
            messages: [{ role: 'system', content: system }, ...messages],
            temperature: 0.2,
            max_tokens: MAX_OUTPUT_TOKENS,
            response_format: { type: 'json_object' },
          });
          return res.choices?.[0]?.message?.content ?? '';
        } catch (e) {
          throw mapSdkError('Groq', e);
        }
      },
    };
  }
  throw new AiError(`Unknown AI provider: ${provider}`);
}
