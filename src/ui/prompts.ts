import type { Context } from '../context.js';
import { UserError } from '../errors.js';

export async function ask(ctx: Context, label: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const line = await ctx.terminal().readLine(`${label}${suffix}: `);
  if (line === null) throw new UserError('Cancelled.');
  const trimmed = line.trim();
  return trimmed === '' ? (defaultValue ?? '') : trimmed;
}

export async function confirm(
  ctx: Context,
  question: string,
  defaultYes = false,
): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  for (;;) {
    const line = await ctx.terminal().readLine(`${question} [${hint}] `);
    if (line === null) throw new UserError('Cancelled.');
    const answer = line.trim().toLowerCase();
    if (answer === '') return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    ctx.print('Please answer y or n.');
  }
}

/**
 * Returns the zero-based index chosen. On a real terminal this is an arrow-key menu that scrolls;
 * otherwise (pipes, scripts, tests) it shows numbered options and accepts a number or exact text.
 */
export async function choose(
  ctx: Context,
  label: string,
  options: readonly string[],
): Promise<number> {
  const terminal = ctx.terminal();
  if (options.length > 1 && terminal.interactive && ctx.stdoutIsTTY && terminal.select) {
    const picked = await terminal.select(label, options);
    if (picked === null) throw new UserError('Cancelled.');
    return picked;
  }
  options.forEach((option, i) => ctx.print(`  ${i + 1}) ${option}`));
  for (;;) {
    const answer = await ask(ctx, label);
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
    const byText = options.findIndex((o) => o.toLowerCase() === answer.toLowerCase());
    if (byText !== -1) return byText;
    ctx.print(`Enter a number from 1 to ${options.length}.`);
  }
}
