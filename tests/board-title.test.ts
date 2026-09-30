import test from 'node:test';
import assert from 'node:assert/strict';
import { columnCards } from '../src/shared/board-filter.js';

const cards = [
  { title: 'Fix the login page', labels: [{ name: 'bug' }] },
  { title: 'Login rate limit', labels: [{ name: 'enhancement' }] },
  { title: 'Write the office guide', labels: [{ name: 'docs' }, { name: 'bug' }] },
  { title: 'HELLO world banner', labels: [{ name: 'bug' }] },
];

test('a blank title query leaves the label filter in charge', () => {
  assert.deepEqual(
    columnCards(cards, [], '').map((c) => c.title),
    cards.map((c) => c.title),
  );
  assert.deepEqual(
    columnCards(cards, ['bug'], '   ').map((c) => c.title),
    ['Fix the login page', 'Write the office guide', 'HELLO world banner'],
  );
});

test('every typed word must match, in any order and any case', () => {
  assert.deepEqual(
    columnCards(cards, [], 'LOGIN fix').map((c) => c.title),
    ['Fix the login page'],
  );
  assert.deepEqual(
    columnCards(cards, [], 'world hello').map((c) => c.title),
    ['HELLO world banner'],
  );
  assert.deepEqual(
    columnCards(cards, [], 'login missing').map((c) => c.title),
    [],
  );
});

test('the title query and the label filter both apply', () => {
  assert.deepEqual(
    columnCards(cards, ['bug'], 'login').map((c) => c.title),
    ['Fix the login page'],
  );
  assert.deepEqual(
    columnCards(cards, ['enhancement'], 'login').map((c) => c.title),
    ['Login rate limit'],
  );
  assert.deepEqual(columnCards(cards, ['docs'], 'login'), []);
});

test('max caps the cards after both filters', () => {
  const shown = columnCards(cards, ['bug'], '', 2);
  assert.equal(shown.length, 2);
  assert.deepEqual(
    shown.map((c) => c.title),
    ['Fix the login page', 'Write the office guide'],
  );
});
