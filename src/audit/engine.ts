import { promises as fs } from 'node:fs';
import type { Runner } from '../platform/exec.js';
import { safeGitArgs, safeGitEnv } from '../project/git.js';
import type { RepoIndex } from '../repo/index.js';
import { languageOf } from '../repo/languages.js';
import { readTextFile } from '../repo/read.js';
import { buildRepoMap } from '../repo/map.js';
import { findSecretTokens } from '../security/redact.js';
import { mapLimit } from '../util/concurrency.js';
import { isRecord } from '../util/json.js';
import { isDocOrExample, isTestFile, isWorkflow, LINE_RULES, type LineRule } from './rules.js';
import {
  CATEGORIES,
  NOT_ASSESSED,
  type AuditCategory,
  type AuditResult,
  type AuditTier,
  type Finding,
  type RawFinding,
  SEVERITIES,
} from './types.js';

export type AuditMode = 'quick' | 'standard' | 'deep' | 'security' | 'deployment' | 'custom';
export const AUDIT_MODES: readonly AuditMode[] = [
  'quick',
  'standard',
  'deep',
  'security',
  'deployment',
  'custom',
];

export interface AuditOptions {
  mode: AuditMode;
  /** Used by `custom`; also narrows any other mode when given. */
  categories?: AuditCategory[];
  maxFileBytes?: number;
  maxFindings?: number;
}

const TIER_RANK: Record<AuditTier, number> = { quick: 0, standard: 1, deep: 2 };

function modeSettings(mode: AuditMode): { tier: AuditTier; categories: AuditCategory[] } {
  switch (mode) {
    case 'quick':
      return { tier: 'quick', categories: [...CATEGORIES] };
    case 'standard':
    case 'custom':
      return { tier: 'standard', categories: [...CATEGORIES] };
    case 'deep':
      return { tier: 'deep', categories: [...CATEGORIES] };
    case 'security':
      return { tier: 'deep', categories: ['security', 'dependencies', 'deployment'] };
    case 'deployment':
      return {
        tier: 'deep',
        categories: ['deployment', 'dependencies', 'testing', 'documentation'],
      };
  }
}

const SCANNED_NAME =
  /^(Dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|\.env\.(example|sample|template))$/i;

function scannable(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return (
    languageOf(path)?.kind === 'code' ||
    isWorkflow(path) ||
    SCANNED_NAME.test(base) ||
    /\.(sh|ya?ml|json|toml|ini|cfg|conf|properties)$/i.test(base)
  );
}

function mask(line: string, match: RegExpExecArray): string {
  const value = match[2] ?? match[0];
  const shown = line.trim().replace(value, `<${value.length} chars hidden>`);
  return shown.length > 160 ? `${shown.slice(0, 160)}…` : shown;
}

function clip(line: string): string {
  const t = line.trim();
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

function lineFinding(rule: LineRule, path: string, lineNo: number, evidence: string): RawFinding {
  return {
    rule: rule.id,
    title: rule.title,
    severity: rule.severity,
    confidence: rule.confidence,
    category: rule.category,
    path,
    lines: String(lineNo),
    evidence,
    explanation: rule.explanation,
    conditions: rule.conditions,
    recommendation: rule.recommendation,
    tests: rule.tests,
    verified: false,
    verification:
      'Pattern match on the source line; the surrounding code was not executed or fully analysed. Review before acting.',
  };
}

function base(
  p: Partial<RawFinding> &
    Pick<
      RawFinding,
      | 'rule'
      | 'title'
      | 'severity'
      | 'category'
      | 'path'
      | 'evidence'
      | 'explanation'
      | 'recommendation'
    >,
): RawFinding {
  return {
    confidence: 'high',
    lines: '',
    conditions: 'Applies as described.',
    tests: 'Re-run the audit and confirm this finding no longer appears.',
    verified: true,
    verification: 'Observed directly in the project files or git metadata.',
    ...p,
  };
}

async function isGitIgnored(
  run: Runner,
  root: string,
  env: NodeJS.ProcessEnv,
  path: string,
): Promise<boolean | null> {
  const r = await run('git', safeGitArgs(['check-ignore', '-q', '--', path]), {
    cwd: root,
    env: safeGitEnv(env),
    timeoutMs: 10_000,
  });
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  return null;
}

async function readSafe(root: string, rel: string, maxBytes = 400_000): Promise<string | null> {
  try {
    return (await readTextFile(root, rel, { maxBytes })).text;
  } catch {
    return null;
  }
}

function findLine(text: string, re: RegExp): number {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i] ?? '')) return i + 1;
  return 0;
}

