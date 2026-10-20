import test from 'node:test';
import assert from 'node:assert/strict';
import { floorShortcut } from '../src/client/floor-shortcuts.js';

const floors = Array.from({ length: 12 }, (_, i) => ({ id: `floor-${i + 1}` }));

function key(over: Partial<KeyboardEvent> = {}) {
  const calls: string[] = [];
  const event = {
    code: 'Digit1',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault: () => calls.push('preventDefault'),
    stopImmediatePropagation: () => calls.push('stopImmediatePropagation'),
    ...over,
  } as KeyboardEvent;
  return { event, calls };
}

test('Command+number targets the floor menu number, including 0 for floor 10 and the keypad', () => {
  for (const prefix of ['Digit', 'Numpad']) {
    for (let n = 0; n <= 9; n++) {
      const { event, calls } = key({ code: `${prefix}${n}` });
      assert.equal(
        floorShortcut(event, floors, (id) => calls.push(id)),
        true,
      );
      assert.deepEqual(calls, ['preventDefault', 'stopImmediatePropagation', `floor-${n || 10}`]);
    }
  }
});

test('plain digits, other modifiers, composition and handled events stay with their original controls', () => {
  for (const over of [{ metaKey: false }, { metaKey: false, ctrlKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }, { code: 'KeyR' }, { code: 'Digit10' }]) {
    const { event, calls } = key(over);
    assert.equal(
      floorShortcut(event, floors, (id) => calls.push(id)),
      false,
    );
    assert.deepEqual(calls, []);
  }
});

test('missing floors and the roof have no shortcut, and held keys cannot retrigger a trip', () => {
  for (const available of [[], floors.slice(0, 2)]) {
    const { event, calls } = key({ code: 'Digit3' });
    assert.equal(
      floorShortcut(event, available, (id) => calls.push(id)),
      false,
    );
    assert.deepEqual(calls, []);
  }
  // The caller supplies store.floors, which has no rooftop entry. The next digit must not select it.
  const { event, calls } = key({ code: 'Digit5' });
  assert.equal(
    floorShortcut(event, floors.slice(0, 4), (id) => calls.push(id)),
    false,
  );
  assert.deepEqual(calls, []);
  const held = key({ repeat: true });
  assert.equal(
    floorShortcut(held.event, floors, (id) => held.calls.push(id)),
    true,
  );
  assert.deepEqual(held.calls, ['preventDefault', 'stopImmediatePropagation']);
});
