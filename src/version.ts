import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asString, isRecord } from './util/json.js';

/** Reads the version from package.json (one directory above src/ or dist/). */
export function getVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw: unknown = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return (isRecord(raw) && asString(raw['version'])) || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
