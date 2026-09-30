import test from 'node:test';
import assert from 'node:assert/strict';
import { characterName } from '../src/client/ui/character.js';

test('closing the first character screen keeps the name typed so far', () => {
  assert.equal(characterName('Ada', 'Guest'), 'Ada');
  assert.equal(characterName('  Ada Lovelace the first  ', 'Guest'), 'Ada Lovelace the first');
  assert.equal(characterName('a name that is definitely too long', 'Guest'), 'a name that is definitel');
  assert.equal(characterName('a name that is definitely too long', 'Guest').length, 24);
});

test('a blank name falls back to the saved one, or Guest', () => {
  assert.equal(characterName('', 'Guest'), 'Guest');
  assert.equal(characterName('   ', 'Ada'), 'Ada');
  assert.equal(characterName('\n', 'Guest'), 'Guest');
});
