import { asString, isRecord } from '../util/json.js';
import { languageStats, type LanguageStat } from './languages.js';
import { readTextFile } from './read.js';
import type { FileAnalysis, Inventory } from './types.js';

export interface DetectedCommands {
  test?: string;
  build?: string;
  lint?: string;
  typecheck?: string;
  format?: string;
  start?: string;
}

export interface ProjectProfile {
  languages: LanguageStat[];
  ecosystems: string[];
  packageManagers: string[];
  frameworks: string[];
  buildTools: string[];
  testFrameworks: string[];
  databases: string[];
  authHints: string[];
  /** Commands inferred from project files. They are NOT verified by running them. */
  commands: DetectedCommands;
  manifests: string[];
  lockfiles: string[];
  ci: string[];
  containers: string[];
  migrations: string[];
  /** Names declared in `.env.example`-style templates (values are never read into this structure). */
  declaredEnvVars: string[];
  /** Instruction files other agents use. They are noted, never obeyed. */
  instructionFiles: string[];
  docs: string[];
  entryPoints: string[];
}

type Category = 'framework' | 'test' | 'build' | 'db' | 'auth';
interface DepRule {
  dep: string;
  label: string;
  category: Category;
}

const NODE_DEPS: DepRule[] = [
  ['react', 'React', 'framework'],
  ['next', 'Next.js', 'framework'],
  ['vue', 'Vue', 'framework'],
  ['nuxt', 'Nuxt', 'framework'],
  ['svelte', 'Svelte', 'framework'],
  ['@sveltejs/kit', 'SvelteKit', 'framework'],
  ['@angular/core', 'Angular', 'framework'],
  ['express', 'Express', 'framework'],
  ['fastify', 'Fastify', 'framework'],
  ['koa', 'Koa', 'framework'],
  ['@nestjs/core', 'NestJS', 'framework'],
  ['electron', 'Electron', 'framework'],
  ['react-native', 'React Native', 'framework'],
  ['hono', 'Hono', 'framework'],
  ['astro', 'Astro', 'framework'],
  ['@remix-run/react', 'Remix', 'framework'],
  ['solid-js', 'Solid', 'framework'],
  ['jest', 'Jest', 'test'],
  ['vitest', 'Vitest', 'test'],
  ['mocha', 'Mocha', 'test'],
  ['jasmine', 'Jasmine', 'test'],
  ['@playwright/test', 'Playwright', 'test'],
  ['cypress', 'Cypress', 'test'],
  ['ava', 'AVA', 'test'],
  ['vite', 'Vite', 'build'],
  ['webpack', 'webpack', 'build'],
  ['esbuild', 'esbuild', 'build'],
  ['rollup', 'Rollup', 'build'],
  ['typescript', 'TypeScript compiler', 'build'],
  ['tsup', 'tsup', 'build'],
  ['parcel', 'Parcel', 'build'],
  ['turbo', 'Turborepo', 'build'],
  ['prisma', 'Prisma', 'db'],
  ['@prisma/client', 'Prisma', 'db'],
  ['typeorm', 'TypeORM', 'db'],
  ['sequelize', 'Sequelize', 'db'],
  ['mongoose', 'MongoDB (Mongoose)', 'db'],
  ['pg', 'PostgreSQL client', 'db'],
  ['mysql2', 'MySQL client', 'db'],
  ['sqlite3', 'SQLite', 'db'],
  ['better-sqlite3', 'SQLite', 'db'],
  ['redis', 'Redis', 'db'],
  ['ioredis', 'Redis', 'db'],
  ['knex', 'Knex', 'db'],
  ['drizzle-orm', 'Drizzle', 'db'],
  ['@supabase/supabase-js', 'Supabase', 'db'],
  ['passport', 'Passport', 'auth'],
  ['jsonwebtoken', 'JSON Web Tokens', 'auth'],
  ['next-auth', 'NextAuth', 'auth'],
  ['bcrypt', 'bcrypt', 'auth'],
  ['bcryptjs', 'bcrypt', 'auth'],
  ['argon2', 'argon2', 'auth'],
].map(([dep, label, category]) => ({ dep, label, category }) as DepRule);

