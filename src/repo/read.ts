import fs from 'node:fs/promises';
import path from 'node:path';
import { excludedPathReason } from '../project/exclusions.js';

export type AccessErrorCode =
  'invalid' | 'outside' | 'excluded' | 'missing' | 'not-file' | 'binary' | 'too-large';

export class AccessError extends Error {
  constructor(
    readonly code: AccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export interface TextFile {
  path: string;
  text: string;
  lines: string[];
}

const DEFAULT_MAX_BYTES = 1_000_000;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Validates a project-relative path and returns its absolute location.
 * Rejects absolute paths, `..` traversal, excluded files (secrets, dependencies, caches, binaries),
 * symbolic links, and anything whose real location is outside the project root.
 */
export async function resolveInside(
  root: string,
  requested: string,
): Promise<{ rel: string; abs: string }> {
  if (requested === '' || requested.includes('\0'))
    throw new AccessError('invalid', 'The path is empty or invalid.');
  const rel = requested.replace(/\\/g, '/').replace(/^\.\//, '');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new AccessError(
      'outside',
      'Absolute paths are not allowed; use a path relative to the project.',
    );
  }
  if (rel.split('/').some((segment) => segment === '..')) {
    throw new AccessError('outside', 'The path leaves the project folder.');
  }
  const reason = excludedPathReason(rel);
  if (reason)
    throw new AccessError(
      'excluded',
      `Access to this file is blocked by the exclusion policy (${reason}).`,
    );

  const abs = path.join(root, ...rel.split('/'));
  let lstat;
  try {
    lstat = await fs.lstat(abs);
  } catch {
    throw new AccessError('missing', 'The file does not exist.');
  }
  if (lstat.isSymbolicLink()) throw new AccessError('excluded', 'Symbolic links are not followed.');
  if (!lstat.isFile()) throw new AccessError('not-file', 'The path is not a regular file.');

  const real = await fs.realpath(abs);
  if (!isInside(root, real))
    throw new AccessError('outside', 'The file resolves to a location outside the project.');
  return { rel, abs };
}

/** Reads a text file safely. Binary and oversized files are refused rather than truncated silently. */
export async function readTextFile(
  root: string,
  requested: string,
  options: { maxBytes?: number } = {},
): Promise<TextFile> {
  const { rel, abs } = await resolveInside(root, requested);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const stat = await fs.stat(abs);
  if (stat.size > maxBytes)
    throw new AccessError('too-large', `The file is larger than ${maxBytes} bytes.`);
  const buffer = await fs.readFile(abs);
  if (buffer.subarray(0, 8000).includes(0))
    throw new AccessError('binary', 'The file looks binary.');
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  return { path: rel, text, lines: text.split(/\r?\n/) };
}
