#!/usr/bin/env node
// RING-HUNTER AI entry point (installed as the `ring-hunter` command).
//   ring-hunter                         → interactive menu
//   ring-hunter init                    → create the config file (~/.ring-hunter/.env)
//   ring-hunter scan <address> [opts]   → non-interactive scan
//   ring-hunter check                   → check config & connection
//   ring-hunter login|whoami|logout     → optional account link (API key from the website)
//   ring-hunter --help
import { loadDotEnv, buildConfig } from './config/env.js';
import { createContext, performScan, printReport, exportReport, configCheckFlow } from './cli/app.js';
import { mainMenu, printError } from './cli/menu.js';
import { printBanner } from './cli/banner.js';
import { InputError, AppError } from './utils/errors.js';
import { normalizeAddress } from './utils/validation.js';
import { toJson } from './utils/format.js';
import { runInit } from './cli/init.js';
import { runLogin, runWhoami, runLogout } from './cli/account.js';
import { APP_VERSION } from './reports/reportBuilder.js';

const HELP = `RING-HUNTER AI — Developer Trust & Insider Ring Scanner (read-only)

Usage:
  ring-hunter                          Interactive menu
  ring-hunter init                     Create the config file (first run)
  ring-hunter scan <tokenAddress> [options]
                                       Non-interactive scan
  ring-hunter check                    Check config & RPC connection
  ring-hunter login [API_KEY]          Link this CLI to your website account (optional)
  ring-hunter whoami                   Show the linked wallet address
  ring-hunter logout                   Remove the API key from this computer
  ring-hunter --version                Show the version

Network: Robinhood Chain (chain ID 4663)

Scan options:
  --json      Print the JSON report to stdout (progress to stderr)
  --no-ai     Don't call the AI provider (use local analysis)
  --save      Save the report to the reports folder in the config directory

Config directory: ~/.ring-hunter (override with RING_HUNTER_HOME)

Exit codes: 0 success · 1 error · 2 invalid input · 130 cancelled
`;

const BOOL_FLAGS = new Set(['--json', '--no-ai', '--save', '--help', '-h', '--version', '-v']);

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const a of argv) {
    if (!a.startsWith('-')) positional.push(a);
    else if (BOOL_FLAGS.has(a)) flags.add(a);
    else throw new InputError(`Unknown option: ${a}`);
  }
  return { command: positional[0] ?? null, args: positional.slice(1), flags };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${APP_VERSION}\n`);
    return 0;
  }
  const { command, args, flags } = parseArgs(argv);
  if (command === 'init') {
    runInit();
    return 0;
  }
  loadDotEnv();
  const config = buildConfig(process.env);
  // The account is optional: these commands never touch the scanner, and scans never need them.
  if (command === 'login') return (await runLogin(config, args[0]), 0);
  if (command === 'whoami') return (await runWhoami(), 0);
  if (command === 'logout') return (runLogout(), 0);
  const ctx = createContext(config);

  if (command === 'scan') {
    if (!args[0]) throw new InputError('A token address is required: ring-hunter scan <tokenAddress>');
    const address = normalizeAddress(args[0], 'Token address');
    const json = flags.has('--json');
    if (!json) printBanner();
    const report = await performScan(ctx, address, { useAi: !flags.has('--no-ai'), stream: json ? process.stderr : process.stdout });
    if (json) process.stdout.write(toJson(report) + '\n');
    else printReport(report);
    if (flags.has('--save')) {
      const file = exportReport(report);
      if (json) process.stderr.write(`Report saved: ${file}\n`);
    }
    return 0;
  }
  if (command === 'check') {
    printBanner();
    return (await configCheckFlow(ctx, { interactive: false })) ? 0 : 1;
  }
  if (command) throw new InputError(`Unknown command: ${command}. See --help.`);

  if (!process.stdin.isTTY) throw new InputError('The interactive menu requires a terminal (TTY). Use: ring-hunter scan <address>');
  printBanner();
  await mainMenu(ctx);
  process.stdout.write('Goodbye.\n');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    printError(e);
    process.exitCode = e instanceof AppError ? e.exitCode : 1;
  });
