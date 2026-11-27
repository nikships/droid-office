import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_DEFAULTS, followTerminalPrefs, isDefaultTerminalPrefs, normalizeTerminalPrefs, setTerminalPrefs, resetTerminalPrefs, terminalOptions } from '../src/client/ui/terminal-prefs.js';

test('nothing saved, or something that is not an object, is the defaults', () => {
  for (const raw of [undefined, null, 'block', 7, [], [{ cursorStyle: 'bar' }]]) assert.deepEqual(normalizeTerminalPrefs(raw), TERMINAL_DEFAULTS);
  assert.deepEqual(TERMINAL_DEFAULTS, { lineHeight: 'default', cursorStyle: 'block', cursorBlink: true, scrollSpeed: 'default', optionIsMeta: true });
  assert.equal(isDefaultTerminalPrefs(normalizeTerminalPrefs({})), true);
});

test('values that are unknown, mistyped or for another setting fall back to their default', () => {
  const prefs = normalizeTerminalPrefs({ lineHeight: 'relaxed', cursorStyle: 'beam', cursorBlink: 'false', smoothScroll: false, scrollSpeed: 2, optionIsMeta: false, extra: 1 });
  assert.deepEqual(prefs, { lineHeight: 'relaxed', cursorStyle: 'block', cursorBlink: true, scrollSpeed: 'default', optionIsMeta: false });
  assert.equal('extra' in prefs, false);
  assert.equal('smoothScroll' in prefs, false);
  assert.equal(isDefaultTerminalPrefs(prefs), false);
});

test('the defaults open a terminal with native scroll speed', () => {
  for (const engine of ['xterm', 'ghostty', '?']) assert.deepEqual(normalizeTerminalPrefs({ engine }), TERMINAL_DEFAULTS);
  assert.deepEqual(terminalOptions(TERMINAL_DEFAULTS), { lineHeight: 1.1, cursorStyle: 'block', cursorBlink: true, scrollSensitivity: 1, macOptionIsMeta: true });
});

test('each choice sets its terminal option', () => {
  const opts = terminalOptions(normalizeTerminalPrefs({ lineHeight: 'compact', cursorStyle: 'underline', cursorBlink: false, scrollSpeed: 'fast', optionIsMeta: false }));
  assert.deepEqual(opts, { lineHeight: 1, cursorStyle: 'underline', cursorBlink: false, scrollSensitivity: 2, macOptionIsMeta: false });
  assert.equal(terminalOptions(normalizeTerminalPrefs({ lineHeight: 'relaxed' })).lineHeight, 1.25);
  assert.equal(terminalOptions(normalizeTerminalPrefs({ scrollSpeed: 'slow' })).scrollSensitivity, 0.5);
  assert.equal(terminalOptions(normalizeTerminalPrefs({ cursorStyle: 'bar' })).cursorStyle, 'bar');
});

test('an open terminal follows every change, re-fits only when its rows change height, and keeps its fixed options', (t) => {
  t.after(resetTerminalPrefs);
  const term = { options: { ...terminalOptions(), fontSize: 14 } };
  let resized = 0;
  const off = followTerminalPrefs(term as never, { fixed: { cursorBlink: false }, resized: () => resized++ });
  setTerminalPrefs({ cursorStyle: 'bar' });
  assert.equal(term.options.cursorStyle, 'bar');
  assert.equal(term.options.cursorBlink, false, 'a fixed option wins over the choice');
  assert.equal(term.options.fontSize, 14, 'text size is left to its own setting');
  assert.equal(resized, 0, 'nothing that sizes a cell changed');
  setTerminalPrefs({ lineHeight: 'relaxed' });
  assert.equal(term.options.lineHeight, 1.25);
  assert.equal(resized, 1);
  setTerminalPrefs({ scrollSpeed: 'slow' });
  assert.equal(term.options.scrollSensitivity, 0.5);
  assert.equal(resized, 1);
  off();
  setTerminalPrefs({ cursorStyle: 'underline' });
  assert.equal(term.options.cursorStyle, 'bar', 'a closed terminal hears nothing more');
});
