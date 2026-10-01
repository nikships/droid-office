import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyActivations, PanelClipboard, sameTextSelection, type TextClipboard } from '../src/client/native/keyboard-actions.js';
import { pressOf } from '../src/client/native/keys.js';

/** The presses a sign-in field would receive, as the keyboard types them. */
const field = () => {
  const typed: string[] = [];
  const keys = new KeyActivations((id) => typed.push(pressOf(id, new Set()).key));
  return { keys, typed };
};

test('a held pointer release types each character and Enter once, regardless of hold duration', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { keys, typed } = field();
  for (const [id, hold] of [
    ['a', 50],
    ['b', 800],
    ['Enter', 10000],
  ] as const) {
    keys.pointerDown(id);
    now += hold;
    keys.click(id, 1);
  }
  assert.deepEqual(typed, ['a', 'b', 'Enter']);
});

test('keyboard, assistive technology and programmatic click activation still type', () => {
  const { keys, typed } = field();
  keys.click('x', 0);
  keys.click('Enter', 0);
  keys.pointerDown('y');
  keys.click('y', 2);
  keys.click('z', 0);
  assert.deepEqual(typed, ['x', 'Enter', 'y', 'z']);
});

test('Cut keeps text until the system clipboard confirms writing it', async () => {
  const panel = new PanelClipboard();
  let finish: (() => void) | undefined;
  const writes: string[] = [];
  const clipboard: TextClipboard = {
    writeText: (text) => {
      writes.push(text);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    readText: async () => '',
  };
  let text = 'worker prompt';
  const cutting = panel.cut(text, clipboard, () => {
    text = '';
  });
  assert.equal(text, 'worker prompt');
  assert.deepEqual(writes, ['worker prompt']);
  finish?.();
  assert.equal(await cutting, true);
  assert.equal(text, '');
});

test('an unavailable or denied clipboard never deletes a prompt; its panel copy remains available', async () => {
  const panel = new PanelClipboard();
  let removed = 0;
  const denied: TextClipboard = {
    writeText: async () => {
      throw new Error('permission denied');
    },
    readText: async () => {
      throw new Error('permission denied');
    },
  };
  assert.equal(await panel.cut('first prompt', undefined, () => removed++), false);
  assert.equal(removed, 0);
  assert.deepEqual(await panel.read(undefined), { text: 'first prompt', system: false });
  assert.equal(await panel.cut('second prompt', denied, () => removed++), false);
  assert.equal(removed, 0);
  assert.deepEqual(await panel.read(denied), { text: 'second prompt', system: false });
});

test('clipboard responses do not apply over an edited prompt or a moved selection', async () => {
  const panel = new PanelClipboard();
  const before = { value: 'worker prompt', start: 0, end: 6 };
  let current = { ...before };
  let finish: (() => void) | undefined;
  const clipboard: TextClipboard = {
    writeText: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    readText: async () => '',
  };
  let removed = false;
  const cutting = panel.cut('worker', clipboard, () => {
    if (sameTextSelection(before, current)) removed = true;
  });
  current = { ...before, value: 'worker prompt edited' };
  finish?.();
  await cutting;
  assert.equal(removed, false);
  assert.equal(sameTextSelection(before, { ...before, start: 1 }), false);
  assert.equal(sameTextSelection(before, { ...before, end: 7 }), false);
  assert.equal(sameTextSelection(before, { ...before }), true);
});

test('Paste prefers the system clipboard and reports missing data instead of inventing text', async () => {
  const panel = new PanelClipboard();
  assert.equal(await panel.read(undefined), null);
  await panel.write('old panel copy', undefined);
  const clipboard: TextClipboard = { writeText: async () => {}, readText: async () => 'new system copy' };
  assert.deepEqual(await panel.read(clipboard), { text: 'new system copy', system: true });
});
