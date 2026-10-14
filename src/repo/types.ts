export interface FileEntry {
  /** Path relative to the project root, always `/`-separated. */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface Inventory {
  /** Real (symlink-resolved) absolute path of the project root. */
  root: string;
  /** Files that may be read, shallowest first. Secrets, dependencies, build output, caches, binaries and symlinks are never listed. */
  files: FileEntry[];
  byPath: Map<string, FileEntry>;
  /** Secret-bearing files that exist (names only; their contents are never read). */
  secretFiles: string[];
  /** Paths git tracks, or null when this is not a git repository. */
  tracked: Set<string> | null;
  excludedCount: number;
  usedGit: boolean;
  /** True when the file limit was reached and some files are not listed. */
  truncated: boolean;
  /** Changes whenever any listed file is added, removed or modified. */
  fingerprint: string;
}

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'module'
  | 'variable';

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
}

export interface RouteEntry {
  method: string;
  route: string;
  path: string;
  line: number;
}

/** Facts extracted from one source file by pattern matching (not a full parse). */
export interface FileAnalysis {
  symbols: SymbolEntry[];
  /** Raw import specifiers as written in the file. */
  imports: string[];
  /** Environment variable NAMES referenced (never values). */
  envVars: string[];
  routes: RouteEntry[];
  lineCount: number;
}
