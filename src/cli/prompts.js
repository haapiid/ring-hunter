// @inquirer/prompts wrappers with address validation.
import { input, select, confirm } from '@inquirer/prompts';
import { normalizeAddress, parseAddressList } from '../utils/validation.js';

// Optional stream context (input/output) so menu flows can be tested end-to-end without a TTY.
let promptContext;
export const setPromptContext = (ctx) => {
  promptContext = ctx;
};

export async function askAddress(message = 'Token contract address (0x…):') {
  const v = await input(
    {
      message,
      validate: (s) => {
        try {
          normalizeAddress(s);
          return true;
        } catch (e) {
          return e.message;
        }
      },
    },
    promptContext,
  );
  return normalizeAddress(v);
}

export async function askAddressList(message = 'Wallet list (separate with commas/spaces, 2–30 addresses):') {
  const v = await input(
    {
      message,
      validate: (s) => {
        try {
          const list = parseAddressList(s);
          if (list.length < 2) return 'Enter at least 2 different addresses.';
          if (list.length > 30) return 'At most 30 addresses per analysis.';
          return true;
        } catch (e) {
          return e.message;
        }
      },
    },
    promptContext,
  );
  return parseAddressList(v);
}

export const askConfirm = (message, def = false) => confirm({ message, default: def }, promptContext);

export const choose = (message, choices, opts = {}) => select({ message, choices, pageSize: 12, loop: false, ...opts }, promptContext);

/** true if the error came from Ctrl+C / Esc in an inquirer prompt. */
export const isPromptExit = (e) => e?.name === 'ExitPromptError' || e?.name === 'AbortPromptError';
