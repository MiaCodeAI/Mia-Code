import { languageOf } from '../repo/languages.js';
import { isTestFile } from '../repo/tests-map.js';
import type { AuditCategory, AuditTier, Confidence, Severity } from './types.js';

export interface LineRule {
  id: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  category: AuditCategory;
  tier: AuditTier;
  pattern: RegExp;
  /** Which files the rule inspects. */
  appliesTo: (path: string) => boolean;
  /** Skip test files and documentation (default true). */
  skipTests?: boolean;
  /** Extra check on the matching line; return false to ignore a false positive. */
  accept?: (line: string, match: RegExpExecArray) => boolean;
  /** Replace the matched value in the shown evidence so it is never printed. */
  maskValue?: boolean;
  explanation: string;
  conditions: string;
  recommendation: string;
  tests: string;
}

const lang =
  (...names: string[]) =>
  (path: string): boolean => {
    const info = languageOf(path);
    return info !== undefined && names.includes(info.name);
  };
const anyCode = (path: string): boolean => languageOf(path)?.kind === 'code';
const JS = lang('JavaScript', 'TypeScript', 'Vue', 'Svelte');
const PY = lang('Python');
const ANY_SCRIPTING = lang(
  'JavaScript',
  'TypeScript',
  'Python',
  'PHP',
  'Ruby',
  'Shell',
  'Go',
  'Java',
  'Kotlin',
  'C#',
  'Rust',
);

export function isDocOrExample(path: string): boolean {
  const kind = languageOf(path)?.kind;
  return (
    kind === 'docs' ||
    /(^|\/)(docs?|examples?|samples?|fixtures?)\//i.test(path) ||
    /\.(md|rst|txt)$/i.test(path)
  );
}

