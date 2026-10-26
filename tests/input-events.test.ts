import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BINDING_NAME, MAX_PAYLOAD, parseHostMessage, trustedContext } from '../src/desktop/input-bridge.ts';
import { BUTTON, captured, cdpModifiers, electronModifiers, MOD, type NativeKey, type NativeScroll, mouseButton, mouseEvent, pointerAt, WHEEL_LINE_PX, wheelEvent } from '../src/desktop/input-events.ts';
import { cdpFlagEvents, cdpKeyEvent, domCode, editCommand, IME_KEY_CODE, keyInfo, modifierFlag } from '../src/desktop/input-keys.ts';
import { PointerLock } from '../src/desktop/input-lock.ts';

const key = (over: Partial<NativeKey>): NativeKey => ({ type: 'key', kind: 'down', keyCode: 0, chars: '', base: '', mods: 0, repeat: false, handled: false, commands: [], ...over });

test('modifier masks become Electron names and Chromium bits', () => {
  assert.deepEqual(electronModifiers(MOD.shift | MOD.meta, BUTTON.left | BUTTON.middle), ['shift', 'meta', 'leftbuttondown', 'middlebuttondown']);
  assert.deepEqual(electronModifiers(0), []);
  assert.equal(cdpModifiers(MOD.alt | MOD.ctrl | MOD.meta | MOD.shift), 15);
  assert.equal(cdpModifiers(MOD.caps), 0);
  assert.equal(cdpModifiers(MOD.meta), 4);
});

test('mouse buttons: 0 left, 1 right, 2 middle', () => {
  assert.deepEqual([0, 1, 2, 9].map(mouseButton), ['left', 'right', 'middle', 'left']);
});

test('a captured move keeps the cursor where it is and moves the virtual screen position by the raw delta', () => {
  const start = pointerAt(300, 200);
  const a = captured(start, 12, -5);
  const b = captured(a, -300, 40);
  assert.deepEqual([a.x, a.y, a.gx, a.gy], [300, 200, 312, 195]);
  assert.deepEqual([b.x, b.y, b.gx, b.gy], [300, 200, 12, 235]);
  // Blink measures movement between two events' screen positions: exactly the deltas given.
  assert.deepEqual([b.gx - a.gx, b.gy - a.gy], [-300, 40]);
  const e = mouseEvent(b, 'mouseMove', { buttons: BUTTON.left });
  assert.deepEqual([e.type, e.x, e.y, e.globalX, e.globalY], ['mouseMove', 300, 200, 12, 235]);
  assert.deepEqual(e.modifiers, ['leftbuttondown']);
});

test('a click carries its button and click count', () => {
  const e = mouseEvent(pointerAt(10, 20), 'mouseDown', { button: 1, buttons: BUTTON.right, clickCount: 2, mods: MOD.shift });
  assert.equal(e.button, 'right');
  assert.equal(e.clickCount, 2);
  assert.deepEqual(e.modifiers, ['shift', 'rightbuttondown']);
});

test('wheel deltas keep the sign AppKit gave them, and a notch is worth a line of pixels', () => {
  const base: NativeScroll = { type: 'scroll', x: 5, y: 6, dx: 0, dy: 2, precise: false, mods: 0 };
  const notch = wheelEvent(base, { x: 5, y: 6 });
  assert.equal(notch.deltaY, 2 * WHEEL_LINE_PX);
  assert.equal(notch.wheelTicksY, 2);
  assert.equal(notch.hasPreciseScrollingDeltas, false);
  const pad = wheelEvent({ ...base, dx: -3, dy: 7.5, precise: true }, { x: 5, y: 6 });
  assert.deepEqual([pad.deltaX, pad.deltaY, pad.hasPreciseScrollingDeltas], [-3, 7.5, true]);
  assert.equal(pad.wheelTicksY, 7.5 / WHEEL_LINE_PX);
});

