import { describe, expect, it } from 'vitest';
import { normalize, routeIntent } from '../src/nl/intent.js';

const slash = (s: string): string | null | undefined => routeIntent(s)?.slash;

describe('normalize', () => {
  it('strips politeness and punctuation', () => {
    expect(normalize('Hey Mia, could you please undo that for me?')).toBe('undo that');
    expect(normalize("I'd like you to scan the project!")).toBe('scan the project');
  });
});

describe('natural language routes to the same commands', () => {
  const cases: [string, string][] = [
    ['undo', '/undo'],
    ['Please undo the last change', '/undo'],
    ['can you roll back your changes', '/undo'],
    ['show me what you changed', '/diff'],
    ['what did you change?', '/diff'],
    ['scan project', '/scan'],
    ['scan the project', '/scan'],
    ['show me the project structure', '/scan'],
    ['project overview', '/scan'],
    ['audit', '/audit'],
    ['run a security audit', '/audit --mode security'],
    ['audit this repo', '/audit'],
    ['quick audit of the codebase', '/audit --mode quick'],
    ['check the code for security issues', '/audit --mode security'],
    ['switch to auto-edit mode', '/mode auto-edit'],
    ['go to read only mode', '/mode readonly'],
    ['chat mode', '/mode chat'],
    ['use auto mode', '/mode auto'],
    ['set it to ask mode please', '/mode ask'],
    ['what mode am I in?', '/mode'],
    ['list models', '/models'],
    ['what models can I use', '/models'],
    ['which model am I using', '/model'],
    ['switch to model llama-3.3-70b-versatile', '/model llama-3.3-70b-versatile'],
    ['use gpt-4.1 model', '/model gpt-4.1'],
    ['list providers', '/provider'],
    ['switch provider to groq', '/provider groq'],
    ['show my keys', '/keys'],
    ['retry my keys', '/keys reset'],
    ['how many tokens have I used', '/usage'],
    ['status', '/status'],
    ['show context', '/context'],
    ['list skills', '/skills'],
    ['use the review-diff skill on my last change', '/skill review-diff my last change'],
    ['make a plan for adding login', '/plan adding login'],
    ['plan the refactor first', '/plan the refactor'],
    ['check my setup', '/doctor'],
    ['help', '/help'],
    ['clear the chat', '/clear'],
    ['bye', '/quit'],
    ["I'm done", '/quit'],
  ];
  for (const [input, expected] of cases)
    it(`${JSON.stringify(input)} -> ${expected}`, () => expect(slash(input)).toBe(expected));
});

describe('ordinary requests are left for the model', () => {
  const none = [
    'scan src/auth.ts for bugs',
    'undo the typo in the README',
    'use typescript for the new file',
    'what changed in auth.ts between v1 and v2',
    'explain the audit rules',
    'run the tests',
    'fix the failing test',
    'clear the cache directory in the build script',
    'switch to a faster algorithm',
    'use the fast model',
    'add an endpoint for users',
    'show me the login function',
    '/mode ask',
    '',
  ];
  for (const input of none) it(JSON.stringify(input), () => expect(routeIntent(input)).toBeNull());
});

describe('shell scope', () => {
  it('maps to mia arguments, and says when a session command has no shell equivalent', () => {
    expect(routeIntent('scan project')?.cli).toEqual(['scan']);
    expect(routeIntent('run a deep audit')?.cli).toEqual(['audit', '--mode', 'deep']);
    expect(routeIntent('set up')?.cli).toEqual(['init']);
    expect(routeIntent('undo')?.cli).toBeNull();
    expect(routeIntent('make a plan for adding login')?.cli).toEqual([
      'run',
      '--plan',
      'adding login',
    ]);
  });
});
