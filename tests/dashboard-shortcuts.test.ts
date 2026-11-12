import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacentFloor, sideStep, WORKSPACE_KEY_HINTS, workspaceCommand, workspaceShortcut } from '../src/client/dashboard-shortcuts.js';

function key(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    repeat: false,
    preventDefault() {},
    stopImmediatePropagation() {},
    ...overrides,
  } as KeyboardEvent;
}

test('native companion floor shortcuts accept plus, equal and minus without taking browser zoom', () => {
  for (const [value, shiftKey, direction] of [
    ['+', true, 1],
    ['+', false, 1],
    ['=', false, 1],
    ['-', false, -1],
  ] as const) {
    const event = key(value, { shiftKey });
    assert.deepEqual(workspaceCommand(event, true), { action: 'floor', direction });
    assert.equal(workspaceCommand(event), undefined);
    for (const mods of [{ metaKey: false }, { ctrlKey: true }, { altKey: true }, { isComposing: true }, { defaultPrevented: true }]) assert.equal(workspaceCommand({ ...event, ...mods }, true), undefined);
  }
  for (const value of ['-', '=', '_', 'n', 'ArrowUp']) assert.equal(workspaceCommand(key(value, { shiftKey: true }), true), undefined);
});

test('floor shortcuts stop before editor input, never repeat, and leave browser events untouched', () => {
  const calls: string[] = [];
  const event = key('+', { shiftKey: true, preventDefault: () => calls.push('prevent'), stopImmediatePropagation: () => calls.push('stop') });
  assert.equal(
    workspaceShortcut(event, () => calls.push('floor'), true),
    true,
  );
  assert.deepEqual(calls, ['prevent', 'stop', 'floor']);
  calls.length = 0;
  assert.equal(
    workspaceShortcut({ ...event, repeat: true }, () => calls.push('floor'), true),
    true,
  );
  assert.deepEqual(calls, ['prevent', 'stop']);
  calls.length = 0;
  assert.equal(
    workspaceShortcut(event, () => calls.push('floor')),
    false,
  );
  assert.deepEqual(calls, []);
});

test('floor navigation follows saved order and wraps without switching a lone or unknown floor', () => {
  const floors = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
  assert.equal(adjacentFloor(floors, 'c', 1), 'a');
  assert.equal(adjacentFloor(floors, 'a', -1), 'c');
  assert.equal(adjacentFloor(floors, 'b', 1), 'c');
  assert.equal(adjacentFloor(floors, 'c', -1), 'b');
  assert.equal(adjacentFloor(floors, 'missing', 1), undefined);
  assert.equal(adjacentFloor(floors, null, 1), undefined);
  assert.equal(adjacentFloor([], 'c', 1), undefined);
  assert.equal(adjacentFloor([{ id: 'c' }], 'c', -1), undefined);
});

test('Command shortcuts cover workspace actions without Option or Control', () => {
  for (const [i, mode] of ['single', 'split', 'triple', 'grid', 'five', 'six', 'seven', 'eight'].entries()) assert.deepEqual(workspaceCommand(key(String(i + 1))), { action: 'layout', mode });
  for (const [value, action] of [
    ['Enter', 'maximize'],
    ['n', 'hire'],
    ['N', 'hire'],
    ['b', 'board'],
    ['\\', 'sidebar'],
    [',', 'settings'],
    ['o', 'orchestrator'],
    ['O', 'orchestrator'],
  ])
    assert.deepEqual(workspaceCommand(key(value!)), { action });
  for (const [value, action, direction] of [
    ['ArrowLeft', 'pane', -1],
    ['ArrowRight', 'pane', 1],
    ['ArrowUp', 'worker', -1],
    ['ArrowDown', 'worker', 1],
  ] as const)
    assert.deepEqual(workspaceCommand(key(value)), { action, direction });
  assert.ok(WORKSPACE_KEY_HINTS.every(([chord]) => chord.startsWith('⌘ ')));
  assert.equal(WORKSPACE_KEY_HINTS.find(([, label]) => label === 'panes')?.[0], '⌘ ← →');
  assert.equal(WORKSPACE_KEY_HINTS.find(([, label]) => label === 'workers')?.[0], '⌘ ↑ ↓');
  assert.equal(WORKSPACE_KEY_HINTS.find(([, label]) => label === 'layout')?.[0], '⌘ 1–8');
  assert.equal(WORKSPACE_KEY_HINTS.find(([, label]) => label === 'Orchestrator')?.[0], '⌘ O');
});

