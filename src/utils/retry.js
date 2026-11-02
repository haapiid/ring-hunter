// Bounded retry with exponential backoff + jitter, plus a timeout wrapper.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run fn with bounded retries. Never retries forever.
 * @param {(attempt:number)=>Promise<any>} fn
 * @param {{retries?:number, baseMs?:number, maxMs?:number, shouldRetry?:(e:any)=>boolean, sleepFn?:(ms:number)=>Promise<void>, onRetry?:(e:any, attempt:number, delay:number)=>void}} opts
 */
export async function withRetry(fn, opts = {}) {
  const { retries = 3, baseMs = 400, maxMs = 8000, shouldRetry = () => true, sleepFn = sleep, onRetry } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= retries || !shouldRetry(e)) throw e;
      const delay = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      onRetry?.(e, attempt + 1, delay);
      await sleepFn(delay);
      attempt++;
    }
  }
}

/** Reject the promise if it takes longer than ms. */
export function withTimeout(promise, ms, makeError) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError ? makeError() : new Error(`Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