test('physical keys map to DOM codes, and the table has no holes for the keys the office uses', () => {
  assert.equal(domCode(0x0d), 'KeyW');
  assert.equal(domCode(0x31), 'Space');
  assert.equal(domCode(0x35), 'Escape');
  assert.equal(domCode(0x7b), 'ArrowLeft');
  assert.equal(domCode(0x24), 'Enter');
  assert.equal(domCode(0x4c), 'NumpadEnter');
  assert.equal(domCode(0xff), '');
  for (const [code, vk] of [
    [0x00, 65],
    [0x12, 49],
    [0x1d, 48],
    [0x7a, 112],
    [0x6f, 123],
    [0x52, 96],
    [0x5c, 105],
    [0x27, 222],
    [0x2b, 188],
    [0x24, 13],
    [0x33, 8],
    [0x30, 9],
    [0x31, 32],
  ] as const)
    assert.equal(keyInfo(code, '', '', 0).vk, vk, `key ${code}`);
});

test('a letter types its character, with Shift applied', () => {
  assert.deepEqual(keyInfo(0x0d, 'w', 'w', 0), { code: 'KeyW', key: 'w', vk: 87, location: 0, text: 'w' });
  assert.deepEqual(keyInfo(0x0d, 'W', 'W', MOD.shift), { code: 'KeyW', key: 'W', vk: 87, location: 0, text: 'W' });
  // Option makes it another character, which is what the page types.
  assert.equal(keyInfo(0x01, 'ß', 's', MOD.alt).key, 'ß');
});

test('a shortcut types nothing, and Control takes the letter back from the control character', () => {
  const ctrlC = keyInfo(0x08, '\u0003', 'c', MOD.ctrl);
  assert.equal(ctrlC.key, 'c');
  assert.equal(ctrlC.text, '');
  const cmdV = keyInfo(0x09, 'v', 'v', MOD.meta);
  assert.deepEqual([cmdV.key, cmdV.text], ['v', '']);
});

test('named keys: Enter types a return, arrows and function keys type nothing', () => {
  assert.deepEqual(keyInfo(0x24, '\r', '\r', 0), { code: 'Enter', key: 'Enter', vk: 13, location: 0, text: '\r' });
  const left = keyInfo(0x7b, '\uf702', '\uf702', 0);
  assert.deepEqual([left.key, left.text, left.vk], ['ArrowLeft', '', 37]);
  const f5 = keyInfo(0x60, '\uf708', '\uf708', 0);
  assert.deepEqual([f5.key, f5.text, f5.vk], ['F5', '', 116]);
  assert.equal(keyInfo(0x30, '\t', '\t', 0).key, 'Tab');
  assert.equal(keyInfo(0x33, '\u007f', '\u007f', 0).key, 'Backspace');
  assert.equal(keyInfo(0x75, '\uf728', '\uf728', 0).key, 'Delete');
});

test('left, right and numpad keys say which one they are', () => {
  assert.equal(keyInfo(0x38, '', '', MOD.shift).location, 1);
  assert.equal(keyInfo(0x3c, '', '', MOD.shift).location, 2);
  assert.equal(keyInfo(0x52, '0', '0', 0).location, 3);
  assert.equal(keyInfo(0x52, '0', '0', 0).key, '0');
  assert.equal(keyInfo(0x0d, 'w', 'w', 0).location, 0);
});

test('the CDP key event for a typed key carries its text, and a shortcut is a raw key down', () => {
  const typed = cdpKeyEvent(key({ keyCode: 0x00, chars: 'a', base: 'a', repeat: true }));
  assert.deepEqual([typed.type, typed.key, typed.code, typed.text, typed.autoRepeat, typed.windowsVirtualKeyCode], ['keyDown', 'a', 'KeyA', 'a', true, 65]);
  const shortcut = cdpKeyEvent(key({ keyCode: 0x00, chars: 'a', base: 'a', mods: MOD.meta }));
  assert.deepEqual([shortcut.type, shortcut.text, shortcut.modifiers], ['rawKeyDown', undefined, 4]);
  const up = cdpKeyEvent(key({ kind: 'up', keyCode: 0x00, chars: 'a', base: 'a' }));
  assert.deepEqual([up.type, up.text], ['keyUp', undefined]);
});

