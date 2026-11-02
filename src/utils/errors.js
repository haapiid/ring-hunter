// Application error classes. Each error carries a user-facing message,
// a suggested action, and an exit code for non-interactive mode.

export class AppError extends Error {
  constructor(message, { hint = null, exitCode = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

/** .env config is incomplete or invalid. */
export class ConfigError extends AppError {}

/** Invalid user input (bad address, missing argument). */
export class InputError extends AppError {
  constructor(message, opts = {}) {
    super(message, { exitCode: 2, ...opts });
  }
}

/** The RPC reports a chain ID different from the config. The scan must stop. */
export class NetworkMismatchError extends AppError {
  constructor(expected, actual) {
    super(`Network mismatch: config chain ID ${expected}, RPC reports ${actual}.`, {
      hint: 'Check the RPC URL for this network in your config file (ring-hunter check shows where). The app will never switch networks silently.',
    });
    this.expected = expected;
    this.actual = actual;
  }
}

/** RPC call failure (timeout, HTTP error, JSON-RPC error). */
export class RpcError extends AppError {
  constructor(message, { code = null, retryable = false, ...opts } = {}) {
    super(message, opts);
    this.code = code;
    this.retryable = retryable;
  }
}

/** Log range too large or result over the RPC limit; the caller must shrink the range. */
export class LogRangeError extends RpcError {}

/** Required data is not available from the configured sources. */
export class DataUnavailableError extends AppError {}

/** AI provider failure (quota, timeout, invalid response). Not fatal: the local fallback is used. */
export class AiError extends AppError {}

/** The user cancelled (Ctrl+C). */
export class CancelledError extends AppError {
  constructor() {
    super('Cancelled by user.', { exitCode: 130 });
  }
}
