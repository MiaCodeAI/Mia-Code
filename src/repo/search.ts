import type { Runner } from '../platform/exec.js';
import { mapLimit } from '../util/concurrency.js';
import { isRecord } from '../util/json.js';
import { readTextFile } from './read.js';
import type { Inventory } from './types.js';

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  /** Which of the requested patterns matched on this line (index into `patterns`). */
  matched: number[];
}

export interface SearchOptions {
  patterns: string[];
  /** Treat patterns as regular expressions (default: literal text). */
  regex?: boolean;
  ignoreCase?: boolean;
  maxResults?: number;
  maxPerFile?: number;
  /** Force an engine (used by tests); by default ripgrep is used when installed. */
  engine?: 'ripgrep' | 'builtin';
}

export interface SearchResult {
  hits: SearchHit[];
  engine: 'ripgrep' | 'builtin';
  /** True when more matches existed than were returned. */
  truncated: boolean;
  /** Set when a pattern was not valid. */
  error?: string;
}

const MAX_LINE = 300;
const MAX_FILE_BYTES = 1_000_000;

function clip(line: string): string {
  const trimmed = line.replace(/\s+$/, '');
  return trimmed.length > MAX_LINE ? `${trimmed.slice(0, MAX_LINE)}…` : trimmed;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(options: SearchOptions): RegExp[] | { error: string } {
  const flags = options.ignoreCase ? 'i' : '';
  try {
    return options.patterns.map((p) => new RegExp(options.regex ? p : escapeRegex(p), flags));
  } catch (error) {
    return { error: `Invalid regular expression: ${(error as Error).message}` };
  }
}

async function builtinSearch(inventory: Inventory, options: SearchOptions): Promise<SearchResult> {
  const compiled = compile(options);
  if (!Array.isArray(compiled))
    return { hits: [], engine: 'builtin', truncated: false, error: compiled.error };
  const maxResults = options.maxResults ?? 100;
  const maxPerFile = options.maxPerFile ?? 20;
  const perFile = new Map<string, SearchHit[]>();

  const candidates = inventory.files.filter((f) => f.size <= MAX_FILE_BYTES && f.size > 0);
  await mapLimit(candidates, 16, async (file) => {
    let lines: string[];
    try {
      lines = (await readTextFile(inventory.root, file.path, { maxBytes: MAX_FILE_BYTES })).lines;
    } catch {
      return;
    }
    const hits: SearchHit[] = [];
    for (let i = 0; i < lines.length && hits.length < maxPerFile; i++) {
      const line = lines[i] as string;
      if (line.length > 5000) continue;
      const matched: number[] = [];
      compiled.forEach((re, idx) => {
        if (re.test(line)) matched.push(idx);
      });
      if (matched.length > 0)
        hits.push({ path: file.path, line: i + 1, text: clip(line), matched });
    }
    if (hits.length > 0) perFile.set(file.path, hits);
  });

  const ordered = inventory.files.flatMap((f) => perFile.get(f.path) ?? []);
  return {
    hits: ordered.slice(0, maxResults),
    engine: 'builtin',
    truncated: ordered.length > maxResults,
  };
}

async function ripgrepSearch(
  inventory: Inventory,
  run: Runner,
  options: SearchOptions,
): Promise<SearchResult | null> {
  const maxResults = options.maxResults ?? 100;
  const maxPerFile = options.maxPerFile ?? 20;
  if (options.regex) {
    const compiled = compile(options);
    if (!Array.isArray(compiled))
      return { hits: [], engine: 'ripgrep', truncated: false, error: compiled.error };
  }
  const args = [
    '--no-config',
    '--json',
    '--hidden',
    '--glob',
    '!.git',
    '--max-filesize',
    '1M',
    '--max-count',
    String(maxPerFile),
  ];
  if (!options.regex) args.push('--fixed-strings');
  if (options.ignoreCase) args.push('--ignore-case');
  for (const p of options.patterns) args.push('-e', p);
  args.push('--', '.');

  const result = await run('rg', args, {
    cwd: inventory.root,
    timeoutMs: 30_000,
    maxOutputBytes: 16_000_000,
  });
  if (result.error || result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1))
    return null;
  // ripgrep's --json output always ends with a summary event; without one this was not a real ripgrep run.
  if (!result.stdout.includes('"type":"summary"')) return null;

  const compiled = compile(options);
  const matchers = Array.isArray(compiled) ? compiled : [];
  const byPath = new Map<string, SearchHit[]>();
  for (const raw of result.stdout.split('\n')) {
    if (raw === '' || !raw.includes('"type":"match"')) continue;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(event) || event['type'] !== 'match' || !isRecord(event['data'])) continue;
    const data = event['data'];
    const pathObj = data['path'];
    const linesObj = data['lines'];
    const lineNumber = data['line_number'];
    if (
      !isRecord(pathObj) ||
      typeof pathObj['text'] !== 'string' ||
      !isRecord(linesObj) ||
      typeof linesObj['text'] !== 'string' ||
      typeof lineNumber !== 'number'
    )
      continue;
    const rel = pathObj['text'].replace(/\\/g, '/').replace(/^\.\//, '');
    // The inventory is the authority on what may be read: ripgrep results outside it are dropped.
    if (!inventory.byPath.has(rel)) continue;
    const text = linesObj['text'];
    const matched: number[] = [];
    matchers.forEach((re, idx) => {
      if (re.test(text)) matched.push(idx);
    });
    const hit: SearchHit = {
      path: rel,
      line: lineNumber,
      text: clip(text.replace(/\r?\n$/, '')),
      matched: matched.length > 0 ? matched : [0],
    };
    const list = byPath.get(rel) ?? [];
    list.push(hit);
    byPath.set(rel, list);
  }
  const ordered = inventory.files.flatMap((f) =>
    (byPath.get(f.path) ?? []).sort((a, b) => a.line - b.line),
  );
  return {
    hits: ordered.slice(0, maxResults),
    engine: 'ripgrep',
    truncated: ordered.length > maxResults,
  };
}

/**
 * Searches the files in the inventory. Uses ripgrep when installed and falls back to a built-in
 * scanner otherwise. Either way only inventory files can appear in results, so the exclusion
 * policy (secrets, dependencies, caches, binaries, symlinks) cannot be bypassed.
 */
export async function searchText(
  inventory: Inventory,
  run: Runner,
  options: SearchOptions,
): Promise<SearchResult> {
  if (options.patterns.length === 0 || options.patterns.every((p) => p === '')) {
    return { hits: [], engine: 'builtin', truncated: false };
  }
  if (options.engine !== 'builtin') {
    const viaRg = await ripgrepSearch(inventory, run, options);
    if (viaRg) return viaRg;
    if (options.engine === 'ripgrep')
      return { hits: [], engine: 'ripgrep', truncated: false, error: 'ripgrep is not available.' };
  }
  return builtinSearch(inventory, options);
}
