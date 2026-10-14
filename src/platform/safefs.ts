import { constants as C, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * File operations that do not follow symbolic links at the moment they act.
 *
 * Checking a path and then using it leaves a gap in which a directory can be swapped for a
 * symlink. On Linux this module closes the gap: it walks from the project root one directory at a
 * time, opening each with O_NOFOLLOW|O_DIRECTORY, and then operates relative to the verified
 * directory handle (/proc/self/fd/N), so later swaps of the path cannot redirect it. On other
 * platforms the final component is opened with O_NOFOLLOW where available and the result is
 * verified afterwards (the device and inode of the opened file must match the path, and the real
 * location must be inside the project); a narrow race remains there, which is why command
 * isolation (see docs/security.md) is the real boundary.
 */

export class UnsafePathError extends Error {
  constructor(
    message: string,
    readonly code: 'unsafe' | 'too-large' = 'unsafe',
  ) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const NOFOLLOW = C.O_NOFOLLOW ?? 0;
const ANCHORED = process.platform === 'linux';

/** Test seam: runs at named points so tests can swap a directory for a symlink mid-operation. */
export interface Hooks {
  between?: (stage: 'before-walk' | 'before-open') => Promise<void> | void;
}

const isInside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function segmentsOf(rel: string): string[] {
  const parts = rel.split('/').filter((s) => s !== '');
  if (parts.length === 0 || parts.some((s) => s === '.' || s === '..' || s.includes('\0'))) {
    throw new UnsafePathError('The path is not a plain project-relative path.');
  }
  return parts;
}

interface Anchor {
  /** Path usable for operations on children of the verified directory. */
  dirPath: string;
  close(): Promise<void>;
}

async function openDirNoFollow(p: string): Promise<FileHandle> {
  try {
    return await fs.open(p, C.O_RDONLY | (C.O_DIRECTORY ?? 0) | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR')
      throw new UnsafePathError('A directory in the path is a symbolic link or not a directory.');
    throw error;
  }
}

/** Walks to the parent directory of `segments`, never following links. Creates directories when asked. */
async function anchorParent(root: string, segments: string[], create: boolean): Promise<Anchor> {
  const dirs = segments.slice(0, -1);
  if (ANCHORED) {
    const handles: FileHandle[] = [await openDirNoFollow(root)];
    const closeAll = async (): Promise<void> => {
      for (const h of handles.splice(0)) await h.close().catch(() => undefined);
    };
    try {
      for (const seg of dirs) {
        const here = `/proc/self/fd/${handles.at(-1)!.fd}`;
        try {
          handles.push(await openDirNoFollow(`${here}/${seg}`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && create) {
            await fs.mkdir(`${here}/${seg}`);
            handles.push(await openDirNoFollow(`${here}/${seg}`));
          } else throw error;
        }
      }
      return { dirPath: `/proc/self/fd/${handles.at(-1)!.fd}`, close: closeAll };
    } catch (error) {
      await closeAll();
      throw error;
    }
  }
  // Portable path: check each component with lstat (no following), then verify after opening.
  let current = root;
  for (const seg of dirs) {
    current = path.join(current, seg);
    let st: Stats | undefined;
    try {
      st = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (st === undefined) {
      if (!create) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      await fs.mkdir(current);
    } else if (!st.isDirectory())
      throw new UnsafePathError('A directory in the path is a symbolic link or not a directory.');
  }
  return { dirPath: current, close: async () => undefined };
}

async function verifyOpened(
  root: string,
  rootReal: string,
  rel: string,
  handle: FileHandle,
): Promise<void> {
  const st = await handle.stat();
  if (!st.isFile()) throw new UnsafePathError('The path is not a regular file.');
  if (ANCHORED) return; // already anchored to verified directories
  const abs = path.join(root, ...rel.split('/'));
  const link = await fs.lstat(abs);
  if (link.isSymbolicLink() || link.ino !== st.ino || link.dev !== st.dev) {
    throw new UnsafePathError('The file changed while it was being opened.');
  }
  const real = await fs.realpath(abs);
  if (!isInside(rootReal, real))
    throw new UnsafePathError('The file resolves outside the project.');
}

export interface WriteOptions extends Hooks {
  /** Require that the file already exists (true), must not exist (false), or either (undefined). */
  mustExist?: boolean;
}

/** Writes `content`, replacing the file. Refuses symlinks anywhere on the path. */
export async function writeFileSafe(
  root: string,
  rel: string,
  content: string,
  options: WriteOptions = {},
): Promise<void> {
  const rootReal = await fs.realpath(root);
  const segments = segmentsOf(rel);
  await options.between?.('before-walk');
  const anchor = await anchorParent(rootReal, segments, options.mustExist !== true);
  const name = segments.at(-1)!;
  const target = `${anchor.dirPath}/${name}`;
  let handle: FileHandle | undefined;
  let created = false;
  try {
    await options.between?.('before-open');
    const base = C.O_WRONLY | NOFOLLOW;
    if (options.mustExist === true) handle = await fs.open(target, base);
    else if (options.mustExist === false) {
      handle = await fs.open(target, base | C.O_CREAT | C.O_EXCL);
      created = true;
    } else {
      try {
        handle = await fs.open(target, base | C.O_CREAT | C.O_EXCL);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        handle = await fs.open(target, base);
      }
    }
    try {
      await verifyOpened(rootReal, rootReal, segments.join('/'), handle);
    } catch (error) {
      if (created) await fs.unlink(target).catch(() => undefined);
      throw error;
    }
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new UnsafePathError('The file is a symbolic link.');
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await anchor.close();
  }
}

/** Reads a file without following symlinks. Returns null when it does not exist. */
export async function readFileSafe(
  root: string,
  rel: string,
  maxBytes = 5_000_000,
): Promise<string | null> {
  const rootReal = await fs.realpath(root);
  const segments = segmentsOf(rel);
  let anchor: Anchor;
  try {
    anchor = await anchorParent(rootReal, segments, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await fs.open(`${anchor.dirPath}/${segments.at(-1)!}`, C.O_RDONLY | NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP') throw new UnsafePathError('The file is a symbolic link.');
      throw error;
    }
    await verifyOpened(rootReal, rootReal, segments.join('/'), handle);
    if ((await handle.stat()).size > maxBytes)
      throw new UnsafePathError('The file is too large.', 'too-large');
    return await handle.readFile('utf8');
  } finally {
    await handle?.close().catch(() => undefined);
    await anchor.close();
  }
}

/** Deletes a regular file without following symlinks. Returns false when it was already gone. */
export async function removeFileSafe(root: string, rel: string): Promise<boolean> {
  const rootReal = await fs.realpath(root);
  const segments = segmentsOf(rel);
  let anchor: Anchor;
  try {
    anchor = await anchorParent(rootReal, segments, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const target = `${anchor.dirPath}/${segments.at(-1)!}`;
    const st = await fs.lstat(target).catch(() => null);
    if (!st) return false;
    if (st.isSymbolicLink())
      throw new UnsafePathError('Refusing to delete through a symbolic link.');
    if (!st.isFile()) throw new UnsafePathError('The path is not a regular file.');
    await fs.unlink(target);
    return true;
  } finally {
    await anchor.close();
  }
}