export function isWorkflow(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

const PLACEHOLDER =
  /(change|example|your|xxx|todo|<|>|\$\{|\{\{|process\.env|getenv|environ|dummy|sample|placeholder|\*\*\*|redacted|secret_key_here|password123|test)/i;

export const LINE_RULES: LineRule[] = [
  {
    id: 'SEC003',
    title: 'TLS certificate verification disabled',
    severity: 'medium',
    confidence: 'high',
    category: 'security',
    tier: 'quick',
    pattern:
      // mia-audit-ignore-next-line
      /(?:verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|InsecureSkipVerify\s*:\s*true|_create_unverified_context|CURLOPT_SSL_VERIFYPEER['"]?\s*,\s*(?:false|0)|\bcurl\b[^\n|;]*\s(?:-k|--insecure)\b)/,
    appliesTo: (p) => anyCode(p) || isWorkflow(p) || /Dockerfile/i.test(p),
    explanation:
      'Disabling certificate verification lets anyone on the network path impersonate the server and read or alter traffic.',
    conditions: 'The code path runs against a real network (not only a local test double).',
    recommendation:
      'Remove the override and trust the proper CA (for example via a CA bundle setting) instead.',
    tests:
      'A test that connects to a server with an invalid certificate and expects the request to fail.',
  },
  {
    id: 'SEC005',
    title: 'Shell command execution that may include untrusted input',
    severity: 'medium',
    confidence: 'medium',
    category: 'security',
    tier: 'standard',
    pattern:
      /(?:shell\s*=\s*True|\bos\.(?:system|popen)\s*\(|\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]\s*\+)|\b(?:shell_exec|passthru)\s*\()/,
    appliesTo: (p) => ANY_SCRIPTING(p),
    explanation:
      'Building a shell command from variables allows command injection if any part comes from a user, file or network.',
    conditions:
      'Part of the command string is attacker-influenced. Constant commands are not exploitable.',
    recommendation:
      'Pass an argument list without a shell (subprocess with a list, execFile/spawn with arguments) and validate inputs.',
    tests:
      'A test supplying inputs containing shell metacharacters (; | $() backticks) and asserting they are not interpreted.',
  },
  {
    id: 'SEC006',
    title: 'SQL query built by string interpolation or concatenation',
    severity: 'medium',
    confidence: 'low',
    category: 'security',
    tier: 'standard',
    pattern:
      /(?:\.execute\(\s*f['"]|\.execute\(\s*['"][^'"]*['"]\s*(?:%|\+|\.format\()|\.(?:query|execute|raw)\(\s*`[^`]*\$\{|\.(?:query|execute|raw)\(\s*['"][^'"]*['"]\s*\+)/,
    appliesTo: (p) => PY(p) || JS(p),
    explanation:
      'Interpolating values into SQL text can allow SQL injection when any value is user-controlled.',
    conditions:
      'The interpolated values are not constants or already validated. Parameterized queries are not affected.',
    recommendation: 'Use parameterized queries (placeholders) or the ORM query builder.',
    tests:
      "A test passing a value such as `x' OR '1'='1` and asserting the query returns no extra rows.",
  },
  {
    id: 'SEC008',
    title: 'Debug mode enabled in application code',
    severity: 'medium',
    confidence: 'medium',
    category: 'security',
    tier: 'standard',
    pattern: /(?:\.run\([^)]*\bdebug\s*=\s*True|^\s*DEBUG\s*=\s*True\b)/,
    appliesTo: PY,
    explanation:
      'Debug mode can expose stack traces, source and, for some frameworks, an interactive console to remote users.',
    conditions: 'The setting reaches production. A development-only settings file is lower risk.',
    recommendation:
      'Read the flag from the environment and default it to off; never enable it in production settings.',
    tests:
      'A test (or deployment check) asserting debug is False under the production configuration.',
  },
  {
    id: 'SEC009',
    title: 'Wildcard CORS policy',
    severity: 'low',
    confidence: 'medium',
    category: 'security',
    tier: 'standard',
    pattern:
      /(?:Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]|\borigin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]|CORS_ALLOW_ALL_ORIGINS\s*=\s*True)/,
    appliesTo: anyCode,
    explanation:
      "Allowing every origin lets any website call the API from a visitor's browser, which matters if the API uses cookies or ambient credentials.",
    conditions:
      'The API serves authenticated or private data. Public read-only APIs are not affected.',
    recommendation: 'List the specific origins that need access.',
    tests:
      'A request test with a foreign Origin header asserting it is not echoed back or allowed.',
  },
  {
    id: 'SEC012',
    title: 'Possible hard-coded credential',
    severity: 'medium',
    confidence: 'low',
    category: 'security',
    tier: 'standard',
    pattern:
      /\b(?:password|passwd|pwd|secret|api_?key|token|auth_?key)\w*\s*[:=]\s*(['"])([^'"\s]{8,})\1/i,
    appliesTo: anyCode,
    maskValue: true,
    accept: (line, match) =>
      !PLACEHOLDER.test(match[2] ?? '') && !/(?:_env|Env|ENV)\b\s*[:=]/.test(line),
    explanation:
      'A literal secret in source ends up in version control history and in every copy of the code.',
    conditions: 'The value is a real credential rather than a placeholder or test value.',
    recommendation:
      'Load the value from the environment or a secret manager, rotate it if it was ever real, and keep it out of Git.',
    tests: 'A test (or CI secret scan) that fails when credential-like literals appear in source.',
  },
  {
    id: 'ERR001',
    title: 'Empty exception handler swallows errors',
    severity: 'low',
    confidence: 'medium',
    category: 'errors',
    tier: 'standard',
    pattern: /(?:catch\s*(?:\([^)]*\))?\s*\{\s*\}|\bexcept\b[^:\n]*:\s*pass\b)/,
    appliesTo: (p) => JS(p) || PY(p) || lang('Java', 'Kotlin', 'C#', 'PHP')(p),
    explanation: 'Silently ignoring errors hides failures and makes bugs very hard to diagnose.',
    conditions: 'The ignored error can occur and matters to the caller.',
    recommendation:
      'Handle the specific error, or at least log it; if ignoring is intentional, add a comment saying why.',
    tests:
      'A test that triggers the failing operation and asserts the error is handled or reported.',
  },
  {
    id: 'ERR002',
    title: 'Bare except catches every exception',
    severity: 'low',
    confidence: 'high',
    category: 'errors',
    tier: 'standard',
    pattern: /^\s*except\s*:/,
    appliesTo: PY,
    explanation:
      'A bare `except:` also catches KeyboardInterrupt and SystemExit and hides programming errors.',
    conditions: 'Always true where it appears.',
    recommendation: 'Catch specific exception types (or `Exception` at the very least).',
    tests: 'A test asserting that unexpected exceptions propagate or are logged.',
  },
  {
    id: 'SEC004',
    title: 'Dynamic code evaluation',
    severity: 'low',
    confidence: 'low',
    category: 'security',
    tier: 'deep',
    pattern:
      /(?:(?<![.\w$])eval\s*\(|\bnew Function\s*\(|(?<![.\w])exec\s*\(\s*(?!['"]\s*\))[^)]*\))/,
    appliesTo: (p) => JS(p) || PY(p) || lang('PHP', 'Ruby')(p),
    accept: (line, match) => !(match[0].startsWith('exec') && !PY_LINE_OK(line)),
    explanation:
      'Evaluating strings as code is dangerous if any part of the string is attacker-influenced.',
    conditions:
      'The evaluated text is not a constant. Needs manual review; this is a pattern match only.',
    recommendation:
      'Replace with a parser or a dispatch table; if unavoidable, restrict inputs strictly.',
    tests: 'A test with hostile input asserting it is rejected rather than executed.',
  },
  {
    id: 'SEC007',
    title: 'Weak hash algorithm (MD5 or SHA-1)',
    severity: 'low',
    confidence: 'medium',
    category: 'security',
    tier: 'deep',
    pattern: /(?:hashlib\.(?:md5|sha1)\(|createHash\(\s*['"](?:md5|sha1)['"]|\b(?:md5|sha1)\s*\()/i,
    appliesTo: anyCode,
    explanation: 'MD5 and SHA-1 are broken for security purposes (collisions, fast brute force).',
    conditions:
      'Only a problem if used for passwords, signatures or integrity against an attacker; fine for non-security checksums.',
    recommendation: 'Use SHA-256 or better for integrity, and bcrypt/scrypt/argon2 for passwords.',
    tests: 'A test asserting password hashes use a slow, salted algorithm.',
  },
  {
    id: 'SEC011',
    title: 'World-writable permissions',
    severity: 'low',
    confidence: 'medium',
    category: 'security',
    tier: 'deep',
    pattern: /(?:chmod\s+(?:-R\s+)?0?777\b|\b0o777\b|chmod\([^)]*0?777)/,
    appliesTo: (p) => anyCode(p) || /Dockerfile/i.test(p),
    explanation: 'Mode 777 lets any local user modify the file or directory.',
    conditions: 'The path is on a multi-user system or shared volume.',
    recommendation:
      'Grant the minimum permissions (for example 755 for directories, 644 for files, 600 for secrets).',
    tests: 'A test asserting the created file mode.',
  },
  {
    id: 'XPL001',
    title: 'Hard-coded user-specific absolute path',
    severity: 'low',
    confidence: 'medium',
    category: 'crossplatform',
    tier: 'deep',
    pattern:
      /(?:[A-Za-z]:\\{1,2}Users\\{1,2}[\w.-]+|\/Users\/[A-Za-z][\w.-]*\/|\/home\/(?!runner\/|user\/|vscode\/|node\/|app\/|ubuntu\/|circleci\/)[a-z][\w.-]*\/)/,
    appliesTo: anyCode,
    explanation:
      "Absolute paths tied to one person's machine fail on every other computer and operating system.",
    conditions: 'The path is used at runtime rather than appearing in a comment or example.',
    recommendation:
      'Use relative paths, configuration, or platform APIs (home directory, temp directory).',
    tests: 'Run the tests on Windows, Linux and macOS in CI.',
  },
  {
    id: 'DEP104',
    title: 'Remote script piped into a shell',
    severity: 'medium',
    confidence: 'medium',
    category: 'deployment',
    tier: 'standard',
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
    appliesTo: (p) => isWorkflow(p) || /Dockerfile/i.test(p) || lang('Shell')(p),
    skipTests: false,
    explanation:
      'Executing whatever a URL returns means a compromised or hijacked server can run code in your build or machine.',
    conditions: 'The URL is not under your control and no checksum or signature is verified.',
    recommendation:
      'Download to a file, verify a pinned checksum or signature, then run it; prefer distro or package-manager installs.',
    tests: 'A CI check that the build uses only pinned, verified downloads.',
  },
];

function PY_LINE_OK(line: string): boolean {
  // `exec(` is only interesting in Python source; JS `exec` is a method call and is excluded by the lookbehind.
  return /^\s*(?:[\w.]+\s*=\s*)?exec\(/.test(line);
}

export { isTestFile };
