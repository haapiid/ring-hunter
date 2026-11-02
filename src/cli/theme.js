// Terminal color theme (cyberpunk: cyan, electric blue, magenta; red for warnings).
// chalk disables colors automatically on NO_COLOR / non-TTY; text stays informative without color.
import chalk from 'chalk';

export const c = {
  cyan: chalk.hex('#00E5FF'),
  blue: chalk.hex('#2979FF'),
  magenta: chalk.hex('#FF00C8'),
  red: chalk.hex('#FF3B3B'),
  yellow: chalk.hex('#FFD400'),
  green: chalk.hex('#00E676'),
  dim: chalk.gray,
  bold: chalk.bold,
  title: (s) => chalk.bold.hex('#00E5FF')(s),
  label: (s) => chalk.hex('#8AB4F8')(s),
};

export const colorEnabled = () => chalk.level > 0;

/** Simple per-character horizontal gradient (fallback: plain text when colors are off). */
export function gradient(text, stops = ['#00E5FF', '#2979FF', '#FF00C8']) {
  if (!colorEnabled()) return text;
  const lines = text.split('\n');
  const width = Math.max(1, ...lines.map((l) => l.length));
  const rgb = stops.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const at = (t) => {
    const seg = Math.min(rgb.length - 2, Math.floor(t * (rgb.length - 1)));
    const lt = t * (rgb.length - 1) - seg;
    return rgb[seg].map((v, i) => Math.round(v + (rgb[seg + 1][i] - v) * lt));
  };
  return lines.map((line) => [...line].map((ch, i) => (ch === ' ' ? ch : chalk.rgb(...at(i / width))(ch))).join('')).join('\n');
}

/** Color by score: red ≥70, yellow 40–69, green <40. Always paired with the level text. */
export function scoreColor(score) {
  if (score == null) return c.dim;
  if (score >= 70) return c.red;
  if (score >= 40) return c.yellow;
  return c.green;
}

export const levelText = (level) =>
  ({
    HIGH_OBSERVED_RISK: 'HIGH OBSERVED RISK',
    MODERATE_RISK: 'MODERATE RISK',
    LOWER_OBSERVED_RISK: 'LOWER OBSERVED RISK',
    INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
  })[level] ?? level;

export const clusterLabelColor = (label) =>
  ({ STRONG_CORRELATION: c.red, POSSIBLE_CLUSTER: c.yellow, OBSERVED_LINK: c.cyan, UNVERIFIED: c.dim })[label] ?? c.dim;
