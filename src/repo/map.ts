import type { ProjectProfile } from './detect.js';
import { buildImportGraph, type ImportGraph } from './graph.js';
import type { RepoIndex } from './index.js';
import { associateTests, type TestAssociation } from './tests-map.js';
import type { RouteEntry } from './types.js';

export interface DirectorySummary {
  path: string;
  files: number;
  purpose?: string;
}

export interface KeyModule {
  path: string;
  importedBy: number;
  symbols: number;
}

export interface RepoMap {
  name: string;
  fileCount: number;
  directories: DirectorySummary[];
  profile: ProjectProfile;
  keyModules: KeyModule[];
  externalPackages: { name: string; files: number }[];
  routes: RouteEntry[];
  envVarsUsed: { name: string; files: number; declared: boolean }[];
  tests: {
    testFiles: number;
    sourceFiles: number;
    untestedSample: string[];
    untestedCount: number;
  };
  secretFilesPresent: number;
  notes: string[];
}

const PURPOSES: Record<string, string> = {
  src: 'source code',
  lib: 'library code',
  app: 'application code',
  apps: 'applications',
  packages: 'workspace packages',
  tests: 'tests',
  test: 'tests',
  __tests__: 'tests',
  spec: 'tests',
  e2e: 'end-to-end tests',
  docs: 'documentation',
  doc: 'documentation',
  scripts: 'helper scripts',
  bin: 'executables',
  cmd: 'Go commands',
  internal: 'private Go packages',
  pkg: 'Go packages',
  public: 'static assets',
  static: 'static assets',
  assets: 'assets',
  templates: 'templates',
  views: 'views',
  migrations: 'database migrations',
  config: 'configuration',
  configs: 'configuration',
  '.github': 'GitHub configuration and workflows',
  examples: 'examples',
  models: 'data models',
  routes: 'routes',
  controllers: 'controllers',
  services: 'services',
  components: 'UI components',
  pages: 'pages',
  api: 'API code',
  db: 'database code',
};

function topDirectories(paths: readonly string[]): DirectorySummary[] {
  const counts = new Map<string, number>();
  let rootFiles = 0;
  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash === -1) rootFiles++;
    else counts.set(p.slice(0, slash), (counts.get(p.slice(0, slash)) ?? 0) + 1);
  }
  const dirs: DirectorySummary[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, files]) => {
      const summary: DirectorySummary = { path: `${name}/`, files };
      const purpose = PURPOSES[name.toLowerCase()];
      if (purpose) summary.purpose = purpose;
      return summary;
    });
  if (rootFiles > 0) dirs.unshift({ path: './', files: rootFiles, purpose: 'project root files' });
  return dirs;
}

/** Builds the repository map from the index. Cheap enough to rebuild on demand. */
export function buildRepoMap(index: RepoIndex): {
  map: RepoMap;
  graph: ImportGraph;
  association: TestAssociation;
} {
  const { inventory, profile } = index;
  const paths = inventory.files.map((f) => f.path);
  const graph = buildImportGraph(inventory, index.analyses);
  const association = associateTests(paths);
  const notes: string[] = [];

  const keyModules: KeyModule[] = [...graph.importedBy.entries()]
    .filter(([p]) => !association.testFiles.includes(p))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([path, importedBy]) => ({
      path,
      importedBy,
      symbols: index.analyses.get(path)?.symbols.length ?? 0,
    }));

  const routes: RouteEntry[] = [];
  const envCounts = new Map<string, number>();
  for (const analysis of index.analyses.values()) {
    routes.push(...analysis.routes);
    for (const name of analysis.envVars) envCounts.set(name, (envCounts.get(name) ?? 0) + 1);
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

  const declared = new Set(profile.declaredEnvVars);
  const envVarsUsed = [...envCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, files]) => ({ name, files, declared: declared.has(name) }));

  if (inventory.truncated)
    notes.push('The file limit was reached, so some files are not part of this map.');
  if (index.analysisTruncated)
    notes.push('Only the first part of the source files were analysed for symbols and imports.');
  if (!inventory.usedGit)
    notes.push('Not a git repository: .gitignore rules could not be applied.');
  notes.push(
    'Symbols, imports, routes and environment variables come from pattern matching, not a full parser.',
  );

  const map: RepoMap = {
    name: inventory.root.split(/[\\/]/).pop() ?? inventory.root,
    fileCount: paths.length,
    directories: topDirectories(paths),
    profile,
    keyModules,
    externalPackages: [...graph.externalPackages.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([name, files]) => ({ name, files })),
    routes,
    envVarsUsed,
    tests: {
      testFiles: association.testFiles.length,
      sourceFiles: association.sourceFiles.length,
      untestedSample: association.untested.slice(0, 8),
      untestedCount: association.untested.length,
    },
    secretFilesPresent: inventory.secretFiles.length,
    notes,
  };
  return { map, graph, association };
}

