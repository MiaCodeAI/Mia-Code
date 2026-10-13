export interface Styler {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

/** Honours NO_COLOR and FORCE_COLOR; otherwise colour only on an interactive, non-dumb terminal. */
export function shouldUseColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '') return force !== '0' && force.toLowerCase() !== 'false';
  return isTTY && env['TERM'] !== 'dumb';
}

export function createStyler(enabled: boolean): Styler {
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}