test('CLI keys, editing shortcuts, IME composition and extra modifiers pass through', () => {
  for (const value of ['1', '5', '8', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'n', 'b', '\\', ']', 'Escape']) {
    for (const mods of [{ metaKey: false }, { metaKey: false, ctrlKey: true }, { metaKey: false, altKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }])
      assert.equal(workspaceCommand(key(value, mods)), undefined, JSON.stringify([value, mods]));
  }
  for (const value of ['c', 'v', 'x', 'a', 'z', 'q', 'w', 'r', '9', '0', 'Escape', 'Tab', ']']) assert.equal(workspaceCommand(key(value)), undefined);
});

test('a recognized chord is stopped before the terminal, including held-key repeats', () => {
  const calls: string[] = [];
  const e = key('Enter', { preventDefault: () => calls.push('prevent'), stopImmediatePropagation: () => calls.push('stop') });
  assert.equal(
    workspaceShortcut(e, (command) => calls.push(command.action)),
    true,
  );
  assert.deepEqual(calls, ['prevent', 'stop', 'maximize']);
  calls.length = 0;
  assert.equal(
    workspaceShortcut({ ...e, repeat: true }, () => calls.push('run')),
    true,
  );
  assert.deepEqual(calls, ['prevent', 'stop']);
  calls.length = 0;
  assert.equal(
    workspaceShortcut({ ...e, metaKey: false }, () => calls.push('run')),
    false,
  );
  assert.deepEqual(calls, []);
});

test('the sidebar’s arrow keys walk Mission Control and the floor as one list, a worker in both once in each', () => {
  // Byte is the Orchestrator’s subagent on this floor, so it has a row under Mission Control and one in the floor’s list.
  const row = (id: string, list: string) => ({ id, button: { list, id }, opens: true });
  const rows = [row('orchestrator', 'mission'), row('w-byte', 'mission'), row('bot-claw', 'mission'), row('w-ada', 'floor'), row('w-byte', 'floor'), row('w-cy', 'floor')];
  const step = (from: number | undefined, focused: string, direction: -1 | 1) => {
    const next = sideStep(rows, from === undefined ? undefined : rows[from]!.button, focused, direction);
    return next && rows.indexOf(next);
  };
  assert.equal(step(4, 'w-byte', 1), 5, 'down from Byte’s floor row stays in the floor’s list');
  assert.equal(step(4, 'w-byte', -1), 3);
  assert.equal(step(1, 'w-byte', 1), 2, 'down from its Mission Control row stays there');
  assert.equal(step(5, '', 1), 0, 'wraps at the end');
  assert.equal(step(0, '', -1), 5, 'and at the start');
  assert.equal(step(undefined, 'w-ada', 1), 4, 'with the keyboard elsewhere, from the open worker');
  assert.equal(step(undefined, '', 1), 0, 'from nowhere, down is the first row');
  assert.equal(step(undefined, '', -1), 5, 'and up the last');
  assert.equal(sideStep([], undefined, '', 1), undefined);
});

test('directory search keeps Command caret movement and cannot change hidden workspace panes', () => {
  for (const value of ['1', '2', '3', '4', '5', '6', '7', '8', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '\\']) {
    const calls: string[] = [];
    const e = key(value, { preventDefault: () => calls.push('prevent'), stopImmediatePropagation: () => calls.push('stop') });
    assert.equal(
      workspaceShortcut(e, (command) => calls.push(command.action), false, 'directory'),
      false,
      value,
    );
    assert.deepEqual(calls, [], value);
  }
});

test('directory mode keeps global Settings, hire, Whiteboard, Orchestrator and native floor shortcuts', () => {
  for (const [value, action] of [
    ['n', 'hire'],
    ['b', 'board'],
    [',', 'settings'],
    ['o', 'orchestrator'],
    ['=', 'floor'],
  ]) {
    const calls: string[] = [];
    const e = key(value!, { preventDefault: () => calls.push('prevent'), stopImmediatePropagation: () => calls.push('stop') });
    assert.equal(
      workspaceShortcut(e, (command) => calls.push(command.action), true, 'directory'),
      true,
    );
    assert.deepEqual(calls, ['prevent', 'stop', action]);
  }
});
