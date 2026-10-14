import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Runner } from '../platform/exec.js';
import { listGitFiles, listTrackedFiles } from '../project/git.js';
import {
  excludedDirReason,
  excludedFileReason,
  excludedPathReason,
} from '../project/exclusions.js';
import { mapLimit } from '../util/concurrency.js';
import type { FileEntry, Inventory } from './types.js';

/** Identity of a file's current state. Any write changes the modification or change time. */
export function fileSignature(f: FileEntry): string {
  return `${f.size}:${f.mtimeNs}:${f.ctimeNs}:${f.ino}`;
}

/**
 * File systems stamp times with a coarse clock (often 1-10 ms, sometimes 1-2 s), so two writes of
 * the same size can share a timestamp. A file modified within this window of when it was read is
 * "racy" (the same idea git uses) and is re-read on the next refresh instead of being trusted.
 */
export const RACY_WINDOW_MS = 2500;

export interface InventoryOptions {
  /** Upper bound on listed files (default 20,000). */
  maxFiles?: number;
}

function depth(p: string): number {
  return p.split('/').length;
}

function byDepthThenName(a: string, b: string): number {
  return depth(a) - depth(b) || a.localeCompare(b);
}

async function walk(
  root: string,
  limit: number,
): Promise<{ files: string[]; secret: string[]; excluded: number; truncated: boolean }> {
  const files: string[] = [];
  const secret: string[] = [];
  let excluded = 0;
  let truncated = false;
  let queue: string[] = [''];
  while (queue.length > 0) {
    const next: string[] = [];
    for (const rel of queue) {
      let entries;
      try {
        entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // links could point outside the project
        const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (excludedDirReason(entry.name)) excluded++;
          else next.push(relPath);
        } else if (entry.isFile()) {
          const reason = excludedFileReason(entry.name);
          if (reason === 'secret') {
            secret.push(relPath);
            excluded++;
          } else if (reason) excluded++;
          else if (files.length >= limit) truncated = true;
          else files.push(relPath);
        }
      }
    }
    queue = next;
  }
  return { files, secret, excluded, truncated };
}

/**
 * Lists the files Mia Code may look at. Uses git (so `.gitignore` is honoured) when available,
 * otherwise walks the directory. The exclusion policy is applied either way, and symbolic links
 * are never listed.
 */
export async function buildInventory(
  directory: string,
  run: Runner,
  env: NodeJS.ProcessEnv,
  options: InventoryOptions = {},
): Promise<Inventory> {
  const root = await fs.realpath(directory);
  const maxFiles = options.maxFiles ?? 20_000;

  let candidates: string[] = [];
  const secretFiles: string[] = [];
  let excludedCount = 0;
  let truncated = false;
  let tracked: Set<string> | null = null;
  let usedGit = false;

  const listing = await listGitFiles(run, root, env);
  if (listing) {
    usedGit = true;
    const trackedList = await listTrackedFiles(run, root, env);
    tracked = new Set(trackedList ?? []);
    for (const rel of listing) {
      const reason = excludedPathReason(rel);
      if (reason === 'secret') {
        secretFiles.push(rel);
        excludedCount++;
      } else if (reason) excludedCount++;
      else candidates.push(rel);
    }
    candidates.sort(byDepthThenName);
    if (candidates.length > maxFiles) {
      candidates = candidates.slice(0, maxFiles);
      truncated = true;
    }
  } else {
    const walked = await walk(root, maxFiles);
    candidates = walked.files.sort(byDepthThenName);
    secretFiles.push(...walked.secret);
    excludedCount = walked.excluded;
    truncated = walked.truncated;
  }

  const stats = await mapLimit(candidates, 64, async (rel) => {
    try {
      const stat = await fs.lstat(path.join(root, rel), { bigint: true });
      if (!stat.isFile()) return null; // skips symlinks, directories, files deleted since the listing
      const entry: FileEntry = {
        path: rel,
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeNs) / 1e6,
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        ino: stat.ino.toString(),
      };
      return entry;
    } catch {
      return null;
    }
  });
  const files = stats.filter((e): e is FileEntry => e !== null);

  const hash = createHash('sha1');
  for (const file of files) hash.update(`${file.path}\0${fileSignature(file)}\n`);

  return {
    root,
    files,
    byPath: new Map(files.map((f) => [f.path, f])),
    secretFiles: secretFiles.sort(),
    tracked,
    excludedCount,
    usedGit,
    truncated,
    fingerprint: hash.digest('hex'),
  };
}
