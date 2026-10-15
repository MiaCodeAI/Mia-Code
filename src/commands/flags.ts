import { parseArgs } from 'node:util';
import { UsageError } from '../errors.js';

export type FlagSpec = Record<
  string,
  { type: 'boolean' | 'string'; short?: string; multiple?: boolean }
>;

export interface ParsedFlags {
  values: Record<string, string | boolean | Array<string | boolean> | undefined>;
  positionals: string[];
}

/** Strict flag parsing: unknown flags are usage errors rather than being silently ignored. */
export function parseFlags(
  args: readonly string[],
  spec: FlagSpec,
  allowPositionals = true,
): ParsedFlags {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: spec,
      allowPositionals,
      strict: true,
    });
    return { values: values as ParsedFlags['values'], positionals };
  } catch (error) {
    throw new UsageError(
      error instanceof Error
        ? (error.message.split('.')[0] ?? 'Invalid arguments')
        : 'Invalid arguments',
    );
  }
}

export function str(values: ParsedFlags['values'], name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export function flag(values: ParsedFlags['values'], name: string): boolean {
  return values[name] === true;
}

export function strs(values: ParsedFlags['values'], name: string): string[] {
  const value = values[name];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}