function list(values: readonly string[], fallback = 'none detected'): string {
  return values.length > 0 ? values.join(', ') : fallback;
}

/** Plain-text rendering used by `mia scan` and the model's project overview. */
export function renderRepoMap(map: RepoMap, options: { compact?: boolean } = {}): string[] {
  const { profile } = map;
  const out: string[] = [];
  out.push(`Project: ${map.name} (${map.fileCount} readable files)`);
  out.push(
    `Languages: ${list(profile.languages.slice(0, 6).map((l) => `${l.language} (${l.files})`))}`,
  );
  out.push(
    `Ecosystems: ${list(profile.ecosystems)}; package managers: ${list(profile.packageManagers)}`,
  );
  out.push(`Frameworks and libraries: ${list(profile.frameworks)}`);
  out.push(
    `Test frameworks: ${list(profile.testFrameworks)}; build tools: ${list(profile.buildTools)}`,
  );
  if (profile.databases.length > 0) out.push(`Data stores: ${list(profile.databases)}`);
  if (profile.authHints.length > 0)
    out.push(`Authentication-related dependencies: ${list(profile.authHints)}`);
  const cmds = Object.entries(profile.commands).map(([k, v]) => `${k}: ${v}`);
  if (cmds.length > 0)
    out.push(`Commands (inferred from project files, not verified): ${cmds.join('; ')}`);
  if (profile.entryPoints.length > 0) out.push(`Entry points: ${profile.entryPoints.join(', ')}`);
  if (profile.ci.length > 0) out.push(`CI: ${profile.ci.join(', ')}`);
  if (profile.containers.length > 0 && !options.compact)
    out.push(`Containers/infrastructure: ${profile.containers.join(', ')}`);
  if (profile.migrations.length > 0) out.push(`Migrations: ${profile.migrations.join(', ')}`);
  if (map.keyModules.length > 0) {
    out.push(
      'Most-imported modules: ' +
        map.keyModules
          .slice(0, options.compact ? 5 : 10)
          .map((m) => `${m.path} (${m.importedBy})`)
          .join(', '),
    );
  }
  if (map.directories.length > 0) {
    out.push(
      'Directories: ' +
        map.directories
          .slice(0, options.compact ? 12 : 25)
          .map((d) => `${d.path} ${d.files}${d.purpose ? ` [${d.purpose}]` : ''}`)
          .join('; '),
    );
  }
  if (options.compact) return out;

  if (map.routes.length > 0) {
    out.push('', `Routes found (${map.routes.length}, heuristic):`);
    for (const r of map.routes.slice(0, 25))
      out.push(`  ${r.method.padEnd(6)} ${r.route}  (${r.path}:${r.line})`);
    if (map.routes.length > 25) out.push(`  … ${map.routes.length - 25} more`);
  }
  if (map.externalPackages.length > 0) {
    out.push(
      '',
      'Most-used external packages: ' +
        map.externalPackages.map((p) => `${p.name} (${p.files})`).join(', '),
    );
  }
  if (map.envVarsUsed.length > 0) {
    out.push('', 'Environment variables read by the code (names only):');
    for (const v of map.envVarsUsed.slice(0, 25))
      out.push(`  ${v.name}${v.declared ? '' : '  (not declared in an .env example file)'}`);
  }
  out.push(
    '',
    `Tests: ${map.tests.testFiles} test file(s) for ${map.tests.sourceFiles} source file(s); ` +
      `${map.tests.untestedCount} source file(s) have no test file with a matching name.`,
  );
  if (profile.instructionFiles.length > 0) {
    out.push(
      `Agent instruction files found: ${profile.instructionFiles.join(', ')} (noted only; they are not applied in this version)`,
    );
  }
  if (profile.docs.length > 0) out.push(`Documentation: ${profile.docs.slice(0, 8).join(', ')}`);
  if (map.secretFilesPresent > 0)
    out.push(
      `${map.secretFilesPresent} secret-bearing file(s) exist and are excluded (never read or sent).`,
    );
  for (const note of map.notes) out.push(`Note: ${note}`);
  return out;
}
