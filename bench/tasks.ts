/**
 * Benchmark tasks. Each has a reference solution (the "oracle") so the task itself can be validated
 * without any model: after the mutation the check must fail, after the oracle it must pass, and the
 * oracle may only touch `expectedFiles` (+ `allowedExtra`).
 */
export type ProjectKey = 'self' | 'node-todo' | 'py-textutil';

export interface Edit {
  file: string;
  /** Exact text that must occur once; replaced by `to`. */
  from?: string;
  to?: string;
  append?: string;
  write?: string;
}

export interface BenchTask {
  id: string;
  project: ProjectKey;
  kind: 'bugfix' | 'feature';
  /** What the user says. Written like a bug report or request, not a pointer to the file. */
  prompt: string;
  /** Breaks the project (bugfix tasks). */
  mutate?: Edit[];
  /** The reference fix. */
  oracle: Edit[];
  /** Hidden acceptance files added after the agent finishes (not visible to the model). */
  acceptance?: Record<string, string>;
  check: string;
  /** The files a correct solution changes. */
  expectedFiles: string[];
  /** Files that may reasonably change too (tests, docs). Anything else counts as unrelated. */
  allowedExtra?: string[];
}

const SELF_TEST = (f: string): string => `npx vitest run ${f}`;

export const TASKS: BenchTask[] = [
  {
    id: 'self-checks-ignored',
    project: 'self',
    kind: 'bugfix',
    prompt:
      'Commands listed in a ```mia-checks block in MIA.md are never picked up, so the verify step says no checks were found. Fix it.',
    mutate: [{ file: 'src/instructions/index.ts', from: '.slice(0, 10)', to: '.slice(0, 0)' }],
    oracle: [{ file: 'src/instructions/index.ts', from: '.slice(0, 0)', to: '.slice(0, 10)' }],
    check: SELF_TEST('tests/task.test.ts'),
    expectedFiles: ['src/instructions/index.ts'],
  },
  {
    id: 'self-missing-tests-warning',
    project: 'self',
    kind: 'bugfix',
    prompt:
      'The review notes warn about "no test file changed" even when the change did include test files, and stay silent when it did not. It looks inverted.',
    mutate: [{ file: 'src/agent/review.ts', from: 'tests.length === 0', to: 'tests.length > 0' }],
    oracle: [{ file: 'src/agent/review.ts', from: 'tests.length > 0', to: 'tests.length === 0' }],
    check: SELF_TEST('tests/task.test.ts'),
    expectedFiles: ['src/agent/review.ts'],
  },
  {
    id: 'self-sandbox-network',
    project: 'self',
    kind: 'bugfix',
    prompt:
      'Commands run inside the bubblewrap sandbox can reach the network even though the default policy is network off. Find and fix it.',
    mutate: [
      {
        file: 'src/sandbox/backends.ts',
        from: "if (o.network === 'off') a.push",
        to: "if (o.network === 'on') a.push",
      },
    ],
    oracle: [
      {
        file: 'src/sandbox/backends.ts',
        from: "if (o.network === 'on') a.push",
        to: "if (o.network === 'off') a.push",
      },
    ],
    check: SELF_TEST('tests/sandbox.test.ts'),
    expectedFiles: ['src/sandbox/backends.ts'],
  },
  {
    id: 'self-go-lint',
    project: 'self',
    kind: 'bugfix',
    prompt:
      'Go projects are given a wrong lint command by project detection. It should be the standard vet command for all packages.',
    mutate: [{ file: 'src/repo/detect.ts', from: "'go vet ./...'", to: "'golint ./...'" }],
    oracle: [{ file: 'src/repo/detect.ts', from: "'golint ./...'", to: "'go vet ./...'" }],
    check: SELF_TEST('tests/detect-eval.test.ts'),
    expectedFiles: ['src/repo/detect.ts'],
  },
  {
    id: 'self-new-skill',
    project: 'self',
    kind: 'feature',
    prompt:
      'Add a built-in skill named "write-changelog" that tells the agent how to add an entry to the project\'s existing CHANGELOG following its format. It should appear in the list of built-in skills with a one-line description.',
    oracle: [
      {
        file: 'src/instructions/skills.ts',
        from: "  {\n    name: 'add-tests',",
        to: "  {\n    name: 'write-changelog',\n    description: 'Add a changelog entry in the format the project already uses',\n    source: 'built-in',\n    body: '1. Read the top of the CHANGELOG and copy its format.\\n2. Add one entry per user-visible change.',\n  },\n  {\n    name: 'add-tests',",
      },
    ],
    acceptance: {
      'tests/accept-skill.test.ts':
        "import { expect, it } from 'vitest';\nimport { BUILTIN_SKILLS } from '../src/instructions/skills.js';\nit('has write-changelog', () => {\n  const s = BUILTIN_SKILLS.find((k) => k.name === 'write-changelog');\n  expect(s?.source).toBe('built-in');\n  expect((s?.description ?? '').length).toBeGreaterThan(10);\n  expect((s?.body ?? '').length).toBeGreaterThan(20);\n});\n",
    },
    check: SELF_TEST('tests/accept-skill.test.ts'),
    expectedFiles: ['src/instructions/skills.ts'],
    allowedExtra: ['tests/task.test.ts'],
  },
  {
    id: 'todo-complete-noop',
    project: 'node-todo',
    kind: 'bugfix',
    prompt: 'Completing a todo does nothing: finished items still show up as pending.',
    mutate: [{ file: 'src/todo.js', from: 'item.done = true;', to: 'item.done = false;' }],
    oracle: [{ file: 'src/todo.js', from: 'item.done = false;', to: 'item.done = true;' }],
    check: 'npm test',
    expectedFiles: ['src/todo.js'],
  },
  {
    id: 'todo-format-swapped',
    project: 'node-todo',
    kind: 'bugfix',
    prompt: 'The printed list shows done items as open boxes and open items as checked.',
    mutate: [
      { file: 'src/format.js', from: "item.done ? '[x]' : '[ ]'", to: "item.done ? '[ ]' : '[x]'" },
    ],
    oracle: [
      { file: 'src/format.js', from: "item.done ? '[ ]' : '[x]'", to: "item.done ? '[x]' : '[ ]'" },
    ],
    check: 'npm test',
    expectedFiles: ['src/format.js'],
  },
  {
    id: 'todo-clear-completed',
    project: 'node-todo',
    kind: 'feature',
    prompt:
      'Add an exported function clearCompleted(list) to the todo module that removes all done items from the list and returns how many were removed.',
    oracle: [
      {
        file: 'src/todo.js',
        append:
          '\nexport function clearCompleted(list) {\n  const before = list.items.length;\n  list.items = list.items.filter((i) => !i.done);\n  return before - list.items.length;\n}\n',
      },
    ],
    acceptance: {
      'test/clear.test.js':
        "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { addTodo, clearCompleted, completeTodo, createList } from '../src/todo.js';\ntest('clearCompleted', () => {\n  const l = createList();\n  const a = addTodo(l, 'a');\n  addTodo(l, 'b');\n  completeTodo(l, a.id);\n  assert.equal(clearCompleted(l), 1);\n  assert.deepEqual(l.items.map((i) => i.title), ['b']);\n  assert.equal(clearCompleted(l), 0);\n});\n",
    },
    check: 'npm test',
    expectedFiles: ['src/todo.js'],
    allowedExtra: ['test/todo.test.js', 'README.md'],
  },
  {
    id: 'todo-by-priority',
    project: 'node-todo',
    kind: 'feature',
    prompt:
      'Add an exported function byPriority(list, priority) that returns the todos with exactly that priority, still in insertion order. Todos default to priority "normal".',
    oracle: [
      {
        file: 'src/todo.js',
        append:
          '\nexport function byPriority(list, priority) {\n  return list.items.filter((i) => i.priority === priority);\n}\n',
      },
    ],
    acceptance: {
      'test/priority.test.js':
        "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { addTodo, byPriority, createList } from '../src/todo.js';\ntest('byPriority', () => {\n  const l = createList();\n  addTodo(l, 'a', 'high');\n  addTodo(l, 'b');\n  addTodo(l, 'c', 'high');\n  assert.deepEqual(byPriority(l, 'high').map((i) => i.title), ['a', 'c']);\n  assert.deepEqual(byPriority(l, 'normal').map((i) => i.title), ['b']);\n  assert.deepEqual(byPriority(l, 'low'), []);\n});\n",
    },
    check: 'npm test',
    expectedFiles: ['src/todo.js'],
    allowedExtra: ['test/todo.test.js', 'README.md'],
  },
  {
    id: 'text-truncate-limit',
    project: 'py-textutil',
    kind: 'bugfix',
    prompt: 'truncate() sometimes returns text longer than the limit I pass in.',
    mutate: [
      { file: 'textutil/words.py', from: 'text[: limit - len(suffix)]', to: 'text[:limit]' },
    ],
    oracle: [
      { file: 'textutil/words.py', from: 'text[:limit]', to: 'text[: limit - len(suffix)]' },
    ],
    check: 'python3 -m unittest discover -s tests',
    expectedFiles: ['textutil/words.py'],
  },
  {
    id: 'text-slug-dashes',
    project: 'py-textutil',
    kind: 'bugfix',
    prompt: 'slugify leaves dashes at the start and end, e.g. "  --A  b-- " should give "a-b".',
    mutate: [{ file: 'textutil/words.py', from: 'return slug.strip("-")', to: 'return slug' }],
    oracle: [{ file: 'textutil/words.py', from: 'return slug\n', to: 'return slug.strip("-")\n' }],
    check: 'python3 -m unittest discover -s tests',
    expectedFiles: ['textutil/words.py'],
  },
  {
    id: 'text-title-case',
    project: 'py-textutil',
    kind: 'feature',
    prompt:
      'Add title_case(text) to textutil (export it from the package). It capitalizes each word, but the small words a, an, the, of, in, and are lowercase unless they are the first word. "the lord of the rings" -> "The Lord of the Rings".',
    oracle: [
      {
        file: 'textutil/words.py',
        append:
          '\n\n_SMALL = {"a", "an", "the", "of", "in", "and"}\n\n\ndef title_case(text: str) -> str:\n    words = text.split()\n    out = []\n    for i, w in enumerate(words):\n        lw = w.lower()\n        out.append(lw if (i > 0 and lw in _SMALL) else lw.capitalize())\n    return " ".join(out)\n',
      },
      {
        file: 'textutil/__init__.py',
        from: 'from .words import slugify, truncate, word_count',
        to: 'from .words import slugify, title_case, truncate, word_count',
      },
      {
        file: 'textutil/__init__.py',
        from: '__all__ = ["slugify", "truncate", "word_count"]',
        to: '__all__ = ["slugify", "title_case", "truncate", "word_count"]',
      },
    ],
    acceptance: {
      'tests/test_title.py':
        'import unittest\n\nfrom textutil import title_case\n\n\nclass TitleTest(unittest.TestCase):\n    def test_title(self):\n        self.assertEqual(title_case("the lord of the rings"), "The Lord of the Rings")\n        self.assertEqual(title_case("a tale in AND out"), "A Tale in and Out")\n        self.assertEqual(title_case(""), "")\n',
    },
    check: 'python3 -m unittest discover -s tests',
    expectedFiles: ['textutil/words.py', 'textutil/__init__.py'],
    allowedExtra: ['tests/test_words.py', 'README.md'],
  },
  {
    id: 'text-lerp',
    project: 'py-textutil',
    kind: 'feature',
    prompt:
      'Add lerp(a, b, t) to textutil/numbers.py: linear interpolation a + (b - a) * t, with t clamped to the range 0 to 1 using the existing clamp helper.',
    oracle: [
      {
        file: 'textutil/numbers.py',
        append:
          '\n\ndef lerp(a: float, b: float, t: float) -> float:\n    return a + (b - a) * clamp(t, 0.0, 1.0)\n',
      },
    ],
    acceptance: {
      'tests/test_lerp.py':
        'import unittest\n\nfrom textutil.numbers import lerp\n\n\nclass LerpTest(unittest.TestCase):\n    def test_lerp(self):\n        self.assertEqual(lerp(0, 10, 0.5), 5)\n        self.assertEqual(lerp(0, 10, 2), 10)\n        self.assertEqual(lerp(0, 10, -1), 0)\n',
    },
    check: 'python3 -m unittest discover -s tests',
    expectedFiles: ['textutil/numbers.py'],
    allowedExtra: ['tests/test_numbers.py', 'README.md'],
  },
];