test('editing commands from the input system ride along as Blink commands', () => {
  assert.equal(editCommand('moveToBeginningOfLine:'), 'MoveToBeginningOfLine');
  assert.equal(editCommand('deleteWordBackward:'), 'DeleteWordBackward');
  assert.equal(editCommand(':'), '');
  const e = cdpKeyEvent(key({ keyCode: 0x7b, chars: '\uf702', base: '\uf702', mods: MOD.meta, commands: ['moveToBeginningOfLine:', ''] }));
  assert.deepEqual(e.commands, ['MoveToBeginningOfLine']);
  assert.equal(cdpKeyEvent(key({ keyCode: 0x00, chars: 'a', base: 'a' })).commands, undefined);
});

test('a key the input method took reaches the page as key code 229', () => {
  const down = cdpKeyEvent(key({ keyCode: 0x00, chars: 'a', base: 'a', handled: true }));
  assert.deepEqual([down.type, down.key, down.windowsVirtualKeyCode, down.text], ['rawKeyDown', 'Process', IME_KEY_CODE, undefined]);
  const up = cdpKeyEvent(key({ kind: 'up', keyCode: 0x00, handled: true }));
  assert.deepEqual([up.type, up.windowsVirtualKeyCode], ['keyUp', IME_KEY_CODE]);
});

test('modifier keys press and release by their flag; Caps Lock toggles both', () => {
  assert.equal(modifierFlag('MetaLeft'), MOD.meta);
  assert.equal(modifierFlag('KeyA'), 0);
  const shiftDown = cdpFlagEvents({ type: 'flags', keyCode: 0x38, mods: MOD.shift });
  assert.deepEqual(
    shiftDown.map((e) => [e.type, e.key, e.code, e.modifiers, e.windowsVirtualKeyCode]),
    [['rawKeyDown', 'Shift', 'ShiftLeft', 8, 16]],
  );
  const shiftUp = cdpFlagEvents({ type: 'flags', keyCode: 0x38, mods: 0 });
  assert.deepEqual(
    shiftUp.map((e) => e.type),
    ['keyUp'],
  );
  assert.deepEqual(
    cdpFlagEvents({ type: 'flags', keyCode: 0x39, mods: MOD.caps }).map((e) => e.type),
    ['rawKeyDown', 'keyUp'],
  );
  assert.deepEqual(cdpFlagEvents({ type: 'flags', keyCode: 0x3f, mods: 0 }), []);
});

test('pointer lock: a click earns the lock, a bare request does not', () => {
  const lock = new PointerLock(true);
  assert.deepEqual(lock.request({ raw: false, activation: false }), { ok: false, error: 'NotAllowedError' });
  assert.equal(lock.locked, false);
  assert.deepEqual(lock.request({ raw: true, activation: true }), { ok: true, raw: true });
  assert.equal(lock.locked, true);
  assert.equal(lock.raw, true);
  // Asking again while it is held is fine and changes nothing.
  assert.deepEqual(lock.request({ raw: false, activation: false }), { ok: true, raw: true });
});

test('pointer lock: raw input where the device cannot give it is refused with NotSupportedError, which player.ts retries without', () => {
  const lock = new PointerLock(false);
  assert.deepEqual(lock.request({ raw: true, activation: true }), { ok: false, error: 'NotSupportedError' });
  assert.deepEqual(lock.request({ raw: false, activation: true }), { ok: true, raw: false });
});

test('pointer lock: after the page lets go itself it can take the mouse back with no click, once', () => {
  const lock = new PointerLock(true);
  lock.request({ raw: false, activation: true });
  assert.equal(lock.pageExit(), true);
  assert.equal(lock.pageExit(), false);
  assert.equal(lock.request({ raw: false, activation: false }).ok, true);
  lock.pageExit();
  // A refused or granted request uses up the leave.
  assert.equal(lock.request({ raw: false, activation: false }).ok, true);
  lock.userExit();
  assert.equal(lock.request({ raw: false, activation: false }).ok, false);
});

test('pointer lock: Esc releases on key down, refuses requests while held, and the page keeping the key up relocks', () => {
  const lock = new PointerLock(true);
  lock.request({ raw: false, activation: true });
  assert.equal(lock.escapeDown(), true);
  assert.equal(lock.locked, false);
  // The window an Esc closed asks for the mouse back while the key is still down: refused, as a browser does.
  assert.equal(lock.request({ raw: false, activation: true }).ok, false);
  lock.escapeUp();
  assert.equal(lock.request({ raw: false, activation: true }).ok, true);
  // The page took that key up (preventDefault), so the lock it just took stays.
  assert.equal(lock.escapeUpSeenByPage(true), false);
  assert.equal(lock.locked, true);
});

