import test from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_ENTER, SHIFT_ENTER, enterKeyAction, modifiedEnter, wantsCsiEnter, type KeyEventLike } from '../src/client/term-keys.js';

function key(type: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { type, key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods };
}

test('only Droid agents get CSI u Enter', () => {
  assert.equal(wantsCsiEnter('agent', 'droid'), true);
  for (const p of ['claude', 'codex', 'opencode', 'custom', undefined] as const) assert.equal(wantsCsiEnter('agent', p), false, String(p));
  assert.equal(wantsCsiEnter('shell', 'droid'), false);
  assert.equal(wantsCsiEnter(undefined, undefined), false);
});

test('Ctrl+Enter and Shift+Enter encode as CSI u; other Enters keep the default', () => {
  assert.equal(modifiedEnter(true, { ctrl: true }), CTRL_ENTER);
  assert.equal(CTRL_ENTER, '\x1b[13;5u');
  assert.equal(modifiedEnter(true, { shift: true }), SHIFT_ENTER);
  assert.equal(SHIFT_ENTER, '\x1b[13;2u');
  assert.equal(modifiedEnter(true, {}), undefined);
  assert.equal(modifiedEnter(true, { alt: true }), undefined);
  assert.equal(modifiedEnter(true, { ctrl: true, alt: true }), undefined);
  assert.equal(modifiedEnter(true, { ctrl: true, meta: true }), undefined);
  assert.equal(modifiedEnter(true, { ctrl: true, shift: true }), undefined);
  assert.equal(modifiedEnter(false, { ctrl: true }), undefined);
  assert.equal(modifiedEnter(false, { shift: true }), undefined);
});

test('the DOM key handler sends on keydown and swallows the matching keypress/keyup', () => {
  assert.deepEqual(enterKeyAction(true, key('keydown', { ctrlKey: true })), { do: 'send', data: CTRL_ENTER });
  assert.deepEqual(enterKeyAction(true, key('keypress', { ctrlKey: true })), { do: 'swallow' });
  assert.deepEqual(enterKeyAction(true, key('keyup', { ctrlKey: true })), { do: 'swallow' });
  assert.deepEqual(enterKeyAction(true, key('keydown', { shiftKey: true })), { do: 'send', data: SHIFT_ENTER });
});

test('the DOM key handler leaves plain, Alt, IME and non-Droid Enter to xterm', () => {
  assert.deepEqual(enterKeyAction(true, key('keydown')), { do: 'default' });
  assert.deepEqual(enterKeyAction(true, key('keydown', { altKey: true })), { do: 'default' });
  assert.deepEqual(enterKeyAction(true, key('keydown', { ctrlKey: true, isComposing: true })), { do: 'default' });
  assert.deepEqual(enterKeyAction(false, key('keydown', { ctrlKey: true })), { do: 'default' });
  assert.deepEqual(enterKeyAction(false, key('keydown', { shiftKey: true })), { do: 'default' });
  assert.deepEqual(enterKeyAction(true, { ...key('keydown', { ctrlKey: true }), key: 'a' }), { do: 'default' });
});
