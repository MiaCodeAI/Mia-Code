import type { Styler } from './ansi.js';

const FONT: Record<string, string[]> = {
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  ' ': ['   ', '   ', '   ', '   ', '   '],
};

const WORD = 'MIA CODE';

/** The MIA CODE wordmark as five lines of block letters. */
export function wordmark(): string[] {
  const rows: string[] = ['', '', '', '', ''];
  for (const ch of WORD) {
    const glyph = FONT[ch] ?? FONT[' ']!;
    for (let r = 0; r < 5; r++) rows[r] += `${glyph[r]}  `;
  }
  return rows.map((r) => r.trimEnd());
}

export interface BannerInfo {
  version: string;
  project?: string;
  git?: string;
  provider?: string;
  model?: string;
  keys?: string;
  mode?: string;
  sends?: string;
}

// 256-colour gradient from cyan to magenta, one step per row.
const GRADIENT = [51, 45, 39, 99, 135];

/** Banner shown when an interactive session starts. Plain text when colour is off. */
export function renderBanner(style: Styler, info: BannerInfo, columns = 80): string[] {
  const art = wordmark();
  const width = Math.max(...art.map((l) => l.length));
  const lines: string[] = [''];
  if (columns >= width + 2) {
    art.forEach((row, i) => {
      lines.push(style.enabled ? `\u001b[38;5;${GRADIENT[i] ?? 51}m${row}\u001b[39m` : row);
    });
  } else {
    lines.push(style.bold('MIA CODE'));
  }
  lines.push(
    '',
    `${style.bold('Mia Code')} ${style.dim(`v${info.version}`)} ${style.dim('· open-source, bring-your-own-key coding agent')}`,
  );
  const rows: [string, string | undefined][] = [
    ['project ', info.project],
    ['git     ', info.git],
    ['provider', info.provider],
    ['model   ', info.model],
    ['keys    ', info.keys],
    ['mode    ', info.mode],
    ['sends   ', info.sends],
  ];
  for (const [label, value] of rows) if (value) lines.push(style.dim(`  ${label}  ${value}`));
  lines.push('', style.dim('  Type a request or /help · Ctrl-C stops a reply · Ctrl-D exits'), '');
  return lines;
}
