import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_KEY_HINTS, workspaceCommand, workspaceShortcut } from '../src/client/dashboard-shortcuts.js';

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

test('Command shortcuts cover workspace actions without Option or Control', () => {
  for (const [i, mode] of ['single', 'split', 'triple', 'grid', 'five', 'six', 'seven', 'eight'].entries()) assert.deepEqual(workspaceCommand(key(String(i + 1))), { action: 'layout', mode });
  for (const [value, action] of [
    ['Enter', 'maximize'],
    ['n', 'hire'],
    ['N', 'hire'],
    ['b', 'board'],
    ['\\', 'sidebar'],
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
