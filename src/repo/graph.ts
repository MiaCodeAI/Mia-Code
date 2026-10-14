import type { FileAnalysis, Inventory } from './types.js';

export interface ImportGraph {
  /** file -> internal files it imports */
  edges: Map<string, string[]>;
  importedBy: Map<string, number>;
  /** Top-level package name -> number of files importing it (JavaScript/TypeScript only). */
  externalPackages: Map<string, number>;
}

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]);

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function joinNormalized(base: string, relative: string): string | null {
  const parts = base === '' ? [] : base.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

function resolveJs(from: string, spec: string, files: ReadonlySet<string>): string | null {
  const target = joinNormalized(dirname(from), spec);
  if (target === null) return null;
  const candidates = [target];
  // TypeScript ESM style: "./x.js" refers to x.ts
  const stripped = target.replace(/\.(?:c|m)?jsx?$/, '');
  if (stripped !== target)
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) candidates.push(stripped + ext);
  for (const ext of JS_EXT) candidates.push(target + ext);
  for (const ext of JS_EXT) candidates.push(`${target}/index${ext}`);
  return candidates.find((c) => files.has(c)) ?? null;
}

function resolvePython(from: string, spec: string, files: ReadonlySet<string>): string | null {
  let base: string;
  let module = spec;
  if (spec.startsWith('.')) {
    const dots = /^\.+/.exec(spec)?.[0].length ?? 1;
    let dir = dirname(from);
    for (let i = 1; i < dots; i++) dir = dirname(dir);
    base = dir;
    module = spec.slice(dots);
  } else {
    base = '';
  }
  const rel = module.split('.').filter(Boolean).join('/');
  const roots = spec.startsWith('.') ? [base] : ['', 'src', dirname(from)];
  for (const root of roots) {
    const prefix = root === '' ? '' : `${root}/`;
    const target = rel === '' ? root : `${prefix}${rel}`;
    for (const candidate of [`${target}.py`, `${target}/__init__.py`])
      if (files.has(candidate)) return candidate;
  }
  return null;
}

export function packageName(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  if (name === '' || NODE_BUILTINS.has(name) || /^(?:[a-z]+:|#)/.test(name)) return null;
  return name;
}

/** Resolves imports between project files (JavaScript/TypeScript and Python only). */
export function buildImportGraph(
  inventory: Inventory,
  analyses: ReadonlyMap<string, FileAnalysis>,
): ImportGraph {
  const files = new Set(inventory.files.map((f) => f.path));
  const edges = new Map<string, string[]>();
  const importedBy = new Map<string, number>();
  const externalPackages = new Map<string, number>();

  for (const [from, analysis] of analyses) {
    const targets = new Set<string>();
    const externals = new Set<string>();
    const isPython = from.endsWith('.py');
    for (const spec of analysis.imports) {
      let resolved: string | null = null;
      if (isPython) resolved = resolvePython(from, spec, files);
      else if (spec.startsWith('.')) resolved = resolveJs(from, spec, files);
      else {
        const name = packageName(spec);
        if (name) externals.add(name);
      }
      if (resolved && resolved !== from) targets.add(resolved);
    }
    edges.set(from, [...targets].sort());
    for (const target of targets) importedBy.set(target, (importedBy.get(target) ?? 0) + 1);
    for (const name of externals) externalPackages.set(name, (externalPackages.get(name) ?? 0) + 1);
  }
  return { edges, importedBy, externalPackages };
}
