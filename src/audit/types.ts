export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'high' | 'medium' | 'low';
export type AuditCategory =
  | 'security'
  | 'dependencies'
  | 'deployment'
  | 'testing'
  | 'errors'
  | 'maintainability'
  | 'documentation'
  | 'crossplatform';

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const CATEGORIES: readonly AuditCategory[] = [
  'security',
  'dependencies',
  'deployment',
  'testing',
  'errors',
  'maintainability',
  'documentation',
  'crossplatform',
];

export type AuditTier = 'quick' | 'standard' | 'deep';

export interface Finding {
  /** Stable within one report, for example SEC003-2. */
  id: string;
  rule: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  category: AuditCategory;
  path: string;
  /** "12" or "12-14"; empty for whole-file or project-level findings. */
  lines: string;
  /** What was actually observed. Secret values are never included. */
  evidence: string;
  explanation: string;
  conditions: string;
  recommendation: string;
  /** Tests that would show the issue is fixed or absent. */
  tests: string;
  /** True only when the finding is an observed fact (for example "file X is tracked by git"). */
  verified: boolean;
  verification: string;
}

export type RawFinding = Omit<Finding, 'id'>;

export interface AuditStats {
  filesScanned: number;
  filesSkipped: number;
  rulesRun: number;
  truncated: boolean;
  suppressed: number;
  durationMs: number;
}

export interface AuditResult {
  mode: string;
  findings: Finding[];
  stats: AuditStats;
  categoriesChecked: AuditCategory[];
  /** Areas this static audit cannot judge. */
  notAssessed: string[];
  project: string;
}

export const NOT_ASSESSED: readonly string[] = [
  'Functional correctness and logic bugs',
  'Authentication and authorization design (only dependency hints and risky patterns are checked)',
  'Data integrity and database transaction safety',
  'Performance, memory and resource management',
  'Concurrency problems',
  'Architecture and maintainability beyond file size and TODO counts',
  'Test quality (only test presence and naming are checked)',
  'Logging and observability',
  'Vulnerabilities inside dependency versions (no vulnerability database is consulted)',
];
