import { promises as fs } from 'node:fs';
import path from 'node:path';
import { excludedPathReason } from '../project/exclusions.js';

export type PermissionMode = 'readonly' | 'ask' | 'auto-edit' | 'auto';
export const PERMISSION_MODES: readonly PermissionMode[] = ['readonly', 'ask', 'auto-edit', 'auto'];
export type Risk = 'read' | 'write' | 'exec';
export type Decision = 'allow' | 'ask' | 'deny';

export function decide(mode: PermissionMode, risk: Risk): Decision {
  if (risk === 'read') return 'allow';
  switch (mode) {
    case 'readonly':
      return 'deny';
    case 'ask':
      return 'ask';
    case 'auto-edit':
      return risk === 'write' ? 'allow' : 'ask';
    case 'auto':
      return 'allow';
  }
}

export function describeMode(mode: PermissionMode): string {
  switch (mode) {
    case 'readonly':
      return 'read-only: can read and search, cannot change files or run commands';
    case 'ask':
      return 'ask: every file change and command needs your approval';
    case 'auto-edit':
      return 'auto-edit: file edits are applied automatically; commands need approval';
    case 'auto':
      return 'auto: edits and commands run without asking (hard safety blocks still apply)';
  }
}

interface BlockRule {
  pattern: RegExp;
  reason: string;
}

/**
 * Commands that are refused in EVERY mode, including "auto". This is a guardrail against obvious
 * mistakes, not a sandbox: a determined or confused model can phrase a harmful command in ways
 * a pattern list will not recognise. Use a container or VM for untrusted work.
 */
const BLOCKED: BlockRule[] = [
  {
    pattern: /(^|[\s;&|(])sudo\b|(^|[\s;&|(])su\s+-?\w*\s*($|[;&|])|\bdoas\b/,
    reason: 'privilege escalation',
  },
  {
    pattern: /\brm\s+(-\w*\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(\/|~|\$HOME|\*|\.\.?)(\s|\/|$)/,
    reason: 'recursive delete of a broad location',
  },
  {
    pattern: /\brm\s+(-\w*\s+)*-\w*[fF]\w*\s+(-\w+\s+)*(\/|~|\$HOME)(\s|\/|$)/,
    reason: 'forced delete of a broad location',
  },
  { pattern: /\bgit\s+(-\S+\s+)*push\b/, reason: 'pushing to a remote needs your explicit action' },
  { pattern: /\bgit\s+(-\S+\s+)*reset\s+(-\S+\s+)*--hard\b/, reason: 'hard reset discards work' },
  { pattern: /\bgit\s+(-\S+\s+)*clean\s+-\w*[fdx]/, reason: 'git clean deletes untracked files' },
  {
    pattern: /\bgit\s+(-\S+\s+)*(checkout|restore)\s+(-\S+\s+)*(--\s+)?\.\s*($|[;&|])/,
    reason: 'discarding all working-tree changes',
  },
  {
    pattern:
      /\bgit\s+(-\S+\s+)*(branch\s+-D|tag\s+-d|update-ref\s+-d|reflog\s+expire|gc\s+--prune)/,
    reason: 'destructive git operation',
  },
  {
    pattern:
      /\b(npm|yarn|pnpm|bun)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b|\bdocker\s+push\b|\bnpm\s+(unpublish|deprecate)\b/,
    reason: 'publishing needs your explicit action',
  },
  {
    pattern:
      /\b(kubectl|helm)\s+(delete|apply|install|upgrade)\b|\bterraform\s+(apply|destroy)\b|\bpulumi\s+(up|destroy)\b|\bserverless\s+deploy\b|\bvercel\s+(--prod|deploy)\b|\bfly\s+deploy\b/,
    reason: 'deployment needs your explicit action',
  },
  {
    pattern: /\b(curl|wget)\b[^\n|;]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
    reason: 'executing a downloaded script',
  },
  {
    pattern:
      /\b(mkfs\.?\w*|fdisk|parted|wipefs)\b|\bdd\s+[^\n]*\bof=\/dev\/|>\s*\/dev\/(sd|nvme|hd)/,
    reason: 'disk-level operation',
  },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'shutting the machine down' },
  {
    pattern: /\bchmod\s+(-\w+\s+)*0?777\s+(\/|~)/,
    reason: 'opening permissions on a broad location',
  },
  {
    pattern: /(^|[;&|]\s*)(printenv|env|export\s+-p|set)\s*($|[;&|>])/,
    reason: 'dumping environment variables (may contain API keys)',
  },
  {
    pattern:
      /\b(cat|less|more|head|tail|type|Get-Content|cp|mv|scp|rsync|base64|xxd|strings)\b[^\n;|&]*(\.env\b(?!\.(example|sample|template))|\.ssh\/|\/etc\/shadow|id_(rsa|ed25519|ecdsa)|\.npmrc|\.pypirc|\.aws\/credentials|\.netrc|\.pem\b|\.p12\b|\.pfx\b)/,
    reason: 'reading or copying secret files',
  },
  {
    pattern: /(^|[\s;&|])(open|nc|ncat|socat)\s+[^\n]*-e\b|\/dev\/tcp\//,
    reason: 'reverse-shell pattern',
  },
];

/** Returns why a shell command is refused in every mode, or null when it is not blocked. */
export function blockedCommandReason(command: string): string | null {
  const flat = command.replace(/\\\r?\n/g, ' ');
  for (const rule of BLOCKED) if (rule.pattern.test(flat)) return rule.reason;
  return null;
}

export class PathPolicyError extends Error {}

/**
 * Validates a project-relative path for writing. Refuses absolute paths, `..`, secret/dependency/
 * build/VCS locations, symlinks, and anything whose real parent is outside the project. The file
 * need not exist yet.
 */
export async function resolveWritable(
  root: string,
  requested: string,
): Promise<{ rel: string; abs: string; exists: boolean }> {
  if (requested === '' || requested.includes('\0'))
    throw new PathPolicyError('The path is empty or invalid.');
  const rel = requested.replace(/\\/g, '/').replace(/^\.\//, '');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel))
    throw new PathPolicyError('Use a path relative to the project, not an absolute path.');
  if (rel.split('/').some((s) => s === '..'))
    throw new PathPolicyError('The path leaves the project folder.');
  if (rel.endsWith('/')) throw new PathPolicyError('The path names a directory, not a file.');
  const reason = excludedPathReason(rel);
  if (reason)
    throw new PathPolicyError(`Writing is blocked here by the exclusion policy (${reason}).`);
  const abs = path.join(root, ...rel.split('/'));

  let exists = false;
  try {
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) throw new PathPolicyError('Symbolic links are not followed.');
    if (!stat.isFile()) throw new PathPolicyError('The path exists but is not a regular file.');
    exists = true;
  } catch (error) {
    if (error instanceof PathPolicyError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // The deepest existing ancestor must really be inside the project (no symlinked directories out).
  let ancestor = path.dirname(abs);
  for (;;) {
    try {
      const real = await fs.realpath(ancestor);
      const relative = path.relative(root, real);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new PathPolicyError('The location resolves outside the project.');
      break;
    } catch (error) {
      if (error instanceof PathPolicyError) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new PathPolicyError('The location could not be verified.');
      ancestor = parent;
    }
  }
  return { rel, abs, exists };
}
