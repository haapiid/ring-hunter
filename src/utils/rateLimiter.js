// Simple rate limiter: concurrency cap + minimum spacing between requests.
// Keeps the public RPC and the Blockscout free tier (5 RPS) from rate-limiting us.

export function createLimiter({ concurrency = 4, minIntervalMs = 0 } = {}) {
  let active = 0;
  let last = 0;
  const queue = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    const wait = Math.max(0, last + minIntervalMs - Date.now());
    if (wait > 0) {
      setTimeout(next, wait);
      return;
    }
    const { fn, resolve, reject } = queue.shift();
    active++;
    last = Date.now();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
    next();
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

/** map with a concurrency limit; results keep the input order. */
export async function mapLimit(items, limit, fn) {
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}
