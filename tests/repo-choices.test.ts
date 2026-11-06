import test from 'node:test';
import assert from 'node:assert/strict';
import { repoChoices } from '../src/shared/floors.js';

test('a hire can also work in every other git floor on a branch, never its own, a plain folder or a branchless one', () => {
  const floors = [
    { id: 'office', name: 'droid-office', branch: 'main' },
    { id: 'atlas', name: 'atlas', branch: 'main' },
    { id: 'home', name: 'Home', home: true },
    { id: 'notes', name: 'notes', branch: 'main', plain: true },
    { id: 'sabre', name: 'sabre-mcpservice', branch: 'develop' },
  ];
  assert.deepEqual(repoChoices(floors, 'office'), [
    { id: 'atlas', name: 'atlas' },
    { id: 'sabre', name: 'sabre-mcpservice' },
  ]);
  assert.deepEqual(
    repoChoices(floors, null).map((f) => f.id),
    ['office', 'atlas', 'sabre'],
  );
  assert.deepEqual(repoChoices([floors[0]], 'office'), []);
});
