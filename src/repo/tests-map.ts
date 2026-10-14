import { isCodeFile } from './languages.js';

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)/i;
const TEST_NAME =
  /(\.(test|spec)\.[A-Za-z]+$)|(^test_.*\.py$)|(_test\.(py|go|rb|rs|php)$)|(Tests?\.(java|kt|cs|php|swift)$)|(_spec\.rb$)/;

export function isTestFile(filePath: string): boolean {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  return TEST_NAME.test(name) || (TEST_DIR.test(filePath) && isCodeFile(filePath));
}

/** The name a test file is "about": `foo.test.ts`, `test_foo.py`, `foo_test.go`, `FooTest.java` all give `foo`. */
export function testSubject(filePath: string): string {
  let name = filePath.slice(filePath.lastIndexOf('/') + 1);
  name = name.replace(/\.[A-Za-z]+$/, '');
  name = name
    .replace(/\.(test|spec)$/, '')
    .replace(/^test_/, '')
    .replace(/_(test|spec)$/, '')
    .replace(/Tests?$/, '');
  return name.toLowerCase();
}

export function sourceStem(filePath: string): string {
  return filePath
    .slice(filePath.lastIndexOf('/') + 1)
    .replace(/\.[A-Za-z]+$/, '')
    .toLowerCase();
}

export interface TestAssociation {
  testFiles: string[];
  sourceFiles: string[];
  /** source file -> test files that share its name */
  testsFor: Map<string, string[]>;
  untested: string[];
}

/** Associates tests with sources by file name. This is a naming heuristic, not coverage data. */
export function associateTests(paths: readonly string[]): TestAssociation {
  const testFiles = paths.filter((p) => isTestFile(p) && isCodeFile(p));
  const testSet = new Set(testFiles);
  const sourceFiles = paths.filter((p) => isCodeFile(p) && !testSet.has(p));
  const bySubject = new Map<string, string[]>();
  for (const t of testFiles) {
    const subject = testSubject(t);
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), t]);
  }
  const testsFor = new Map<string, string[]>();
  const untested: string[] = [];
  for (const source of sourceFiles) {
    const found = bySubject.get(sourceStem(source));
    if (found) testsFor.set(source, found);
    else untested.push(source);
  }
  return { testFiles, sourceFiles, testsFor, untested };
}
