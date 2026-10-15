import type { Runner } from '../platform/exec.js';
import { mapLimit } from '../util/concurrency.js';
import { analyzeFile } from './analysis.js';
import { detectProfile, type ProjectProfile } from './detect.js';
import { buildInventory, fileSignature, RACY_WINDOW_MS } from './inventory.js';
import { isCodeFile } from './languages.js';
import { readTextFile } from './read.js';
import type { FileAnalysis, Inventory, SymbolEntry } from './types.js';

export interface IndexOptions {
  maxFiles?: number;
  /** Source files analysed for symbols and imports (default 4000). */
  maxAnalyzedFiles?: number;
  /** Source files larger than this are listed but not analysed (default 300 KB). */
  maxAnalyzedBytes?: number;
}

/**
 * Holds the project inventory and per-file analysis. `refresh()` is cheap to call repeatedly:
 * the file list is rebuilt every time, but a file is re-read only when its size or modification
 * time changed, and entries for deleted files are dropped. So a stale answer cannot outlive an edit.
 */
export class RepoIndex {
  inventory!: Inventory;
  profile!: ProjectProfile;
  readonly analyses = new Map<string, FileAnalysis>();
  /** Number of files read during the last refresh (useful for tests and diagnostics). */
  lastRefreshReads = 0;
  analysisTruncated = false;
  private readonly signatures = new Map<string, string>();
  /** Files whose timestamps were too close to the read time to trust; re-read next time. */
  private readonly racy = new Set<string>();

  constructor(
    readonly directory: string,
    private readonly run: Runner,
    private readonly env: NodeJS.ProcessEnv,
    private readonly options: IndexOptions = {},
  ) {}

  async refresh(): Promise<void> {
    const startedAt = Date.now();
    const inventory = await buildInventory(this.directory, this.run, this.env, {
      ...(this.options.maxFiles !== undefined ? { maxFiles: this.options.maxFiles } : {}),
    });
    this.inventory = inventory;

    const maxAnalyzed = this.options.maxAnalyzedFiles ?? 4000;
    const maxBytes = this.options.maxAnalyzedBytes ?? 300_000;
    const sources = inventory.files.filter((f) => isCodeFile(f.path) && f.size <= maxBytes);
    this.analysisTruncated = sources.length > maxAnalyzed;
    const wanted = sources.slice(0, maxAnalyzed);
    const wantedPaths = new Set(wanted.map((f) => f.path));

    for (const known of [...this.analyses.keys()]) {
      if (!wantedPaths.has(known)) {
        this.analyses.delete(known);
        this.signatures.delete(known);
      }
    }

    const stale = wanted.filter(
      (f) => this.racy.has(f.path) || this.signatures.get(f.path) !== fileSignature(f),
    );
    this.racy.clear();
    this.lastRefreshReads = 0;
    await mapLimit(stale, 16, async (file) => {
      try {
        const { text } = await readTextFile(inventory.root, file.path, { maxBytes });
        this.analyses.set(file.path, analyzeFile(file.path, text));
        this.signatures.set(file.path, fileSignature(file));
        if (startedAt - file.mtimeMs < RACY_WINDOW_MS) this.racy.add(file.path);
        this.lastRefreshReads++;
      } catch {
        this.analyses.delete(file.path);
        this.signatures.delete(file.path);
      }
    });

    this.profile = await detectProfile(inventory, this.analyses);
  }

  allSymbols(): SymbolEntry[] {
    const out: SymbolEntry[] = [];
    for (const analysis of this.analyses.values()) out.push(...analysis.symbols);
    return out;
  }

  /** Symbols whose name matches, best matches first: exact, then prefix, then substring. */
  findSymbols(query: string, limit = 25): SymbolEntry[] {
    const q = query.toLowerCase();
    if (q === '') return [];
    const scored: { entry: SymbolEntry; score: number }[] = [];
    for (const entry of this.allSymbols()) {
      const name = entry.name.toLowerCase();
      const score = name === q ? 3 : name.startsWith(q) ? 2 : name.includes(q) ? 1 : 0;
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.path.split('/').length - b.entry.path.split('/').length ||
        a.entry.path.localeCompare(b.entry.path) ||
        a.entry.line - b.entry.line,
    );
    return scored.slice(0, limit).map((s) => s.entry);
  }
}
