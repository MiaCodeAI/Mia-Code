import type { Runner } from '../platform/exec.js';
import { readFileSafe } from '../platform/safefs.js';
import { safeGitArgs, safeGitEnv } from '../project/git.js';
import { buildInventory, fileSignature } from '../repo/inventory.js';
import type { Checkpoints } from './checkpoints.js';

export interface ShellSnapshot {
  signatures: Map<string, string>;
  /** Paths git reports as modified/untracked before the command (their HEAD copy is not their "before"). */
  dirty: Set<string> | null;
  tracked: Set<string> | null;
}

export interface ShellDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * Makes file changes made by shell commands visible. Before and after each command it compares exact
 * file signatures. A changed file that git tracks and that was clean beforehand gets its "before" text
 * from `git show HEAD:path`, so it shows up in /diff and can be undone. Anything else is reported as
 * changed but not undoable. Limits: only files Mia Code lists are seen (not node_modules, build output,
 * ignored files or secret files); a command that edits and then reverts a file is invisible.
 */
export class ShellTracker {
  constructor(
    private readonly root: string,
    private readonly run: Runner,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  private git(args: string[]) {
    return this.run('git', safeGitArgs(args), {
      cwd: this.root,
      env: safeGitEnv(this.env),
      timeoutMs: 20_000,
      maxOutputBytes: 8_000_000,
    });
  }

  async snapshot(): Promise<ShellSnapshot> {
    const inv = await buildInventory(this.root, this.run, this.env);
    const signatures = new Map(inv.files.map((f) => [f.path, fileSignature(f)]));
    let dirty: Set<string> | null = null;
    if (inv.tracked) {
      const st = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
      if (st.exitCode === 0) {
        dirty = new Set();
        for (const rec of st.stdout.split('\0')) if (rec.length > 3) dirty.add(rec.slice(3));
      }
    }
    return { signatures, dirty, tracked: inv.tracked };
  }

  /** Compares with `before`, records changes into `checkpoints`, and returns what changed. */
  async finish(before: ShellSnapshot, checkpoints: Checkpoints): Promise<ShellDiff> {
    const after = await this.snapshot();
    const diff: ShellDiff = { added: [], modified: [], deleted: [] };
    for (const [p, sig] of after.signatures) {
      const old = before.signatures.get(p);
      if (old === undefined) diff.added.push(p);
      else if (old !== sig) diff.modified.push(p);
    }
    for (const p of before.signatures.keys()) if (!after.signatures.has(p)) diff.deleted.push(p);

    const read = async (p: string): Promise<string | null> => {
      try {
        return await readFileSafe(this.root, p, 1_000_000);
      } catch {
        return null;
      }
    };
    const headCopy = async (p: string): Promise<string | undefined> => {
      if (!before.tracked?.has(p) || !before.dirty || before.dirty.has(p)) return undefined;
      const r = await this.git(['show', `HEAD:${p}`]);
      return r.exitCode === 0 ? r.stdout : undefined;
    };
    for (const p of diff.added) checkpoints.record(p, null, await read(p), 'shell');
    for (const p of [...diff.modified, ...diff.deleted]) {
      const orig = await headCopy(p);
      if (orig === undefined)
        checkpoints.markUnrestorable(p, diff.deleted.includes(p) ? 'deleted' : 'modified');
      else checkpoints.record(p, orig, diff.deleted.includes(p) ? null : await read(p), 'shell');
    }
    return diff;
  }
}