/** Rules for text manifests: matched as whole package names, case-insensitively. */
const TEXT_DEPS: Record<string, DepRule[]> = {
  python: [
    ['django', 'Django', 'framework'],
    ['flask', 'Flask', 'framework'],
    ['fastapi', 'FastAPI', 'framework'],
    ['tornado', 'Tornado', 'framework'],
    ['starlette', 'Starlette', 'framework'],
    ['aiohttp', 'aiohttp', 'framework'],
    ['streamlit', 'Streamlit', 'framework'],
    ['sanic', 'Sanic', 'framework'],
    ['celery', 'Celery', 'framework'],
    ['pandas', 'pandas', 'framework'],
    ['numpy', 'NumPy', 'framework'],
    ['torch', 'PyTorch', 'framework'],
    ['tensorflow', 'TensorFlow', 'framework'],
    ['scikit-learn', 'scikit-learn', 'framework'],
    ['pytest', 'pytest', 'test'],
    ['nose', 'nose', 'test'],
    ['tox', 'tox', 'test'],
    ['sqlalchemy', 'SQLAlchemy', 'db'],
    ['psycopg2', 'PostgreSQL client', 'db'],
    ['psycopg', 'PostgreSQL client', 'db'],
    ['pymysql', 'MySQL client', 'db'],
    ['mysqlclient', 'MySQL client', 'db'],
    ['mysql-connector-python', 'MySQL client', 'db'],
    ['pymongo', 'MongoDB', 'db'],
    ['redis', 'Redis', 'db'],
    ['peewee', 'Peewee', 'db'],
    ['alembic', 'Alembic migrations', 'db'],
    ['tinydb', 'TinyDB', 'db'],
    ['supabase', 'Supabase', 'db'],
    ['flask-login', 'Flask-Login', 'auth'],
    ['flask-jwt-extended', 'Flask-JWT-Extended', 'auth'],
    ['pyjwt', 'PyJWT', 'auth'],
    ['passlib', 'Passlib', 'auth'],
    ['bcrypt', 'bcrypt', 'auth'],
    ['authlib', 'Authlib', 'auth'],
    ['django-allauth', 'django-allauth', 'auth'],
  ].map(([dep, label, category]) => ({ dep, label, category }) as DepRule),
  go: [
    ['gin-gonic/gin', 'Gin', 'framework'],
    ['labstack/echo', 'Echo', 'framework'],
    ['gofiber/fiber', 'Fiber', 'framework'],
    ['go-chi/chi', 'chi', 'framework'],
    ['gorilla/mux', 'gorilla/mux', 'framework'],
    ['stretchr/testify', 'testify', 'test'],
    ['gorm.io/gorm', 'GORM', 'db'],
    ['jackc/pgx', 'pgx (PostgreSQL)', 'db'],
    ['golang-jwt', 'golang-jwt', 'auth'],
  ].map(([dep, label, category]) => ({ dep, label, category }) as DepRule),
  rust: [
    ['actix-web', 'Actix Web', 'framework'],
    ['axum', 'Axum', 'framework'],
    ['rocket', 'Rocket', 'framework'],
    ['tokio', 'Tokio', 'framework'],
    ['diesel', 'Diesel', 'db'],
    ['sqlx', 'SQLx', 'db'],
  ].map(([dep, label, category]) => ({ dep, label, category }) as DepRule),
  java: [
    ['spring-boot', 'Spring Boot', 'framework'],
    ['quarkus', 'Quarkus', 'framework'],
    ['micronaut', 'Micronaut', 'framework'],
    ['junit', 'JUnit', 'test'],
    ['hibernate', 'Hibernate', 'db'],
    ['spring-security', 'Spring Security', 'auth'],
  ].map(([dep, label, category]) => ({ dep, label, category }) as DepRule),
  php: [
    ['laravel/framework', 'Laravel', 'framework'],
    ['symfony/', 'Symfony', 'framework'],
    ['slim/slim', 'Slim', 'framework'],
    ['phpunit/phpunit', 'PHPUnit', 'test'],
  ].map(([dep, label, category]) => ({ dep, label, category }) as DepRule),
  ruby: [
    ['rails', 'Rails', 'framework'],
    ['sinatra', 'Sinatra', 'framework'],
    ['rspec', 'RSpec', 'test'],
    ['minitest', 'Minitest', 'test'],
    ['devise', 'Devise', 'auth'],
  ].map(([dep, label, category]) => ({ dep, label, category }) as DepRule),
};

