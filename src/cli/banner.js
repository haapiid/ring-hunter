// Figlet "RING-HUNTER" banner with a gradient; adapts to terminal width.
import figlet from 'figlet';
import { c, gradient } from './theme.js';
import { APP_VERSION } from '../reports/reportBuilder.js';

function render(font) {
  try {
    return figlet.textSync('RING-HUNTER', { font, horizontalLayout: 'fitted' });
  } catch {
    return null;
  }
}

export function bannerText(columns = process.stdout.columns || 80) {
  // Pick the largest font that fits the terminal width; otherwise plain text.
  for (const font of ['ANSI Shadow', 'Standard', 'Small']) {
    const art = render(font);
    if (art && Math.max(...art.split('\n').map((l) => l.length)) <= columns - 2) return art;
  }
  return 'RING-HUNTER';
}

export function printBanner() {
  const art = bannerText();
  process.stdout.write('\n' + gradient(art) + '\n');
  process.stdout.write(`${c.magenta.bold('  AI')} ${c.dim('·')} ${c.cyan('Developer Trust & Insider Ring Scanner')} ${c.dim(`v${APP_VERSION}`)}\n`);
  process.stdout.write(c.dim('  Read-only · Robinhood Chain (4663) · Results = heuristic indicators, not proof of ownership\n\n'));
}
