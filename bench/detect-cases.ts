import type { DetectedCommands } from '../src/repo/detect.js';

/**
 * Evaluation set for project detection: small synthetic projects and the check commands a careful
 * human would pick for each. `expect` lists test/lint/typecheck/build exactly (absent = must not be
 * detected). Add a case whenever detection is wrong on a real project.
 */
export interface DetectCase {
  name: string;
  language: string;
  files: Record<string, string>;
  expect: Pick<DetectedCommands, 'test' | 'lint' | 'typecheck' | 'build'>;
  ecosystem?: string;
}

const pkg = (o: Record<string, unknown>): string => JSON.stringify(o);
const py = 'def f():\n    return 1\n';

export const DETECT_CASES: DetectCase[] = [
  // ---- Node / TypeScript
  {
    name: 'npm scripts',
    language: 'node',
    ecosystem: 'Node.js',
    files: {
      'package.json': pkg({
        scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'tsc' },
      }),
      'package-lock.json': '{}',
    },
    expect: {
      test: 'npm test',
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      build: 'npm run build',
    },
  },
  {
    name: 'pnpm scripts',
    language: 'node',
    files: {
      'package.json': pkg({ scripts: { test: 'jest', lint: 'eslint .' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
    },
    expect: { test: 'pnpm test', lint: 'pnpm lint' },
  },
  {
    name: 'yarn scripts',
    language: 'node',
    files: { 'package.json': pkg({ scripts: { test: 'jest' } }), 'yarn.lock': '# yarn' },
    expect: { test: 'yarn test' },
  },
  {
    name: 'bun scripts',
    language: 'node',
    files: {
      'package.json': pkg({ scripts: { test: 'bun test', build: 'bun build ./src/index.ts' } }),
      'bun.lockb': 'x',
    },
    expect: { test: 'bun run test', build: 'bun run build' },
  },
  {
    name: 'npm default placeholder test',
    language: 'node',
    files: {
      'package.json': pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    },
    expect: {},
  },
  {
    name: 'typescript without typecheck script',
    language: 'node',
    files: {
      'package.json': pkg({
        devDependencies: { typescript: '^5.0.0' },
        scripts: { test: 'node --test' },
      }),
      'tsconfig.json': '{}',
      'package-lock.json': '{}',
    },
    expect: { test: 'npm test', typecheck: 'npx tsc --noEmit' },
  },
  {
    name: 'type-check script name',
    language: 'node',
    files: { 'package.json': pkg({ scripts: { 'type-check': 'tsc' } }), 'package-lock.json': '{}' },
    expect: { typecheck: 'npm run type-check' },
  },
  {
    name: 'monorepo root without scripts',
    language: 'node',
    files: {
      'package.json': pkg({ workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg({ scripts: { test: 'jest' } }),
    },
    expect: {},
  },
  {
    name: 'deno',
    language: 'node',
    ecosystem: 'Deno',
    files: { 'deno.json': '{"tasks":{}}', 'main.ts': 'console.log(1)' },
    expect: { test: 'deno test', lint: 'deno lint' },
  },
  // ---- Python
  {
    name: 'pytest in requirements',
    language: 'python',
    ecosystem: 'Python',
    files: { 'requirements.txt': 'flask\npytest\n', 'tests/test_a.py': py },
    expect: { test: 'pytest' },
  },
  {
    name: 'pytest in pyproject',
    language: 'python',
    files: {
      'pyproject.toml': '[project]\nname="x"\n[tool.pytest.ini_options]\ntestpaths=["tests"]\n',
      'tests/test_a.py': py,
    },
    expect: { test: 'pytest' },
  },
  {
    name: 'unittest only',
    language: 'python',
    files: {
      'app.py': py,
      'tests/test_app.py':
        'import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n',
    },
    expect: { test: 'python -m unittest discover -s tests' },
  },
  {
    name: 'unittest in a package',
    language: 'python',
    files: {
      'app.py': py,
      'tests/__init__.py': '',
      'tests/test_app.py': 'import unittest\nclass T(unittest.TestCase):\n    pass\n',
    },
    expect: { test: 'python -m unittest discover' },
  },
  {
    name: 'poetry with pytest',
    language: 'python',
    files: {
      'pyproject.toml': '[tool.poetry]\nname="x"\n[tool.poetry.dev-dependencies]\npytest="*"\n',
      'poetry.lock': '# lock',
      'tests/test_a.py': py,
    },
    expect: { test: 'poetry run pytest' },
  },
  {
    name: 'uv with pytest and ruff',
    language: 'python',
    files: {
      'pyproject.toml':
        '[project]\nname="x"\ndependencies=[]\n[dependency-groups]\ndev=["pytest","ruff"]\n[tool.ruff]\nline-length=100\n',
      'uv.lock': '# lock',
      'tests/test_a.py': py,
    },
    expect: { test: 'uv run pytest', lint: 'uv run ruff check .' },
  },
  {
    name: 'ruff and mypy config',
    language: 'python',
    files: {
      'requirements.txt': 'pytest\n',
      'pyproject.toml': '[tool.ruff]\nline-length=100\n[tool.mypy]\nstrict=true\n',
      'tests/test_a.py': py,
    },
    expect: { test: 'pytest', lint: 'ruff check .', typecheck: 'mypy .' },
  },
  {
    name: 'python without tests',
    language: 'python',
    files: { 'main.py': py, 'requirements.txt': 'requests\n' },
    expect: {},
  },
  // ---- Go
  {
    name: 'go module',
    language: 'go',
    ecosystem: 'Go',
    files: {
      'go.mod': 'module x\n\ngo 1.22\n',
      'main.go': 'package main\nfunc main() {}\n',
      'main_test.go': 'package main\n',
    },
    expect: { test: 'go test ./...', build: 'go build ./...', lint: 'go vet ./...' },
  },
  // ---- Rust
  {
    name: 'cargo',
    language: 'rust',
    ecosystem: 'Rust',
    files: {
      'Cargo.toml': '[package]\nname="x"\nversion="0.1.0"\n',
      'src/main.rs': 'fn main() {}\n',
    },
    expect: {
      test: 'cargo test',
      build: 'cargo build',
      lint: 'cargo clippy',
      typecheck: 'cargo check',
    },
  },
  // ---- JVM
  {
    name: 'maven',
    language: 'java',
    ecosystem: 'Java/JVM',
    files: { 'pom.xml': '<project></project>', 'src/main/java/A.java': 'class A {}' },
    expect: { test: 'mvn test' },
  },
  {
    name: 'maven wrapper',
    language: 'java',
    files: {
      'pom.xml': '<project></project>',
      mvnw: '#!/bin/sh',
      'src/main/java/A.java': 'class A {}',
    },
    expect: { test: './mvnw test' },
  },
  {
    name: 'gradle with wrapper',
    language: 'java',
    files: {
      'build.gradle': 'plugins {}',
      gradlew: '#!/bin/sh',
      'src/main/java/A.java': 'class A {}',
    },
    expect: { test: './gradlew test' },
  },
  {
    name: 'gradle without wrapper',
    language: 'java',
    files: { 'build.gradle.kts': 'plugins {}', 'src/main/kotlin/A.kt': 'class A' },
    expect: { test: 'gradle test' },
  },
  // ---- .NET
  {
    name: 'dotnet project',
    language: 'dotnet',
    ecosystem: '.NET',
    files: {
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'Program.cs': 'class P {}',
    },
    expect: { test: 'dotnet test', build: 'dotnet build' },
  },
  // ---- Ruby / PHP
  {
    name: 'ruby rspec',
    language: 'ruby',
    ecosystem: 'Ruby',
    files: { Gemfile: "source 'https://rubygems.org'\ngem 'rspec'\n", 'spec/a_spec.rb': 'x' },
    expect: { test: 'bundle exec rspec' },
  },
  {
    name: 'ruby minitest rake',
    language: 'ruby',
    files: {
      Gemfile: "gem 'minitest'\n",
      Rakefile: "require 'rake/testtask'\nRake::TestTask.new\n",
      'test/a_test.rb': 'x',
    },
    expect: { test: 'bundle exec rake test' },
  },
  {
    name: 'php composer test script',
    language: 'php',
    ecosystem: 'PHP',
    files: {
      'composer.json': pkg({
        scripts: { test: 'phpunit' },
        'require-dev': { 'phpunit/phpunit': '^10' },
      }),
    },
    expect: { test: 'composer test' },
  },
  {
    name: 'php phpunit only',
    language: 'php',
    files: { 'composer.json': pkg({ 'require-dev': { 'phpunit/phpunit': '^10' } }) },
    expect: { test: 'vendor/bin/phpunit' },
  },
  // ---- Others
  {
    name: 'swift package',
    language: 'swift',
    ecosystem: 'Swift',
    files: { 'Package.swift': '// swift-tools-version:5.9', 'Sources/a/a.swift': 'x' },
    expect: { test: 'swift test', build: 'swift build' },
  },
  {
    name: 'flutter',
    language: 'dart',
    ecosystem: 'Dart',
    files: {
      'pubspec.yaml': 'name: x\nflutter:\n  uses-material-design: true\n',
      'lib/main.dart': 'x',
    },
    expect: { test: 'flutter test' },
  },
  {
    name: 'dart',
    language: 'dart',
    files: { 'pubspec.yaml': 'name: x\n', 'lib/a.dart': 'x' },
    expect: { test: 'dart test' },
  },
  {
    name: 'elixir',
    language: 'elixir',
    files: { 'mix.exs': 'defmodule X.MixProject do\nend\n', 'lib/x.ex': 'x' },
    expect: { test: 'mix test' },
  },
  {
    name: 'makefile targets',
    language: 'make',
    files: {
      Makefile: 'test:\n\tpytest\n\nlint:\n\truff .\n\nbuild:\n\tgcc a.c\n',
      'a.c': 'int main(){return 0;}',
    },
    expect: { test: 'make test', lint: 'make lint', build: 'make build' },
  },
  {
    name: 'makefile check target only',
    language: 'make',
    files: { Makefile: 'check:\n\t./run-tests.sh\n', 'a.c': 'x' },
    expect: { test: 'make check' },
  },
  {
    name: 'empty project',
    language: 'none',
    files: { 'README.md': 'Run pytest and npm test to test this.\n' },
    expect: {},
  },
];