const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
  'pubspec.lock',
  'packages.lock.json',
  'gradle.lockfile',
]);

const MANIFESTS = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'setup.py',
  'setup.cfg',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'pubspec.yaml',
  'composer.json',
  'Gemfile',
  'Package.swift',
  'CMakeLists.txt',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
  'compose.yml',
  'tsconfig.json',
  'deno.json',
]);

const INSTRUCTION_FILES = [
  'MIA.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
];

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function depthOf(p: string): number {
  return p.split('/').length;
}

function matchesDep(text: string, dep: string): boolean {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = dep.endsWith('/') ? '' : '(?![\\w-])';
  return new RegExp(`(?<![\\w-])${escaped}${tail}`, 'i').test(text);
}

async function tryRead(root: string, rel: string, maxBytes = 300_000): Promise<string | null> {
  try {
    return (await readTextFile(root, rel, { maxBytes })).text;
  } catch {
    return null;
  }
}

export async function detectProfile(
  inventory: Inventory,
  analyses: ReadonlyMap<string, FileAnalysis>,
): Promise<ProjectProfile> {
  const paths = inventory.files.map((f) => f.path);
  const set = new Set(paths);
  const root = inventory.root;
  const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

  const profile: ProjectProfile = {
    languages: languageStats(inventory.files),
    ecosystems: [],
    packageManagers: [],
    frameworks: [],
    buildTools: [],
    testFrameworks: [],
    databases: [],
    authHints: [],
    commands: {},
    manifests: [],
    lockfiles: [],
    ci: [],
    containers: [],
    migrations: [],
    declaredEnvVars: [],
    instructionFiles: [],
    docs: [],
    entryPoints: [],
  };
  const add = (rule: DepRule): void => {
    const target =
      rule.category === 'framework'
        ? profile.frameworks
        : rule.category === 'test'
          ? profile.testFrameworks
          : rule.category === 'build'
            ? profile.buildTools
            : rule.category === 'db'
              ? profile.databases
              : profile.authHints;
    addUnique(target, rule.label);
  };

  const shallow = paths.filter((p) => depthOf(p) <= 3);
  for (const p of shallow) {
    const name = baseName(p);
    if (MANIFESTS.has(name) && name !== 'Makefile' && name !== 'Dockerfile')
      profile.manifests.push(p);
    else if (
      name === 'Makefile' ||
      name === 'Dockerfile' ||
      /^docker-compose|^compose\.ya?ml$/.test(name)
    ) {
      if (name === 'Makefile') profile.manifests.push(p);
      else profile.containers.push(p);
    }
    if (LOCKFILES.has(name)) profile.lockfiles.push(p);
    if (/\.csproj$/.test(name)) profile.manifests.push(p);
    if (name === '.dockerignore') addUnique(profile.containers, p);
    if (/\.tf$/.test(name)) addUnique(profile.containers, 'Terraform (*.tf)');
    if (name === 'Chart.yaml') addUnique(profile.containers, p);
  }

  // Continuous integration
  for (const p of paths) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) addUnique(profile.ci, 'GitHub Actions');
    else if (p === '.gitlab-ci.yml') addUnique(profile.ci, 'GitLab CI');
    else if (p === 'azure-pipelines.yml') addUnique(profile.ci, 'Azure Pipelines');
    else if (p === '.circleci/config.yml') addUnique(profile.ci, 'CircleCI');
    else if (p === 'Jenkinsfile') addUnique(profile.ci, 'Jenkins');
    else if (p === 'bitbucket-pipelines.yml') addUnique(profile.ci, 'Bitbucket Pipelines');
    else if (p === '.travis.yml') addUnique(profile.ci, 'Travis CI');
  }

  // Node
  const packageJsons = shallow.filter((p) => baseName(p) === 'package.json').slice(0, 8);
  let rootScripts: Record<string, string> = {};
  const nodeMain: string[] = [];
  if (packageJsons.length > 0) {
    addUnique(profile.ecosystems, 'Node.js');
    for (const p of packageJsons) {
      const text = await tryRead(root, p);
      if (!text) continue;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isRecord(json)) continue;
      const deps: Record<string, unknown> = {
        ...(isRecord(json['dependencies']) ? json['dependencies'] : {}),
        ...(isRecord(json['devDependencies']) ? json['devDependencies'] : {}),
        ...(isRecord(json['peerDependencies']) ? json['peerDependencies'] : {}),
      };
      for (const rule of NODE_DEPS) if (rule.dep in deps) add(rule);
      if (p === 'package.json') {
        if (isRecord(json['scripts'])) {
          rootScripts = Object.fromEntries(
            Object.entries(json['scripts']).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          );
        }
        const main = asString(json['main']);
        if (main) nodeMain.push(main.replace(/^\.\//, ''));
        const bin = json['bin'];
        if (typeof bin === 'string') nodeMain.push(bin.replace(/^\.\//, ''));
        else if (isRecord(bin))
          for (const v of Object.values(bin))
            if (typeof v === 'string') nodeMain.push(v.replace(/^\.\//, ''));
      }
    }
  }
  if (set.has('yarn.lock')) addUnique(profile.packageManagers, 'yarn');
  if (set.has('pnpm-lock.yaml')) addUnique(profile.packageManagers, 'pnpm');
  if (set.has('bun.lockb') || set.has('bun.lock')) addUnique(profile.packageManagers, 'bun');
  if (
    set.has('package-lock.json') ||
    (packageJsons.length > 0 && profile.packageManagers.length === 0)
  )
    addUnique(profile.packageManagers, 'npm');

  // Text-manifest ecosystems
  const textEcosystems: { eco: string; key: string; files: (p: string) => boolean }[] = [
    {
      eco: 'Python',
      key: 'python',
      files: (p) =>
        /(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg)$/.test(p),
    },
    { eco: 'Go', key: 'go', files: (p) => baseName(p) === 'go.mod' },
    { eco: 'Rust', key: 'rust', files: (p) => baseName(p) === 'Cargo.toml' },
    {
      eco: 'Java/JVM',
      key: 'java',
      files: (p) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(p),
    },
    { eco: 'PHP', key: 'php', files: (p) => baseName(p) === 'composer.json' },
    { eco: 'Ruby', key: 'ruby', files: (p) => baseName(p) === 'Gemfile' },
  ];
  for (const { eco, key, files } of textEcosystems) {
    const found = shallow.filter(files).slice(0, 8);
    if (found.length === 0) continue;
    addUnique(profile.ecosystems, eco);
    const rules = TEXT_DEPS[key] ?? [];
    for (const p of found) {
      const text = await tryRead(root, p);
      if (text) for (const rule of rules) if (matchesDep(text, rule.dep)) add(rule);
    }
  }
  if (shallow.some((p) => baseName(p) === 'pubspec.yaml')) {
    addUnique(profile.ecosystems, 'Dart');
    const text = await tryRead(root, shallow.find((p) => baseName(p) === 'pubspec.yaml') as string);
    if (text && /^\s*flutter:/m.test(text)) addUnique(profile.frameworks, 'Flutter');
  }
  const csproj = shallow.filter((p) => /\.csproj$/.test(p)).slice(0, 5);
  if (csproj.length > 0) {
    addUnique(profile.ecosystems, '.NET');
    for (const p of csproj) {
      const text = (await tryRead(root, p)) ?? '';
      if (/Microsoft\.NET\.Sdk\.Web/.test(text)) addUnique(profile.frameworks, 'ASP.NET Core');
      if (/xunit/i.test(text)) addUnique(profile.testFrameworks, 'xUnit');
      if (/nunit/i.test(text)) addUnique(profile.testFrameworks, 'NUnit');
      if (/EntityFramework/i.test(text)) addUnique(profile.databases, 'Entity Framework');
    }
  }
  if (shallow.some((p) => baseName(p) === 'Package.swift')) addUnique(profile.ecosystems, 'Swift');
  if (shallow.some((p) => baseName(p) === 'CMakeLists.txt')) {
    addUnique(profile.ecosystems, 'C/C++');
    addUnique(profile.buildTools, 'CMake');
  }
  if (shallow.some((p) => baseName(p) === 'Makefile')) addUnique(profile.buildTools, 'make');
  if (paths.some((p) => /_test\.go$/.test(p))) addUnique(profile.testFrameworks, 'go test');
  if (set.has('Cargo.toml')) addUnique(profile.testFrameworks, 'cargo test');
  if (
    paths.some((p) => /(^|\/)test_[^/]+\.py$|_test\.py$/.test(p)) &&
    !profile.testFrameworks.includes('pytest')
  ) {
    addUnique(profile.testFrameworks, 'Python test files (runner not declared)');
  }

  // Commands (inferred only)
  const runner = profile.packageManagers.includes('pnpm')
    ? 'pnpm'
    : profile.packageManagers.includes('yarn')
      ? 'yarn'
      : 'npm';
  const script = (name: string): string | undefined => {
    const body = rootScripts[name];
    if (body === undefined) return undefined;
    if (name === 'test' && /no test specified/.test(body)) return undefined;
    if (runner === 'npm')
      return name === 'test' || name === 'start' ? `npm ${name}` : `npm run ${name}`;
    return `${runner} ${name}`;
  };
  const commands = profile.commands;
  for (const [key, names] of [
    ['test', ['test']],
    ['build', ['build']],
    ['lint', ['lint']],
    ['typecheck', ['typecheck', 'type-check', 'tsc']],
    ['format', ['format']],
    ['start', ['start', 'dev']],
  ] as const) {
    for (const n of names) {
      const cmd = script(n);
      if (cmd && !commands[key]) commands[key] = cmd;
    }
  }
  const makefile = set.has('Makefile') ? await tryRead(root, 'Makefile') : null;
  if (makefile) {
    for (const target of ['test', 'lint', 'build'] as const) {
      if (!commands[target] && new RegExp(`^${target}\\s*:`, 'm').test(makefile))
        commands[target] = `make ${target}`;
    }
    if (!commands.test && /^check\s*:/m.test(makefile)) commands.test = 'make check';
  }

  // Node without scripts: bun runs scripts with "bun run"; TypeScript projects can be type-checked directly.
  if (
    profile.packageManagers.includes('bun') &&
    !profile.packageManagers.some((m) => m === 'pnpm' || m === 'yarn')
  ) {
    for (const [key, names] of [
      ['test', ['test']],
      ['build', ['build']],
      ['lint', ['lint']],
      ['typecheck', ['typecheck', 'type-check', 'tsc']],
    ] as const) {
      commands[key] = undefined;
      for (const n of names)
        if (
          rootScripts[n] !== undefined &&
          !(n === 'test' && /no test specified/.test(rootScripts[n])) &&
          !commands[key]
        )
          commands[key] = `bun run ${n}`;
      if (!commands[key]) delete commands[key];
    }
  }
  if (!commands.typecheck && set.has('tsconfig.json') && packageJsons.includes('package.json')) {
    const text = await tryRead(root, 'package.json');
    if (text && /"typescript"\s*:/.test(text)) commands.typecheck = 'npx tsc --noEmit';
  }
  if (set.has('deno.json') || set.has('deno.jsonc')) {
    addUnique(profile.ecosystems, 'Deno');
    commands.test ??= 'deno test';
    commands.lint ??= 'deno lint';
  }

  // Python
  if (profile.ecosystems.includes('Python') || paths.some((p) => /\.py$/.test(p))) {
    const pyFiles = [
      'pyproject.toml',
      'requirements.txt',
      'requirements-dev.txt',
      'setup.cfg',
      'Pipfile',
      'tox.ini',
    ];
    let pyText = '';
    for (const f of pyFiles) if (set.has(f)) pyText += `\n${(await tryRead(root, f)) ?? ''}`;
    const hasPytest = /\bpytest\b/i.test(pyText) || set.has('pytest.ini') || set.has('conftest.py');
    const prefix = set.has('poetry.lock') ? 'poetry run ' : set.has('uv.lock') ? 'uv run ' : '';
    const testFiles = paths.filter((p) => /(^|\/)test_[^/]+\.py$|_test\.py$/.test(p)).slice(0, 5);
    let usesUnittest = false;
    for (const f of testFiles)
      if (/^\s*(import unittest|from unittest)/m.test((await tryRead(root, f, 100_000)) ?? ''))
        usesUnittest = true;
    if (hasPytest) commands.test = `${prefix}pytest`;
    else if (usesUnittest) {
      // Plain "discover" only descends into packages; tests in a folder without __init__.py need -s.
      const dir = testFiles.map((f) => f.split('/')[0]).find((d) => d === 'tests' || d === 'test');
      const plainDir = dir !== undefined && !set.has(`${dir}/__init__.py`);
      commands.test = plainDir
        ? `python -m unittest discover -s ${dir}`
        : 'python -m unittest discover';
    }
    if (
      /\[tool\.ruff|^\s*ruff\b|\bruff\s*[=<>~]|"ruff"/im.test(pyText) ||
      set.has('ruff.toml') ||
      set.has('.ruff.toml')
    )
      commands.lint ??= `${prefix}ruff check .`;
    else if (set.has('.flake8') || /\[flake8\]/.test(pyText)) commands.lint ??= `${prefix}flake8`;
    if (/\[tool\.mypy\]|\[mypy\]/.test(pyText) || set.has('mypy.ini'))
      commands.typecheck ??= `${prefix}mypy .`;
    else if (set.has('pyrightconfig.json') || /\[tool\.pyright\]/.test(pyText))
      commands.typecheck ??= `${prefix}pyright`;
  }

  // Go, Rust
  if (set.has('go.mod')) {
    commands.test ??= 'go test ./...';
    commands.build ??= 'go build ./...';
    commands.lint ??= 'go vet ./...';
  }
  if (set.has('Cargo.toml')) {
    commands.test ??= 'cargo test';
    commands.build ??= 'cargo build';
    commands.lint ??= 'cargo clippy';
    commands.typecheck ??= 'cargo check';
  }
  // JVM
  if (set.has('pom.xml')) commands.test ??= set.has('mvnw') ? './mvnw test' : 'mvn test';
  if (set.has('build.gradle') || set.has('build.gradle.kts'))
    commands.test ??= set.has('gradlew') ? './gradlew test' : 'gradle test';
  // .NET
  if (profile.ecosystems.includes('.NET')) {
    commands.test ??= 'dotnet test';
    commands.build ??= 'dotnet build';
  }
  // Ruby
  if (set.has('Gemfile')) {
    const gem = (await tryRead(root, 'Gemfile')) ?? '';
    if (/\brspec\b/.test(gem)) commands.test ??= 'bundle exec rspec';
    else if (
      set.has('Rakefile') &&
      /\b(minitest|test-unit)\b|rails/.test(gem) &&
      /TestTask|task\s*:?test/.test((await tryRead(root, 'Rakefile')) ?? '')
    )
      commands.test ??= 'bundle exec rake test';
  }
  // PHP
  if (set.has('composer.json')) {
    const text = (await tryRead(root, 'composer.json')) ?? '';
    let hasTestScript = false;
    try {
      const j: unknown = JSON.parse(text);
      hasTestScript = isRecord(j) && isRecord(j['scripts']) && 'test' in j['scripts'];
    } catch {
      /* ignore */
    }
    if (hasTestScript) commands.test ??= 'composer test';
    else if (profile.testFrameworks.includes('PHPUnit')) commands.test ??= 'vendor/bin/phpunit';
  }
  // Swift, Dart, Elixir
  if (set.has('Package.swift')) {
    commands.test ??= 'swift test';
    commands.build ??= 'swift build';
  }
  if (set.has('pubspec.yaml'))
    commands.test ??= profile.frameworks.includes('Flutter') ? 'flutter test' : 'dart test';
  if (set.has('mix.exs')) {
    addUnique(profile.ecosystems, 'Elixir');
    commands.test ??= 'mix test';
  }

  // Databases from containers and migration folders
  for (const p of profile.containers.filter((c) => /compose/.test(c))) {
    const text = await tryRead(root, p, 100_000);
    if (!text) continue;
    for (const m of text.matchAll(
      /image:\s*['"]?(?:[\w.-]+\/)?(postgres|mysql|mariadb|mongo|redis|mssql|cassandra|elasticsearch|rabbitmq)\b/gi,
    )) {
      if (m[1]) addUnique(profile.databases, `${m[1].toLowerCase()} (container)`);
    }
  }
  for (const p of paths) {
    if (/(^|\/)(migrations|alembic|db\/migrate|prisma\/migrations)\//.test(p)) {
      const dir = /(^|\/)((?:[\w-]+\/)*?(?:migrations|alembic|db\/migrate))\//.exec(p)?.[2];
      if (dir) addUnique(profile.migrations, dir);
    }
  }
  if (set.has('prisma/schema.prisma')) addUnique(profile.migrations, 'prisma/schema.prisma');

  // Declared environment variable names (templates only; names, never values)
  for (const p of paths
    .filter((x) => /(^|\/)\.env\.(example|sample|template)$/.test(x))
    .slice(0, 4)) {
    const text = await tryRead(root, p, 50_000);
    if (!text) continue;
    for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/gm))
      if (m[1]) addUnique(profile.declaredEnvVars, m[1]);
  }
  profile.declaredEnvVars.sort();

  // Instruction files and docs
  for (const f of INSTRUCTION_FILES) if (set.has(f)) profile.instructionFiles.push(f);
  for (const p of paths) {
    const name = baseName(p);
    if (
      depthOf(p) === 1 &&
      /^(README|CONTRIBUTING|CHANGELOG|LICENSE|SECURITY|ARCHITECTURE)(\.[A-Za-z]+)?$/i.test(name)
    )
      profile.docs.push(p);
    else if (/^docs?\//i.test(p) && depthOf(p) === 2) profile.docs.push(p);
  }
  profile.docs = profile.docs.slice(0, 20);

  // Entry points
  const entry: string[] = [];
  for (const m of nodeMain) if (set.has(m)) entry.push(m);
  for (const body of Object.values(rootScripts)) {
    const m =
      /\b(?:node|nodemon|ts-node|tsx|bun|deno run)\s+(?:--?[\w-]+\s+)*([\w./-]+\.(?:js|ts|mjs|cjs))/.exec(
        body,
      );
    if (m?.[1] && set.has(m[1].replace(/^\.\//, ''))) entry.push(m[1].replace(/^\.\//, ''));
  }
  const conventional = [
    'index.js',
    'index.ts',
    'server.js',
    'server.ts',
    'app.js',
    'app.ts',
    'main.js',
    'main.ts',
    'src/index.js',
    'src/index.ts',
    'src/main.js',
    'src/main.ts',
    'src/app.js',
    'src/app.ts',
    'src/server.js',
    'src/server.ts',
    'src/cli.ts',
    'main.py',
    'app.py',
    'manage.py',
    'wsgi.py',
    'asgi.py',
    'run.py',
    '__main__.py',
    'cli.py',
    'server.py',
    'main.go',
    'src/main.rs',
    'src/lib.rs',
    'index.php',
    'artisan',
    'config.ru',
    'lib/main.dart',
    'Program.cs',
  ];
  for (const c of conventional) if (set.has(c)) entry.push(c);
  for (const p of paths) {
    if (
      /^cmd\/[^/]+\/main\.go$/.test(p) ||
      /^src\/bin\/[^/]+\.rs$/.test(p) ||
      /^(?:src\/)?[\w-]+\/__main__\.py$/.test(p)
    )
      entry.push(p);
  }
  for (const [p, a] of analyses) {
    if (a.routes.length > 0 && entry.length < 3 && depthOf(p) <= 2) entry.push(p);
  }
  profile.entryPoints = [...new Set(entry)].slice(0, 12);

  profile.ecosystems.sort();
  profile.manifests = [...new Set(profile.manifests)].sort(
    (a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b),
  );
  profile.lockfiles.sort();
  profile.containers = [...new Set(profile.containers)];
  return profile;
}
