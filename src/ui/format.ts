import type { Usage } from '../providers/types.js';
import type { CostEstimate } from '../session/chat.js';

export function formatTable(rows: readonly (readonly string[])[], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join(' '.repeat(gap))
      .trimEnd(),
  );
}

function count(n: number | undefined): string {
  return n === undefined ? 'n/a' : n.toLocaleString('en-US');
}

export function formatCost(cost: CostEstimate | null): string {
  if (!cost) return 'cost n/a (no dated price configured)';
  const digits = cost.amount < 0.01 ? 5 : 4;
  return `~${cost.amount.toFixed(digits)} ${cost.currency} (price as of ${cost.asOf})`;
}

export function formatUsage(usage: Usage, cost: CostEstimate | null): string {
  return `tokens in ${count(usage.inputTokens)} · out ${count(usage.outputTokens)} · ${formatCost(cost)}`;
}
