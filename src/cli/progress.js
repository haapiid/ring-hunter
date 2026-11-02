// Scan progress per REAL STAGE. The bar advances only when a stage actually finishes (no fake timers).
// On non-TTY terminals, progress is printed as text lines.
import cliProgress from 'cli-progress';
import { c } from './theme.js';

/**
 * @param {{id:string,label:string}[]} stages
 * @returns {{onStage:(id:string,status:string,detail?:string)=>void, stop:()=>void, log:(msg:string)=>void}}
 */
export function createStageProgress(stages, { stream = process.stdout } = {}) {
  const labelOf = Object.fromEntries(stages.map((s) => [s.id, s.label]));
  const done = new Set();
  const results = [];

  if (!stream.isTTY) {
    return {
      onStage(id, status, detail) {
        if (status === 'start') stream.write(`… ${labelOf[id] ?? id}\n`);
        else stream.write(`${status === 'warn' ? '!' : '✓'} ${labelOf[id] ?? id}${detail ? ` — ${detail}` : ''}\n`);
      },
      stop() {},
      log: (m) => stream.write(m + '\n'),
    };
  }

  const bar = new cliProgress.SingleBar(
    {
      format: `${c.cyan('{bar}')} ${c.bold('{value}/{total}')} ${c.dim('│')} {stage}`,
      barCompleteChar: '█',
      barIncompleteChar: '░',
      barsize: 24,
      hideCursor: true,
      clearOnComplete: true,
      stopOnComplete: false,
      stream,
    },
    cliProgress.Presets.shades_classic,
  );
  bar.start(stages.length, 0, { stage: c.dim('starting…') });

  return {
    onStage(id, status, detail) {
      const label = labelOf[id] ?? id;
      if (status === 'start') {
        bar.update(done.size, { stage: `${label}…` });
        return;
      }
      done.add(id);
      results.push({ id, status, label, detail });
      bar.update(done.size, { stage: `${label}${detail ? c.dim(` — ${detail}`) : ''}` });
    },
    stop() {
      bar.stop();
      // The stage summary stays visible after the bar is cleared.
      for (const r of results) {
        const mark = r.status === 'warn' ? c.yellow('!') : c.green('✓');
        stream.write(`  ${mark} ${r.label}${r.detail ? c.dim(` — ${r.detail}`) : ''}\n`);
      }
    },
    log(msg) {
      bar.stop();
      stream.write(msg + '\n');
    },
  };
}
