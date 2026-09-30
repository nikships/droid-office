import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYBOARD_ROWS, codeOf, editText, insertText, pressOf, shiftedLabel, terminalBytes, type KeyLike, type Modifier, type TextState } from '../src/client/native/keys.js';
import { isNativePath, isNativeSearch } from '../src/client/native/mode.js';
import { CTRL_ENTER, SHIFT_ENTER } from '../src/client/term-keys.js';
import { TERM_FONT_DESKTOP, TERM_FONT_MAX, TERM_FONT_MIN, TERM_FONT_NATIVE, clampTermFont, onTermFontSize, setTermFontSize, stepTermFont, termFontSize, useNativeTermFont } from '../src/client/ui/term-font.js';
import { RETURN_PARAM, loginPath, safeReturnTo } from '../src/shared/return-to.js';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const at = (value: string, start: number, end = start, dir: TextState['dir'] = 'none'): TextState => ({ value, start, end, dir });

// ---- Sign-in return ----

test('the sign-in page returns to same-origin office paths', () => {
  assert.equal(safeReturnTo('/?native=1'), '/?native=1');
  assert.equal(safeReturnTo('/?native=1#board'), '/?native=1#board');
  assert.equal(safeReturnTo('/share?id=abc%20d'), '/share?id=abc%20d');
  assert.equal(safeReturnTo('/'), '/');
});

test('the sign-in page never returns to another site or a non-page', () => {
  const bad = [
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    ' /x',
    'javascript:alert(1)',
    'evil.example',
    '',
    '/login',
    '/login?next=/',
    '/login.html',
    '/join?x=1',
    '/claim',
    '/api/workers',
    '/api',
    '/é',
    `/${'a'.repeat(600)}`,
    null,
    undefined,
    42,
    ['/'],
  ];
  for (const raw of bad) assert.equal(safeReturnTo(raw), '/', JSON.stringify(raw));
  assert.equal(safeReturnTo('//evil', '/?native=1'), '/?native=1');
  // Paths that only start like a blocked one are still pages.
  assert.equal(safeReturnTo('/loginx'), '/loginx');
  assert.equal(safeReturnTo('/apix'), '/apix');
});

test('loginPath remembers where to come back to, round-tripping through URLSearchParams', () => {
  assert.equal(loginPath('/'), '/login');
  assert.equal(loginPath('//evil.example'), '/login');
  const p = loginPath('/?native=1');
  assert.equal(p, '/login?next=%2F%3Fnative%3D1');
  const back = new URL(p, 'https://office.test').searchParams.get(RETURN_PARAM);
  assert.equal(safeReturnTo(back), '/?native=1');
});

// ---- Native mode ----

test('native mode is ?native=1 and nothing else', () => {
  assert.ok(isNativeSearch('?native=1'));
  assert.ok(isNativeSearch('?x=2&native=1'));
  assert.ok(!isNativeSearch(''));
  assert.ok(!isNativeSearch('?native=0'));
  assert.ok(!isNativeSearch('?native=true'));
  assert.ok(isNativePath('/?native=1'));
  assert.ok(isNativePath('/?native=1#x'));
  assert.ok(!isNativePath('/#?native=1'));
  assert.ok(!isNativePath('/'));
});

// ---- Terminal text size ----

test('terminal text size clamps, steps and defaults per mode', (t) => {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  assert.equal(TERM_FONT_DESKTOP, 14);
  assert.equal(termFontSize(), 14);
  assert.equal(clampTermFont(3), TERM_FONT_MIN);
  assert.equal(clampTermFont(99), TERM_FONT_MAX);
  assert.equal(clampTermFont(15.6), 16);
  assert.equal(stepTermFont(14, 1), 16);
  assert.equal(stepTermFont(14, -1), 12);
  assert.equal(stepTermFont(TERM_FONT_MAX, 1), TERM_FONT_MAX);
  assert.equal(stepTermFont(TERM_FONT_MIN, -1), TERM_FONT_MIN);

  setTermFontSize(18);
  assert.equal(termFontSize(), 18);

  useNativeTermFont();
  // The headset keeps its own choice, apart from the desktop's.
  assert.equal(termFontSize(), TERM_FONT_NATIVE);
  assert.equal(clampTermFont(Number.NaN), TERM_FONT_NATIVE);
  const heard: number[] = [];
  const off = onTermFontSize((px) => heard.push(px));
  setTermFontSize(100);
  off();
  setTermFontSize(22);
  assert.deepEqual(heard, [TERM_FONT_MAX]);
  assert.equal(termFontSize(), 22);
  assert.equal(store.get('droid-office.term-font'), '18');
  store.set('droid-office.term-font.native', 'garbage');
  assert.equal(termFontSize(), TERM_FONT_NATIVE);
});

