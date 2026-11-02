// Report storage: unique file names, never overwrites old reports, deletes only on confirmation.
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { toJson } from '../utils/format.js';
import { InputError } from '../utils/errors.js';
import { REPORTS_DIR } from '../config/paths.js';

export const DEFAULT_REPORT_DIR = REPORTS_DIR;

const safe = (s) => String(s || 'token').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 20) || 'token';

/** Save a report. The 'wx' flag guarantees existing files are never overwritten. */
export function saveReport(report, dir = DEFAULT_REPORT_DIR, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = `${safe(report.token?.symbol)}-${String(report.token?.address || '').slice(2, 10)}-${stamp}`;
  for (let i = 0; i < 100; i++) {
    const file = join(dir, `${base}${i ? `-${i}` : ''}.json`);
    try {
      writeFileSync(file, toJson(report), { flag: 'wx', encoding: 'utf8' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Failed to create a unique report file name');
}

/** List reports, newest first. */
export function listReports(dir = DEFAULT_REPORT_DIR) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const full = join(dir, f);
      let summary = null;
      try {
        const r = JSON.parse(readFileSync(full, 'utf8'));
        summary = { token: r.token?.symbol ?? r.token?.name ?? '?', address: r.token?.address, score: r.scoring?.score ?? null, level: r.scoring?.displayLevel ?? null, analyzedAt: r.analyzedAt };
      } catch {
        summary = { error: 'unreadable' };
      }
      return { file: full, name: f, mtime: statSync(full).mtimeMs, ...summary };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Load a report. The path must be inside the reports directory (prevents path traversal). */
export function loadReport(file, dir = DEFAULT_REPORT_DIR) {
  const full = resolve(dir, basename(file));
  return JSON.parse(readFileSync(full, 'utf8'));
}

/** Delete a report — the caller MUST have asked the user for explicit confirmation. */
export function deleteReport(file, { confirmed } = {}, dir = DEFAULT_REPORT_DIR) {
  if (confirmed !== true) throw new InputError('Deleting a report requires explicit confirmation.');
  const full = resolve(dir, basename(file));
  unlinkSync(full);
  return full;
}