test('pointer lock: an Esc key up the page did not take lets go, like a browser', () => {
  const lock = new PointerLock(true);
  lock.request({ raw: false, activation: true });
  assert.equal(lock.escapeUpSeenByPage(false), true);
  assert.equal(lock.locked, false);
  assert.equal(lock.escapeUpSeenByPage(false), false);
});

test('pointer lock: losing focus lets go and the next request needs a click again', () => {
  const lock = new PointerLock(true);
  lock.request({ raw: false, activation: true });
  assert.equal(lock.windowBlurred(), true);
  assert.equal(lock.request({ raw: false, activation: false }).ok, false);
  assert.equal(lock.windowBlurred(), false);
});

test('host messages: only the known shapes pass, and size and numbers are checked', () => {
  assert.equal(BINDING_NAME, '__droidOfficeHost');
  assert.deepEqual(parseHostMessage('{"t":"lock","id":3,"raw":true,"activation":false}'), { t: 'lock', id: 3, raw: true, activation: false });
  assert.deepEqual(parseHostMessage('{"t":"exit"}'), { t: 'exit' });
  assert.deepEqual(parseHostMessage('{"t":"escUp","prevented":true}'), { t: 'escUp', prevented: true });
  assert.deepEqual(parseHostMessage('{"t":"editable","on":true,"x":1,"y":2,"w":3,"h":4}'), { t: 'editable', on: true, x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(parseHostMessage('{"t":"keyTrace","on":true}'), { t: 'keyTrace', on: true });
  assert.deepEqual(parseHostMessage('{"t":"keyTrace","on":false,"file":"/etc/passwd"}'), { t: 'keyTrace', on: false });
  // Extra fields are dropped, not forwarded.
  assert.deepEqual(parseHostMessage('{"t":"exit","cmd":"rm -rf /"}'), { t: 'exit' });
  for (const bad of [
    '',
    'not json',
    '[]',
    'null',
    '1',
    '{"t":"nope"}',
    '{"t":"lock"}',
    '{"t":"lock","id":"3","raw":true,"activation":true}',
    '{"t":"lock","id":1,"raw":1,"activation":true}',
    '{"t":"escUp"}',
    '{"t":"keyTrace"}',
    '{"t":"keyTrace","on":"yes"}',
    '{"t":"editable","on":true,"x":1,"y":2,"w":3}',
    '{"t":"editable","on":true,"x":1e9,"y":2,"w":3,"h":4}',
    '{"t":"editable","on":true,"x":"1","y":2,"w":3,"h":4}',
  ])
    assert.equal(parseHostMessage(bad), null, bad);
  assert.equal(parseHostMessage({ t: 'exit' }), null);
  assert.equal(parseHostMessage(`{"t":"exit","pad":"${'x'.repeat(MAX_PAYLOAD)}"}`), null);
});

test('only the office main frame at the office origin may call the binding', () => {
  const origin = 'http://localhost:4600';
  const ok = { id: 4, origin, auxData: { frameId: 'F1', isDefault: true } };
  assert.equal(trustedContext(ok, 'F1', origin), true);
  assert.equal(trustedContext({ ...ok, auxData: { frameId: 'F2', isDefault: true } }, 'F1', origin), false, 'an iframe');
  assert.equal(trustedContext({ ...ok, auxData: { frameId: 'F1', isDefault: false } }, 'F1', origin), false, 'an isolated world');
  assert.equal(trustedContext({ ...ok, origin: 'https://example.com' }, 'F1', origin), false, 'another origin');
  assert.equal(trustedContext({ ...ok, auxData: undefined }, 'F1', origin), false);
  assert.equal(trustedContext(undefined, 'F1', origin), false);
  assert.equal(trustedContext(ok, undefined, origin), false);
  assert.equal(trustedContext(ok, 'F1', undefined), false);
});