// ---- Keys ----

test('the keyboard has every key a terminal needs', () => {
  const ids = new Set(KEYBOARD_ROWS.flat().map((k) => k.id));
  for (const id of ['Escape', 'Tab', 'Enter', 'Backspace', 'Delete', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'mod:ctrl', 'mod:alt', 'mod:shift', 'hide']) {
    assert.ok(ids.has(id), id);
  }
  for (const c of "abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./") assert.ok(ids.has(c), c);
  assert.equal(shiftedLabel({ id: 'a', label: 'a' }), 'A');
  assert.equal(shiftedLabel({ id: '2', label: '2' }), '@');
  assert.equal(shiftedLabel({ id: 'Enter', label: 'Enter' }), 'Enter');
});

test('presses carry the latched modifiers and shifted characters', () => {
  const mods = (...m: Modifier[]) => new Set<Modifier>(m);
  assert.deepEqual(pressOf('a', mods()), key('a'));
  assert.deepEqual(pressOf('a', mods('shift')), key('A', { shiftKey: true }));
  assert.deepEqual(pressOf('1', mods('shift')), key('!', { shiftKey: true }));
  assert.deepEqual(pressOf('c', mods('ctrl')), key('c', { ctrlKey: true }));
  assert.deepEqual(pressOf('Enter', mods('shift', 'alt')), key('Enter', { shiftKey: true, altKey: true }));
});

test('codes match what a physical keyboard reports', () => {
  assert.equal(codeOf('w'), 'KeyW');
  assert.equal(codeOf('W'), 'KeyW');
  assert.equal(codeOf('7'), 'Digit7');
  assert.equal(codeOf('&'), 'Digit7');
  assert.equal(codeOf(' '), 'Space');
  assert.equal(codeOf('?'), 'Slash');
  assert.equal(codeOf('Enter'), 'Enter');
  assert.equal(codeOf('ArrowUp'), 'ArrowUp');
});

test('terminal bytes are what a physical keyboard sends', () => {
  assert.equal(terminalBytes(key('a'), false), 'a');
  assert.equal(terminalBytes(key('A', { shiftKey: true }), false), 'A');
  assert.equal(terminalBytes(key('c', { ctrlKey: true }), false), '\x03');
  assert.equal(terminalBytes(key('d', { ctrlKey: true }), false), '\x04');
  assert.equal(terminalBytes(key('Enter'), false), '\r');
  assert.equal(terminalBytes(key('Escape'), false), '\x1b');
  assert.equal(terminalBytes(key('Tab'), false), '\t');
  assert.equal(terminalBytes(key('Backspace'), false), '\x7f');
  assert.equal(terminalBytes(key('ArrowUp'), false), '\x1b[A');
  assert.equal(terminalBytes(key('ArrowLeft'), false), '\x1b[D');
  assert.equal(terminalBytes(key('b', { altKey: true }), false), '\x1bb');
  // Droid workers bind Ctrl+Enter and Shift+Enter to CSI u; others get plain Enter.
  assert.equal(terminalBytes(key('Enter', { ctrlKey: true }), true), CTRL_ENTER);
  assert.equal(terminalBytes(key('Enter', { shiftKey: true }), true), SHIFT_ENTER);
  assert.equal(terminalBytes(key('Enter', { shiftKey: true }), false), '\r');
});

test('application cursor mode sends SS3 cursor keys, as xterm does', () => {
  assert.equal(terminalBytes(key('ArrowUp'), false, true), '\x1bOA');
  assert.equal(terminalBytes(key('ArrowLeft'), false, true), '\x1bOD');
  assert.equal(terminalBytes(key('Home'), false, true), '\x1bOH');
  assert.equal(terminalBytes(key('End'), false, true), '\x1bOF');
  // Modified cursor keys and everything else are the same in both modes.
  assert.equal(terminalBytes(key('ArrowLeft', { ctrlKey: true }), false, true), '\x1b[1;5D');
  assert.equal(terminalBytes(key('Delete'), false, true), '\x1b[3~');
  assert.equal(terminalBytes(key('a'), false, true), 'a');
});

// ---- Text editing ----

