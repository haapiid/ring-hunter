#!/usr/bin/env node
// Info & guide page:  npm run web   (npm run dev → auto-restart when files change)
// Options: --port <n>  ·  --open (open the default browser). The port can also come from WEB_PORT in .env.
import { spawn } from 'node:child_process';
import { loadDotEnv } from '../config/env.js';
import { createWebServer } from './server.js';

function parsePort(argv) {
  const i = argv.indexOf('--port');
  const raw = i >= 0 ? argv[i + 1] : process.env.WEB_PORT || '3000';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${raw}`);
  return port;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function main() {
  const argv = process.argv.slice(2);
  loadDotEnv();
  const app = createWebServer();
  let port;
  try {
    port = await app.listen(parsePort(argv));
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    process.stderr.write('Port is already used by another app. Try: npm run web -- --port 3100  (or set WEB_PORT in .env)\n');
    process.exitCode = 1;
    return;
  }
  const url = `http://localhost:${port}`;
  process.stdout.write(`\n  RING-HUNTER AI · guide page: ${url}\n  Analysis functions stay in the CLI (npm start). Press Ctrl+C to stop.\n\n`);
  if (argv.includes('--open')) openBrowser(url);
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  process.stderr.write(`Failed to start the web page: ${e.message}\n`);
  process.exitCode = 1;
});
