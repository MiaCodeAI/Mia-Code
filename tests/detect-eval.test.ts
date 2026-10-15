import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DETECT_CASES } from '../bench/detect-cases.js';
import { detectProfile } from '../src/repo/detect.js';
import { buildInventory } from '../src/repo/inventory.js';

const noGit = async () => ({
  exitCode: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
});

async function detect(files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mia-detect-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    }
    const inv = await buildInventory(dir, noGit, {});
    return await detectProfile(inv, new Map());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('project detection evaluation set', () => {
  for (const c of DETECT_CASES) {
    it(`${c.language}: ${c.name}`, async () => {
      const p = await detect(c.files);
      const got = {
        test: p.commands.test,
        lint: p.commands.lint,
        typecheck: p.commands.typecheck,
        build: p.commands.build,
      };
      const want = {
        test: undefined,
        lint: undefined,
        typecheck: undefined,
        build: undefined,
        ...c.expect,
      };
      expect(got).toEqual(want);
      if (c.ecosystem) expect(p.ecosystems).toContain(c.ecosystem);
    });
  }
});
