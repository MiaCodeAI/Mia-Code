import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTodo, completeTodo, createList, pending, removeTodo } from '../src/todo.js';

test('adds and trims titles', () => {
  const list = createList();
  assert.equal(addTodo(list, '  milk  ').title, 'milk');
  assert.throws(() => addTodo(list, '   '), /required/);
});

test('complete and pending', () => {
  const list = createList();
  const a = addTodo(list, 'a');
  addTodo(list, 'b');
  completeTodo(list, a.id);
  assert.deepEqual(
    pending(list).map((i) => i.title),
    ['b'],
  );
});

test('remove', () => {
  const list = createList();
  const a = addTodo(list, 'a');
  removeTodo(list, a.id);
  assert.equal(list.items.length, 0);
  assert.throws(() => removeTodo(list, 999), /no todo/);
});