test('typing replaces the selection and moves the caret', () => {
  assert.deepEqual(editText(at('ab', 1), key('x'), false), { value: 'axb', start: 2, end: 2, dir: 'none', changed: true, inputType: 'insertText', inserted: 'x' });
  assert.equal(editText(at('hello', 1, 4), key('X', { shiftKey: true }), false)?.value, 'hXo');
  assert.equal(insertText(at('ab', 2), 'cd').value, 'abcd');
  assert.equal(insertText(at('ab', 9, 12), '!').value, 'ab!');
});

test('Backspace and Delete remove a character, a word or the selection', () => {
  assert.equal(editText(at('abc', 3), key('Backspace'), false)?.value, 'ab');
  assert.equal(editText(at('abc', 0), key('Backspace'), false)?.changed, false);
  assert.equal(editText(at('abc', 0), key('Delete'), false)?.value, 'bc');
  assert.equal(editText(at('abc', 3), key('Delete'), false)?.changed, false);
  assert.equal(editText(at('abcd', 1, 3), key('Backspace'), false)?.value, 'ad');
  const word = editText(at('git commit -m', 10), key('Backspace', { ctrlKey: true }), false);
  assert.equal(word?.value, 'git  -m');
  assert.equal(word?.inputType, 'deleteWordBackward');
  assert.equal(editText(at('one two', 0), key('Delete', { altKey: true }), false)?.value, ' two');
  // An emoji is one character.
  const e = editText(at('a😀', 3), key('Backspace'), false);
  assert.equal(e?.value, 'a');
  assert.equal(e?.start, 1);
});

test('arrows, Home and End move and extend the selection', () => {
  const s = at('hello world', 5);
  assert.deepEqual(editText(s, key('ArrowLeft'), false), { value: 'hello world', start: 4, end: 4, dir: 'none', changed: false });
  const sel = editText(s, key('ArrowRight', { shiftKey: true }), false);
  assert.deepEqual([sel?.start, sel?.end, sel?.dir], [5, 6, 'forward']);
  const back = editText(s, key('ArrowLeft', { shiftKey: true, ctrlKey: true }), false);
  assert.deepEqual([back?.start, back?.end, back?.dir], [0, 5, 'backward']);
  // With a selection, a plain arrow collapses to that side.
  assert.equal(editText(at('hello', 1, 4), key('ArrowLeft'), false)?.start, 1);
  assert.equal(editText(at('hello', 1, 4), key('ArrowRight'), false)?.start, 4);
  assert.equal(editText(s, key('ArrowRight', { ctrlKey: true }), false)?.start, 11);
  assert.equal(editText(s, key('Home'), false)?.start, 0);
  const end = editText(s, key('End', { shiftKey: true }), false);
  assert.deepEqual([end?.start, end?.end], [5, 11]);
  assert.deepEqual(editText(s, key('a', { ctrlKey: true }), false), { value: 'hello world', start: 0, end: 11, dir: 'forward', changed: false });
});

test('multi-line fields move by line and take Enter as a newline', () => {
  const v = 'first\nsecond line\nx';
  assert.equal(editText(at(v, 8), key('Home'), true)?.start, 6);
  assert.equal(editText(at(v, 8), key('End'), true)?.start, 17);
  assert.equal(editText(at(v, 8), key('Home', { ctrlKey: true }), true)?.start, 0);
  assert.equal(editText(at(v, 8), key('ArrowUp'), true)?.start, 2);
  assert.equal(editText(at(v, 16), key('ArrowDown'), true)?.start, 19);
  assert.equal(editText(at(v, 2), key('ArrowUp'), true)?.start, 0);
  assert.equal(editText(at(v, 19), key('ArrowDown'), true)?.start, 19);
  const nl = editText(at('ab', 1), key('Enter'), true);
  assert.equal(nl?.value, 'a\nb');
  assert.equal(nl?.inputType, 'insertLineBreak');
  // One-line fields leave Enter (form submit), Up/Down jump to the ends.
  assert.equal(editText(at('ab', 1), key('Enter'), false), null);
  assert.equal(editText(at('ab', 1), key('ArrowUp'), false)?.start, 0);
  assert.equal(editText(at('ab', 1), key('ArrowDown'), false)?.start, 2);
});

test('keys a field does not edit are left to the page', () => {
  for (const k of [key('Escape'), key('Tab'), key('c', { ctrlKey: true }), key('v', { ctrlKey: true }), key('F5'), key('Enter', { ctrlKey: true }), key('a', { metaKey: true })]) {
    assert.equal(editText(at('abc', 1), k, true), null, k.key);
  }
});
