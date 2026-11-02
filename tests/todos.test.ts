import assert from 'node:assert/strict';
import test from 'node:test';
import { todoCount, todoFraction, todoLine, todoProgress, todosFinished, validTodoProgress } from '../src/shared/todos.js';

// TodoWrite's tool_input as Droid 1.1.0 sends it: structured on PostToolUse, typed text on PreToolUse.
const posted = {
  todos: [
    { id: '1', status: 'completed', content: 'alpha', priority: 'high' },
    { id: '2', status: 'in_progress', content: 'beta', priority: 'medium' },
    { id: '3', status: 'pending', content: 'gamma', priority: 'low' },
  ],
};
const typed = { todos: '1. [completed] alpha\n2. [in_progress] beta\n3. [pending] gamma' };

test('a TodoWrite list is summed up as done, total and the item in progress, from either shape', () => {
  assert.deepEqual(todoProgress(posted), { done: 1, total: 3, current: 'beta' });
  assert.deepEqual(todoProgress(typed), { done: 1, total: 3, current: 'beta' });
  assert.deepEqual(todoProgress({ todos: [{ status: 'pending', content: 'one' }] }), { done: 0, total: 1 });
  assert.deepEqual(todoProgress({ todos: '1. [in progress] spaced\n2. [Completed] cased' }), { done: 1, total: 2, current: 'spaced' });
});

test('items with no text, and lists with none, are left out', () => {
  assert.equal(todoProgress({ todos: [] }), undefined);
  assert.equal(todoProgress({ todos: '' }), undefined);
  assert.equal(todoProgress({}), undefined);
  assert.equal(todoProgress(null), undefined);
  assert.equal(todoProgress('1. [pending] not an input'), undefined);
  assert.deepEqual(todoProgress({ todos: [{ status: 'completed', content: '  ' }, null, 5, { status: 'completed', content: 'kept' }] }), { done: 1, total: 1 });
  assert.deepEqual(todoProgress({ todos: 'Plan:\n1. [pending] first\nnot an item' }), { done: 0, total: 1 });
});

test('a long item in progress is cut short', () => {
  const p = todoProgress({ todos: [{ status: 'in_progress', content: 'x'.repeat(500) }] });
  assert.ok(p?.current && p.current.length <= 120 && p.current.endsWith('…'));
});

test('the words every client shows', () => {
  const p = { done: 3, total: 5, current: 'Write the tests' };
  assert.equal(todoCount(p), '3/5');
  assert.equal(todoLine(p), '3/5 · Write the tests');
  assert.equal(todoLine({ done: 5, total: 5 }), '5/5 done');
  assert.equal(todoFraction(p), 0.6);
  assert.equal(todoFraction({ done: 0, total: 0 }), 0);
  assert.equal(todosFinished(p), false);
  assert.equal(todosFinished({ done: 5, total: 5 }), true);
});

test('saved progress is read back only when it is well formed', () => {
  assert.deepEqual(validTodoProgress({ done: 1, total: 3, current: 'beta' }), { done: 1, total: 3, current: 'beta' });
  assert.deepEqual(validTodoProgress({ done: 0, total: 2, current: ' ' }), { done: 0, total: 2 });
  for (const bad of [undefined, null, 'x', { done: 4, total: 3 }, { done: -1, total: 3 }, { done: 0, total: 0 }, { done: 1.5, total: 3 }, { done: '1', total: 3 }]) assert.equal(validTodoProgress(bad), undefined);
});