async function projectRules(
  index: RepoIndex,
  run: Runner,
  env: NodeJS.ProcessEnv,
  tier: AuditTier,
): Promise<RawFinding[]> {
  const out: RawFinding[] = [];
  const { inventory, profile } = index;
  const root = inventory.root;
  const paths = inventory.files.map((f) => f.path);
  const has = (re: RegExp): boolean => paths.some((p) => re.test(p));

  // SEC001: secret-bearing files
  for (const secret of inventory.secretFiles) {
    if (inventory.tracked?.has(secret)) {
      out.push(
        base({
          rule: 'SEC001',
          title: 'Secret-bearing file is tracked by git',
          severity: 'high',
          category: 'security',
          path: secret,
          evidence: `git tracks "${secret}" (contents were not read)`,
          explanation:
            'Files such as .env or private keys that are committed stay in history and are visible to everyone with repository access.',
          recommendation:
            'Remove it from the index (git rm --cached), add it to .gitignore, and rotate any credentials it contained; history may need rewriting.',
          tests: 'A CI check that fails when secret-pattern files are tracked.',
        }),
      );
    } else if (inventory.usedGit) {
      const ignored = await isGitIgnored(run, root, env, secret);
      if (ignored === false) {
        out.push(
          base({
            rule: 'SEC001',
            title: 'Secret-bearing file is not ignored by git',
            severity: 'medium',
            category: 'security',
            path: secret,
            evidence: `"${secret}" exists, is untracked and is not covered by .gitignore (contents were not read)`,
            explanation: 'It could be committed by accident with `git add .`.',
            recommendation: 'Add the file to .gitignore.',
            tests: 'Run `git check-ignore <file>`; it should report the file as ignored.',
          }),
        );
      }
    }
  }

  // SEC002: token-shaped secrets in readable files
  {
    const targets = inventory.files.filter(
      (f) => f.size <= 400_000 && languageOf(f.path)?.kind !== 'docs',
    );
    const hits: RawFinding[] = [];
    await mapLimit(targets, 16, async (file) => {
      const text = await readSafe(root, file.path);
      if (text === null) return;
      const found = findSecretTokens(text);
      if (found.length === 0) return;
      const first = found[0]!;
      const lineNo = text.slice(0, first.index).split('\n').length;
      const key = first.kind === 'private-key';
      hits.push(
        base({
          rule: 'SEC002',
          title: key
            ? 'Private key material in a source file'
            : 'Token-shaped secret in a source file',
          severity: isTestFile(file.path) || isDocOrExample(file.path) ? 'low' : 'high',
          confidence:
            isTestFile(file.path) || isDocOrExample(file.path) ? 'low' : key ? 'high' : 'medium',
          category: 'security',
          path: file.path,
          lines: String(lineNo),
          evidence: `${first.preview}${found.length > 1 ? ` (+${found.length - 1} more in this file)` : ''}; value not shown`,
          explanation:
            'A credential in the repository is exposed to everyone with access to the code and its history.',
          conditions:
            'The value is a live credential, not a revoked, fake or documentation example.',
          recommendation:
            'Revoke and rotate it, load it from the environment or a secret manager, and purge it from history if it was ever pushed.',
          tests: 'A secret-scanning step in CI (for example gitleaks or GitHub secret scanning).',
          verified: false,
          verification:
            'The text matches a known credential format. Whether it is a working credential was not tested (and never will be by this tool).',
        }),
      );
    });
    out.push(...hits.sort((a, b) => a.path.localeCompare(b.path)));
  }

  // Dependencies
  const nodeLocks = paths.filter((p) =>
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|npm-shrinkwrap\.json)$/.test(
      p,
    ),
  );
  for (const manifest of profile.manifests.filter((m) => /(^|\/)package\.json$/.test(m))) {
    const dir = manifest.includes('/') ? manifest.slice(0, manifest.lastIndexOf('/') + 1) : '';
    const text = await readSafe(root, manifest);
    if (text === null) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(json)) continue;
    const deps = {
      ...(isRecord(json['dependencies']) ? json['dependencies'] : {}),
      ...(isRecord(json['devDependencies']) ? json['devDependencies'] : {}),
    };
    const count = Object.keys(deps).length;
    const sameDirLocks = nodeLocks.filter(
      (l) => l.startsWith(dir) && !l.slice(dir.length).includes('/'),
    );
    if (count > 0 && nodeLocks.length === 0) {
      out.push(
        base({
          rule: 'DEP001',
          title: 'No lockfile for Node dependencies',
          severity: 'low',
          category: 'dependencies',
          path: manifest,
          evidence: `${count} dependencies declared; no package-lock.json, yarn.lock or pnpm-lock.yaml found`,
          explanation:
            'Without a lockfile, installs can resolve different versions over time, so builds are not reproducible and a compromised release is picked up silently.',
          recommendation:
            'Commit the lockfile your package manager generates and install with `npm ci` (or the equivalent) in CI.',
          tests: 'CI that installs from the lockfile and fails when it is out of date.',
        }),
      );
    }
    if (sameDirLocks.length > 1) {
      out.push(
        base({
          rule: 'DEP002',
          title: 'Multiple Node lockfiles',
          severity: 'low',
          category: 'dependencies',
          path: manifest,
          evidence: `Found ${sameDirLocks.join(', ')}`,
          explanation:
            'Different package managers can resolve different versions, so teammates and CI may not install the same tree.',
          recommendation: 'Pick one package manager and delete the other lockfiles.',
        }),
      );
    }
    const loose = Object.entries(deps).filter(
      ([, v]) => typeof v === 'string' && /^(\*|latest|x|)$/.test(v.trim()),
    );
    if (loose.length > 0) {
      out.push(
        base({
          rule: 'DEP003',
          title: 'Dependencies with unpinned versions ("*" or "latest")',
          severity: 'medium',
          category: 'dependencies',
          path: manifest,
          lines: String(
            findLine(text, new RegExp(`"${loose[0]![0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`)),
          ),
          evidence: `${loose
            .map(([k, v]) => `${k}: "${String(v)}"`)
            .slice(0, 5)
            .join(', ')}${loose.length > 5 ? ', …' : ''}`,
          explanation:
            'Any new release, including a malicious or breaking one, is installed automatically.',
          recommendation: 'Use a version range (for example ^1.2.3) and rely on the lockfile.',
        }),
      );
    }
  }
  const pyReq = paths.filter((p) => /(^|\/)requirements[\w.-]*\.txt$/.test(p));
  for (const req of pyReq) {
    const text = await readSafe(root, req);
    if (text === null) continue;
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('-'));
    const unpinned = lines.filter((l) => /^[A-Za-z0-9._-]+(\[[^\]]+\])?\s*$/.test(l));
    if (lines.length >= 3 && unpinned.length > 0) {
      out.push(
        base({
          rule: 'DEP004',
          title: 'Python requirements without pinned versions',
          severity: 'low',
          category: 'dependencies',
          path: req,
          evidence: `${unpinned.length} of ${lines.length} entries have no version constraint (${unpinned.slice(0, 4).join(', ')})`,
          explanation:
            'Unpinned packages install whatever is newest, which makes builds irreproducible.',
          recommendation: 'Pin versions (==) or use a lock tool such as pip-tools, Poetry or uv.',
          confidence: 'high',
        }),
      );
    }
  }

  // Containers and CI
  for (const file of paths.filter((p) => /(^|\/)Dockerfile[\w.-]*$/.test(p))) {
    const text = await readSafe(root, file);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    const froms = lines.map((l, i) => ({ l, i: i + 1 })).filter((x) => /^\s*FROM\s/i.test(x.l));
    for (const f of froms) {
      const image = f.l.replace(/^\s*FROM\s+(--platform=\S+\s+)?/i, '').split(/\s+/)[0] ?? '';
      if (image.toLowerCase() === 'scratch' || /^\$/.test(image) || image.includes('@sha256:'))
        continue;
      if (!image.includes(':') || /:latest$/.test(image)) {
        out.push(
          base({
            rule: 'DEP101',
            title: 'Docker base image is not pinned',
            severity: 'low',
            category: 'deployment',
            path: file,
            lines: String(f.i),
            evidence: clip(f.l),
            explanation:
              'An untagged or :latest image changes without notice, which breaks reproducibility and can pull in unreviewed changes.',
            recommendation: 'Pin a specific version tag, ideally with a digest.',
          }),
        );
      }
    }
    const lastFrom = froms.at(-1)?.i ?? 0;
    const user = lines.slice(lastFrom).some((l) => /^\s*USER\s+(?!root\b|0\b)\S+/i.test(l));
    if (froms.length > 0 && !user) {
      out.push(
        base({
          rule: 'DEP102',
          title: 'Container runs as root',
          severity: 'low',
          category: 'deployment',
          path: file,
          evidence: 'No non-root USER instruction in the final build stage',
          explanation:
            'A compromise of the application gives root inside the container, which makes escapes and tampering easier.',
          recommendation: 'Create an unprivileged user and add a USER instruction.',
          confidence: 'medium',
          conditions: 'The image is used for a long-running service (not a short build helper).',
        }),
      );
    }
    lines.forEach((l, i) => {
      if (
        /^\s*(ENV|ARG)\s+\w*(PASSWORD|SECRET|TOKEN|API_?KEY)\w*[= ]\s*(?!\$)[^\s$]{6,}/i.test(l)
      ) {
        out.push(
          base({
            rule: 'DEP103',
            title: 'Secret-like value baked into an image layer',
            severity: 'high',
            category: 'deployment',
            path: file,
            lines: String(i + 1),
            evidence: clip(l.replace(/([= ])[^\s$]{6,}\s*$/, '$1<hidden>')),
            explanation:
              'ENV and ARG values are stored in the image and visible to anyone who can pull it.',
            recommendation:
              'Pass secrets at run time (environment, orchestrator secrets) or use BuildKit secret mounts.',
            verified: false,
            confidence: 'medium',
            verification:
              'Pattern match on the instruction; whether the value is a real secret was not determined.',
          }),
        );
      }
    });
  }
  for (const file of paths.filter((p) => /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/.test(p))) {
    const text = await readSafe(root, file);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((l, i) => {
      if (/^\s*privileged:\s*true\b/.test(l))
        out.push(
          base({
            rule: 'DEP105',
            title: 'Privileged container',
            severity: 'medium',
            category: 'deployment',
            path: file,
            lines: String(i + 1),
            evidence: clip(l),
            explanation: 'A privileged container has nearly the same access as the host.',
            recommendation: 'Drop privileged mode and grant only the specific capabilities needed.',
          }),
        );
      if (/^\s*-\s*["']?(?:0\.0\.0\.0:)?(5432|3306|27017|6379|9200|11211):\1["']?\s*$/.test(l))
        out.push(
          base({
            rule: 'DEP106',
            title: 'Database port published on all interfaces',
            severity: 'medium',
            category: 'deployment',
            path: file,
            lines: String(i + 1),
            evidence: clip(l),
            explanation:
              'Publishing a datastore port makes it reachable from the network, often with default credentials.',
            recommendation:
              'Bind to 127.0.0.1 (e.g. "127.0.0.1:5432:5432") or keep it on the internal compose network.',
            confidence: 'medium',
            conditions: 'The host is reachable from untrusted networks.',
          }),
        );
    });
  }
  for (const file of paths.filter(isWorkflow)) {
    const text = await readSafe(root, file);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    if (
      /^\s*pull_request_target\b|^\s*-?\s*pull_request_target\b|on:.*pull_request_target/m.test(
        text,
      ) &&
      /github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref/.test(text) &&
      /actions\/checkout/.test(text)
    ) {
      out.push(
        base({
          rule: 'DEP107',
          title: 'pull_request_target workflow checks out pull-request code',
          severity: 'high',
          category: 'deployment',
          path: file,
          lines: String(findLine(text, /pull_request_target/)),
          evidence:
            'Workflow triggers on pull_request_target and references the PR head in a checkout',
          explanation:
            'That trigger runs with repository secrets and write permissions, so running code from a fork lets an outsider execute code with those privileges.',
          recommendation:
            'Use pull_request for untrusted code, or split into an unprivileged build and a separate privileged step that never runs PR code.',
          verified: false,
          confidence: 'medium',
          verification:
            'Pattern match on the workflow text; the full workflow logic was not evaluated.',
        }),
      );
    }
    lines.forEach((l, i) => {
      if (/^\s*-?\s*uses:\s*[\w.-]+\/[\w./-]+@(main|master|latest)\s*$/.test(l))
        out.push(
          base({
            rule: 'DEP108',
            title: 'GitHub Action pinned to a moving branch',
            severity: 'low',
            category: 'deployment',
            path: file,
            lines: String(i + 1),
            evidence: clip(l),
            explanation:
              'The action can change at any time, including through a compromise of its repository.',
            recommendation: 'Pin to a release tag or, better, a full commit SHA.',
          }),
        );
      if (
        /^\s*-?\s*run:.*\$\{\{\s*github\.(event\.(issue|pull_request|comment|review|head_commit|pages)[\w.]*\.(title|body|message|name|label|ref)|head_ref)\s*\}\}/.test(
          l,
        )
      )
        out.push(
          base({
            rule: 'DEP109',
            title: 'Untrusted GitHub context expanded inside a run script',
            severity: 'medium',
            category: 'deployment',
            path: file,
            lines: String(i + 1),
            evidence: clip(l),
            explanation:
              'Titles, bodies and branch names are attacker-controlled; interpolating them into a shell script allows command injection.',
            recommendation:
              'Pass the value through an environment variable and reference it as "$VAR" in the script.',
            confidence: 'medium',
            verified: false,
            verification: 'Pattern match on the workflow line.',
          }),
        );
    });
  }
  if (profile.ci.length === 0 && tier !== 'quick') {
    out.push(
      base({
        rule: 'DEP110',
        title: 'No continuous integration configuration found',
        severity: 'info',
        category: 'deployment',
        path: '',
        evidence: 'No GitHub Actions, GitLab CI, CircleCI, Azure Pipelines or Jenkins files',
        explanation:
          'Without CI, tests and checks depend on each developer remembering to run them.',
        recommendation: 'Add a workflow that installs from the lockfile, builds, lints and tests.',
        conditions: 'CI may exist outside the repository.',
        confidence: 'medium',
      }),
    );
  }

  // Testing
  const { map, association } = buildRepoMap(index);
  const hasSource = association.sourceFiles.length >= 3;
  if (hasSource && association.testFiles.length === 0) {
    out.push(
      base({
        rule: 'TST001',
        title: 'No test files found',
        severity: 'medium',
        category: 'testing',
        path: '',
        evidence: `${association.sourceFiles.length} source files and no files matching common test naming conventions`,
        explanation: 'Without tests, regressions are only found by users.',
        recommendation: 'Add tests for the most critical behaviour first, and run them in CI.',
        conditions: 'Tests may exist outside the repository or use an unusual layout.',
        confidence: 'medium',
      }),
    );
  } else if (hasSource && !profile.commands.test) {
    out.push(
      base({
        rule: 'TST002',
        title: 'Test files exist but no test command was detected',
        severity: 'low',
        category: 'testing',
        path: '',
        evidence: `${association.testFiles.length} test files; no test script or runner configuration recognised`,
        explanation: 'A documented, runnable test command makes it likely tests actually get run.',
        recommendation: 'Add a `test` script (or Makefile target) and document it in the README.',
        confidence: 'medium',
      }),
    );
  }
  void map;

  // Docs and hygiene
  if (!has(/^readme(\.[a-z]+)?$/i))
    out.push(
      base({
        rule: 'DOC001',
        title: 'No README at the project root',
        severity: 'low',
        category: 'documentation',
        path: '',
        evidence: 'No README file found',
        explanation: 'New contributors and users have no entry point.',
        recommendation: 'Add a README with purpose, setup, usage and test instructions.',
      }),
    );
  if (!has(/^(licen[sc]e|copying)(\.[a-z]+)?$/i) && paths.length > 5)
    out.push(
      base({
        rule: 'DOC002',
        title: 'No LICENSE file',
        severity: 'info',
        category: 'documentation',
        path: '',
        evidence: 'No LICENSE file at the project root',
        explanation:
          'Without a license others have no legal permission to use or contribute to the code.',
        recommendation: 'Add the license you intend (for example Apache-2.0 or MIT).',
        conditions: 'Private projects may not need one.',
      }),
    );
  if (
    inventory.usedGit &&
    !(await fs.stat(`${root}/.gitignore`).then(
      () => true,
      () => false,
    )) &&
    paths.length > 5
  )
    out.push(
      base({
        rule: 'DOC003',
        title: 'No .gitignore',
        severity: 'low',
        category: 'maintainability',
        path: '',
        evidence: 'git repository without a root .gitignore',
        explanation: 'Build output, dependencies and secret files can be committed by accident.',
        recommendation: 'Add a .gitignore for your language and tooling, including .env.',
      }),
    );

  // Maintainability and cross-platform
  const large = inventory.files.filter(
    (f) => languageOf(f.path)?.kind === 'code' && f.size > 150_000 && !isTestFile(f.path),
  );
  for (const f of large.slice(0, 5)) {
    out.push(
      base({
        rule: 'MNT001',
        title: 'Very large source file',
        severity: 'info',
        category: 'maintainability',
        path: f.path,
        evidence: `${Math.round(f.size / 1024)} KB`,
        explanation: 'Large files are hard to review and test.',
        recommendation: 'Consider splitting by responsibility.',
        confidence: 'low',
        conditions: 'Generated or vendored code is fine.',
      }),
    );
  }
  return out;
}

function gate(rule: LineRule, tier: AuditTier, categories: ReadonlySet<AuditCategory>): boolean {
  return TIER_RANK[rule.tier] <= TIER_RANK[tier] && categories.has(rule.category);
}

/**
 * Read-only static audit. It never modifies files, never runs project code, and never contacts the
 * network. Findings are pattern-based and carry their confidence and how they were verified.
 */
export async function runAudit(
  index: RepoIndex,
  run: Runner,
  env: NodeJS.ProcessEnv,
  options: AuditOptions,
): Promise<AuditResult> {
  const started = Date.now();
  const settings = modeSettings(options.mode);
  const categories = new Set<AuditCategory>(
    options.categories && options.categories.length > 0 ? options.categories : settings.categories,
  );
  const maxBytes = options.maxFileBytes ?? 400_000;
  const { inventory } = index;

  const raw: RawFinding[] = [];
  const projectFindings = await projectRules(index, run, env, settings.tier);
  raw.push(...projectFindings.filter((f) => categories.has(f.category)));

  const rules = LINE_RULES.filter((r) => gate(r, settings.tier, categories));
  const targets = inventory.files.filter((f) => scannable(f.path) && f.size <= maxBytes);
  let skipped = inventory.files.length - targets.length;
  let suppressed = 0;
  await mapLimit(targets, 16, async (file) => {
    const text = await readSafe(inventory.root, file.path, maxBytes);
    if (text === null) {
      skipped++;
      return;
    }
    const lines = text.split(/\r?\n/);
    const isTest = isTestFile(file.path);
    const isDoc = isDocOrExample(file.path);
    const applicable = rules.filter(
      (r) => r.appliesTo(file.path) && !(r.skipTests !== false && (isTest || isDoc)),
    );
    if (applicable.length === 0) return;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.length > 2000 || line.trim() === '') continue;
      if (/mia-audit-ignore/.test(line) || /mia-audit-ignore-next-line/.test(lines[i - 1] ?? '')) {
        suppressed++;
        continue;
      }
      for (const rule of applicable) {
        const m = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')).exec(line);
        if (!m) continue;
        if (rule.accept && !rule.accept(line, m)) continue;
        raw.push(lineFinding(rule, file.path, i + 1, rule.maskValue ? mask(line, m) : clip(line)));
      }
    }
    if (
      categories.has('crossplatform') &&
      /\.sh$/.test(file.path) &&
      /\r\n/.test(text.slice(0, 4000))
    )
      raw.push(
        base({
          rule: 'XPL002',
          title: 'Shell script has Windows (CRLF) line endings',
          severity: 'low',
          category: 'crossplatform',
          path: file.path,
          evidence: 'CRLF found in the first 4 KB',
          explanation:
            'Unix shells fail on carriage returns ("bad interpreter", "command not found").',
          recommendation: 'Convert to LF and add a .gitattributes rule (`*.sh text eol=lf`).',
        }),
      );
  });

  // Order: severity, confidence, then location; cap and number.
  const sevRank = new Map(SEVERITIES.map((s, i) => [s, i]));
  const confRank = { high: 0, medium: 1, low: 2 } as const;
  raw.sort(
    (a, b) =>
      sevRank.get(a.severity)! - sevRank.get(b.severity)! ||
      confRank[a.confidence] - confRank[b.confidence] ||
      a.path.localeCompare(b.path) ||
      (Number(a.lines.split('-')[0]) || 0) - (Number(b.lines.split('-')[0]) || 0),
  );
  const maxFindings = options.maxFindings ?? 500;
  const truncated = raw.length > maxFindings;
  const counters = new Map<string, number>();
  const findings: Finding[] = raw.slice(0, maxFindings).map((f) => {
    const n = (counters.get(f.rule) ?? 0) + 1;
    counters.set(f.rule, n);
    return { ...f, id: `${f.rule}-${n}` };
  });

  return {
    mode: options.mode,
    findings,
    stats: {
      filesScanned:
        targets.length - Math.max(0, skipped - (inventory.files.length - targets.length)),
      filesSkipped: skipped,
      rulesRun: rules.length + 14,
      truncated: truncated || inventory.truncated,
      suppressed,
      durationMs: Date.now() - started,
    },
    categoriesChecked: CATEGORIES.filter((c) => categories.has(c)),
    notAssessed: [...NOT_ASSESSED],
    project: inventory.root,
  };
}
