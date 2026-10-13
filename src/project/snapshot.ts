import fs from 'node:fs/promises';
import path from 'node:path';
import type { Runner } from '../platform/exec.js';
import { redact } from '../security/redact.js';
import { excludedDirReason, excludedFileReason, excludedPathReason } from './exclusions.js';
import { listGitFiles, readGitInfo, type GitInfo } from './git.js';

export interface SnapshotOptions {
  /** Maximum number of file paths listed. */
  maxEntries?: number;
  /** Maximum number of path segments listed (3 = `src/providers/openai.ts`). */
  maxSegments?: number;
  readmeBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ProjectSnapshot {
  directory: string;
  git: GitInfo | null;
  /** File paths shown, shallowest first. */
  entries: string[];
  /** Top-level directories with the number of included files they contain. */
  directories: { name: string; files: number }[];
  manifests: string[];
  readmeName: string | undefined;
  readmeExcerpt: string | undefined;
  truncated: boolean;
  /** Paths left out because of the exclusion policy (not their names, to avoid leaking them). */
  excludedCount: number;
}

const MANIFESTS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'pubspec.yaml',
  'composer.json',
  'Gemfile',
  'Dockerfile',
  'docker-compose.yml',
  'compose.yaml',
  'Makefile',
  'CMakeLists.txt',
  'tsconfig.json',
  'MIA.md',
]);

async function walk(
  root: string,
  maxSegments: number,
  cap: number,
): Promise<{ files: string[]; excluded: number }> {
  const files: string[] = [];
  let excluded = 0;
  let queue: { rel: string; depth: number }[] = [{ rel: '', depth: 1 }];
  while (queue.length > 0 && files.length < cap * 4) {
    const next: { rel: string; depth: number }[] = [];
    for (const { rel, depth } of queue) {
      let dirents;
      try {
        dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of dirents) {
        if (entry.isSymbolicLink()) continue; // never follow links out of the project
        const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (excludedDirReason(entry.name)) excluded++;
          else if (depth < maxSegments) next.push({ rel: relPath, depth: depth + 1 });
        } else if (entry.isFile()) {
          if (excludedFileReason(entry.name)) excluded++;
          else files.push(relPath);
        }
      }
    }
    queue = next;
  }
  return { files, excluded };
}

async function readExcerpt(file: string, bytes: number): Promise<string | undefined> {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) return undefined;
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return redact(buffer.subarray(0, bytesRead).toString('utf8')).trim();
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export async function buildSnapshot(
  directory: string,
  run: Runner,
  options: SnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const maxEntries = options.maxEntries ?? 200;
  const maxSegments = options.maxSegments ?? 3;
  const readmeBytes = options.readmeBytes ?? 2000;
  const env = options.env ?? process.env;

  const git = await readGitInfo(run, directory, env);
  let all: string[];
  let excluded = 0;

  const tracked = git ? await listGitFiles(run, directory, env) : null;
  if (tracked) {
    all = [];
    for (const rel of tracked) {
      if (excludedPathReason(rel)) excluded++;
      else all.push(rel);
    }
  } else {
    const walked = await walk(directory, maxSegments, maxEntries);
    all = walked.files;
    excluded = walked.excluded;
  }
  all.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  const counts = new Map<string, number>();
  for (const rel of all) {
    const slash = rel.indexOf('/');
    if (slash > 0) counts.set(rel.slice(0, slash), (counts.get(rel.slice(0, slash)) ?? 0) + 1);
  }

  const shown = all.filter((rel) => rel.split('/').length <= maxSegments);
  const entries = shown.slice(0, maxEntries);

  const topLevel = all.filter((rel) => !rel.includes('/'));
  const manifests = topLevel.filter((name) => MANIFESTS.has(name));
  const readmeName = topLevel.find((name) => /^readme(?:\.[a-z]+)?$/i.test(name));
  const readmeExcerpt = readmeName
    ? await readExcerpt(path.join(directory, readmeName), readmeBytes)
    : undefined;

  return {
    directory,
    git,
    entries,
    directories: [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, files]) => ({ name, files })),
    manifests,
    readmeName,
    readmeExcerpt,
    truncated: shown.length > entries.length,
    excludedCount: excluded,
  };
}

/** The exact text that is placed in the model's context. `/context` shows this to the user. */
export function renderSnapshot(snapshot: ProjectSnapshot): string {
  const lines: string[] = [];
  lines.push(`Directory: ${path.basename(snapshot.directory) || snapshot.directory}`);
  if (snapshot.git) {
    const dirty =
      snapshot.git.changedPaths === 0 ? 'clean' : `${snapshot.git.changedPaths} changed path(s)`;
    lines.push(`Git: branch ${snapshot.git.branch ?? 'unknown'}, working tree ${dirty}`);
  } else {
    lines.push('Git: not a git repository (or git unavailable)');
  }
  if (snapshot.manifests.length > 0)
    lines.push(`Recognized project files: ${snapshot.manifests.join(', ')}`);
  if (snapshot.directories.length > 0) {
    lines.push(
      'Top-level directories (included file counts): ' +
        snapshot.directories.map((d) => `${d.name}/ (${d.files})`).join(', '),
    );
  }
  lines.push('', 'File paths (file contents are NOT included):');
  for (const entry of snapshot.entries) lines.push(`  ${entry}`);
  if (snapshot.truncated) lines.push('  … list truncated');
  if (snapshot.excludedCount > 0) {
    lines.push(
      `(${snapshot.excludedCount} path(s) omitted: secrets, dependencies, build output, caches or binaries)`,
    );
  }
  if (snapshot.readmeExcerpt) {
    lines.push('', `Start of ${snapshot.readmeName ?? 'README'}:`, snapshot.readmeExcerpt);
  }
  return lines.join('\n');
}
