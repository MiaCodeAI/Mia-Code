import type { FileEntry } from './types.js';

export type LanguageKind = 'code' | 'markup' | 'data' | 'docs';

export interface LanguageInfo {
  name: string;
  kind: LanguageKind;
}

const BY_EXTENSION: Record<string, LanguageInfo> = {
  '.ts': { name: 'TypeScript', kind: 'code' },
  '.tsx': { name: 'TypeScript', kind: 'code' },
  '.mts': { name: 'TypeScript', kind: 'code' },
  '.cts': { name: 'TypeScript', kind: 'code' },
  '.js': { name: 'JavaScript', kind: 'code' },
  '.jsx': { name: 'JavaScript', kind: 'code' },
  '.mjs': { name: 'JavaScript', kind: 'code' },
  '.cjs': { name: 'JavaScript', kind: 'code' },
  '.py': { name: 'Python', kind: 'code' },
  '.go': { name: 'Go', kind: 'code' },
  '.rs': { name: 'Rust', kind: 'code' },
  '.java': { name: 'Java', kind: 'code' },
  '.kt': { name: 'Kotlin', kind: 'code' },
  '.kts': { name: 'Kotlin', kind: 'code' },
  '.scala': { name: 'Scala', kind: 'code' },
  '.cs': { name: 'C#', kind: 'code' },
  '.php': { name: 'PHP', kind: 'code' },
  '.rb': { name: 'Ruby', kind: 'code' },
  '.swift': { name: 'Swift', kind: 'code' },
  '.dart': { name: 'Dart', kind: 'code' },
  '.c': { name: 'C', kind: 'code' },
  '.h': { name: 'C/C++ header', kind: 'code' },
  '.cc': { name: 'C++', kind: 'code' },
  '.cpp': { name: 'C++', kind: 'code' },
  '.cxx': { name: 'C++', kind: 'code' },
  '.hpp': { name: 'C++', kind: 'code' },
  '.m': { name: 'Objective-C', kind: 'code' },
  '.lua': { name: 'Lua', kind: 'code' },
  '.sh': { name: 'Shell', kind: 'code' },
  '.bash': { name: 'Shell', kind: 'code' },
  '.zsh': { name: 'Shell', kind: 'code' },
  '.ps1': { name: 'PowerShell', kind: 'code' },
  '.bat': { name: 'Batch', kind: 'code' },
  '.cmd': { name: 'Batch', kind: 'code' },
  '.sql': { name: 'SQL', kind: 'code' },
  '.r': { name: 'R', kind: 'code' },
  '.ex': { name: 'Elixir', kind: 'code' },
  '.exs': { name: 'Elixir', kind: 'code' },
  '.vue': { name: 'Vue', kind: 'code' },
  '.svelte': { name: 'Svelte', kind: 'code' },
  '.html': { name: 'HTML', kind: 'markup' },
  '.htm': { name: 'HTML', kind: 'markup' },
  '.css': { name: 'CSS', kind: 'markup' },
  '.scss': { name: 'SCSS', kind: 'markup' },
  '.less': { name: 'Less', kind: 'markup' },
  '.json': { name: 'JSON', kind: 'data' },
  '.yml': { name: 'YAML', kind: 'data' },
  '.yaml': { name: 'YAML', kind: 'data' },
  '.toml': { name: 'TOML', kind: 'data' },
  '.xml': { name: 'XML', kind: 'data' },
  '.md': { name: 'Markdown', kind: 'docs' },
  '.rst': { name: 'reStructuredText', kind: 'docs' },
  '.txt': { name: 'Text', kind: 'docs' },
};

const BY_FILENAME: Record<string, LanguageInfo> = {
  dockerfile: { name: 'Dockerfile', kind: 'code' },
  makefile: { name: 'Makefile', kind: 'code' },
  jenkinsfile: { name: 'Jenkinsfile', kind: 'code' },
};

export function languageOf(filePath: string): LanguageInfo | undefined {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  const byName = BY_FILENAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION[name.slice(dot)] : undefined;
}

export interface LanguageStat {
  language: string;
  files: number;
  bytes: number;
}

/** Counts code and markup languages (data and docs files are not languages of the project). */
export function languageStats(files: readonly FileEntry[]): LanguageStat[] {
  const totals = new Map<string, LanguageStat>();
  for (const file of files) {
    const info = languageOf(file.path);
    if (!info || (info.kind !== 'code' && info.kind !== 'markup')) continue;
    const entry = totals.get(info.name) ?? { language: info.name, files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.size;
    totals.set(info.name, entry);
  }
  return [...totals.values()].sort(
    (a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language),
  );
}

export function isCodeFile(filePath: string): boolean {
  return languageOf(filePath)?.kind === 'code';
}
