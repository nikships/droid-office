import test from 'node:test';
import assert from 'node:assert/strict';
import { moveFloor } from '../src/shared/floor-order.js';
import { floorShortcut } from '../src/client/floor-shortcuts.js';

const floors = ['home', 'office', 'web', 'api'].map((id) => ({ id }));

test('one floor moves earlier, later or to the end without changing its identity or mutating the input', () => {
  for (const [id, before, expected] of [
    ['web', 'home', ['web', 'home', 'office', 'api']],
    ['home', 'api', ['office', 'web', 'home', 'api']],
    ['office', null, ['home', 'web', 'api', 'office']],
    ['web', 'web', ['home', 'office', 'web', 'api']],
  ] as const) {
    const result = moveFloor(floors, id, before)!;
    assert.deepEqual(
      result.map((f) => f.id),
      expected,
    );
    assert.equal(
      result.find((f) => f.id === id),
      floors.find((f) => f.id === id),
    );
    assert.deepEqual(
      floors.map((f) => f.id),
      ['home', 'office', 'web', 'api'],
    );
  }
  assert.equal(moveFloor(floors, 'missing', 'home'), undefined);
  assert.equal(moveFloor(floors, 'home', 'missing'), undefined);
  assert.equal(moveFloor(floors, '@roof', null), undefined);
});

test('each shortcut follows the reordered canonical list, not the old number', () => {
  const reordered = moveFloor(floors, 'api', 'home')!;
  for (let i = 0; i < reordered.length; i++) {
    let selected = '';
    const event = { code: `Digit${i + 1}`, metaKey: true, preventDefault() {}, stopImmediatePropagation() {} } as KeyboardEvent;
    assert.equal(
      floorShortcut(event, reordered, (id) => {
        selected = id;
      }),
      true,
    );
    assert.equal(selected, reordered[i].id);
  }
});
