import { isRecord } from '../util/json.js';
import type { ToolCall } from './types.js';

/** Parses accumulated JSON argument text into a ToolCall. Invalid JSON is reported, never guessed. */
export function buildToolCall(id: string, name: string, rawArguments: string): ToolCall {
  const text = rawArguments.trim();
  if (text === '') return { id, name, arguments: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return { id, name, arguments: parsed };
    return { id, name, arguments: {}, invalidArguments: 'arguments were not a JSON object' };
  } catch {
    return { id, name, arguments: {}, invalidArguments: 'arguments were not valid JSON' };
  }
}
