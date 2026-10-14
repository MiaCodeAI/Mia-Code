import type { Runner } from '../platform/exec.js';
import { readGitInfo, type GitInfo } from '../project/git.js';
import { redact } from '../security/redact.js';
import type { RepoIndex } from './index.js';
import { buildRepoMap, renderRepoMap } from './map.js';
import { readTextFile } from './read.js';

export interface Overview {
  text: string;
  git: GitInfo | null;
}

/**
 * The project overview placed in the model's context: a compact repository map, the list of
 * readable file paths, and the start of the README. File contents beyond the README excerpt are
 * only sent as evidence excerpts (see evidence.ts).
 */
export async function buildOverview(
  index: RepoIndex,
  run: Runner,
  env: NodeJS.ProcessEnv,
  options: { maxPaths?: number; readmeBytes?: number } = {},
): Promise<Overview> {
  const maxPaths = options.maxPaths ?? 150;
  const readmeBytes = options.readmeBytes ?? 2000;
  const { inventory } = index;
  const git = await readGitInfo(run, inventory.root, env);
  const { map } = buildRepoMap(index);

  const lines: string[] = [];
  if (git) {
    const dirty = git.changedPaths === 0 ? 'clean' : `${git.changedPaths} changed path(s)`;
    lines.push(`Git: branch ${git.branch ?? 'unknown'}, working tree ${dirty}`);
  } else lines.push('Git: not a git repository (or git unavailable)');
  lines.push(...renderRepoMap(map, { compact: true }));

  const shown = inventory.files.map((f) => f.path).filter((p) => p.split('/').length <= 3);
  lines.push('', 'File paths (contents are NOT included unless shown as excerpts):');
  for (const p of shown.slice(0, maxPaths)) lines.push(`  ${p}`);
  if (shown.length > maxPaths) lines.push(`  … ${shown.length - maxPaths} more not listed`);
  if (inventory.excludedCount > 0) {
    lines.push(
      `(${inventory.excludedCount} path(s) omitted: secrets, dependencies, build output, caches, binaries)`,
    );
  }

  const readme = inventory.files.find(
    (f) => !f.path.includes('/') && /^readme(\.[a-z]+)?$/i.test(f.path),
  );
  if (readme) {
    try {
      const { text } = await readTextFile(inventory.root, readme.path, { maxBytes: 200_000 });
      lines.push('', `Start of ${readme.path}:`, redact(text.slice(0, readmeBytes)).trim());
    } catch {
      // unreadable README: skip silently
    }
  }
  return { text: lines.join('\n'), git };
}
