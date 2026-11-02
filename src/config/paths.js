// Paths. The package itself is read-only (it may live in npm's global folder and is replaced on every update),
// so user data — .env, labels.local.json, reports/ — lives in a separate config directory:
//   1. RING_HUNTER_HOME, if set
//   2. the project folder, if it already has a .env (development clone, backward compatible)
//   3. ~/.ring-hunter  (default for `npm install -g ring-hunter-ai`; created by `ring-hunter init`)
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function resolveConfigDir() {
  if (process.env.RING_HUNTER_HOME) return resolve(process.env.RING_HUNTER_HOME);
  if (existsSync(join(PROJECT_ROOT, '.env'))) return PROJECT_ROOT;
  return join(homedir(), '.ring-hunter');
}

export const CONFIG_DIR = resolveConfigDir();
export const ENV_FILE = join(CONFIG_DIR, '.env');
export const ENV_EXAMPLE_FILE = join(PROJECT_ROOT, '.env.example');
export const REPORTS_DIR = join(CONFIG_DIR, 'reports');
