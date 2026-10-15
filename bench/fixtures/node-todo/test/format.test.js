import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTodo } from '../src/format.js';

test('formats open and done items', () => {
  assert.equal(formatTodo({ id: 1, title: 'a', done: false }), '[ ] #1 a');
  assert.equal(formatTodo({ id: 2, title: 'b', done: true }), '[x] #2 b');
});
