import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyActivations, PanelClipboard, sameTextSelection, type TextClipboard } from '../src/client/native/keyboard-actions.js';
import { pressOf, terminalBytes } from '../src/client/native/keys.js';

const terminal = () => {
  const bytes: string[] = [];
  const keys = new KeyActivations((id) => {
    const data = terminalBytes(pressOf(id, new Set()), false);
    if (data !== null) bytes.push(data);
  });
  return { keys, bytes };
};

test('a held pointer release types each shell character and Enter once, regardless of hold duration', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { keys, bytes } = terminal();
  for (const [id, hold] of [
    ['a', 50],
    ['b', 800],
    ['Enter', 10000],
  ] as const) {
    keys.pointerDown(id);
    now += hold;
    keys.click(id, 1);
  }
  assert.deepEqual(bytes, ['a', 'b', '\r']);
});

test('keyboard, assistive technology and programmatic click activation still type', () => {
  const { keys, bytes } = terminal();
  keys.click('x', 0);
  keys.click('Enter', 0);
  keys.pointerDown('y');
  keys.click('y', 2);
  keys.click('z', 0);
  assert.deepEqual(bytes, ['x', '\r', 'y', 'z']);
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
