// `ring-hunter init`: creates the user config directory (~/.ring-hunter by default) with a .env from the bundled
// template and an empty reports/ folder. Never overwrites an existing .env.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { CONFIG_DIR, ENV_FILE, ENV_EXAMPLE_FILE, REPORTS_DIR } from '../config/paths.js';
import { c } from './theme.js';

export function runInit(out = process.stdout) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const existed = existsSync(ENV_FILE);
  if (!existed) copyFileSync(ENV_EXAMPLE_FILE, ENV_FILE);

  out.write(`\n${c.green('✓')} Config directory: ${CONFIG_DIR}\n`);
  out.write(existed ? `${c.dim('•')} Config file already exists, left unchanged: ${ENV_FILE}\n` : `${c.green('✓')} Created config file: ${ENV_FILE}\n`);
  out.write(`${c.green('✓')} Reports folder: ${REPORTS_DIR}\n\n`);
  out.write('The config already points to the public Robinhood Chain RPC (chain ID 4663).\n');
  out.write('Optional: add AI and explorer keys to the config file (AI_PROVIDER, GROQ_API_KEY, BLOCK_EXPLORER_API_KEY).\n\n');
  out.write('Next:\n  ring-hunter check               Test the connection\n  ring-hunter scan <tokenAddress>  Scan a token\n  ring-hunter                      Interactive menu\n\n');
  return { created: !existed, file: ENV_FILE };
}
