import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fitFont, fitGrid, fitScale, MAX_STEPS, RowAccumulator, SGR, swipeInput, URXVT, UTF8 } from '../android/app/src/main/assets/terminal/input.js';
import { builtFiles, vendoredPaths } from '../tools/android-terminal.mjs';

test("the phone's vendored Ghostty core matches the installed packages (node tools/android-terminal.mjs)", () => {
  for (const [from, to] of vendoredPaths()) assert.ok(readFileSync(from).equals(readFileSync(to)), `${to} is stale: run node tools/android-terminal.mjs`);
});

test("the phone's WebView renderer is built from the shared wterm adapter (node tools/android-terminal.mjs)", () => {
  for (const [to, text] of builtFiles()) assert.equal(readFileSync(to, 'utf8'), text, `${to} is stale: run node tools/android-terminal.mjs`);
});

test('fitGrid counts whole cells within the PTY limits', () => {
  assert.deepEqual(fitGrid(344, 500, 7.5, 13.75), { cols: 45, rows: 36 });
  assert.deepEqual(fitGrid(100, 40, 7.5, 13.75), { cols: 20, rows: 5 });
  assert.deepEqual(fitGrid(9000, 9000, 7.5, 13.75), { cols: 400, rows: 200 });
  assert.equal(fitGrid(0, 500, 7.5, 13.75), null);
  assert.equal(fitGrid(344, 500, 0, 13.75), null);
});

test('fitScale shows the whole grid: the desktop view fits it, the phone view only shrinks it', () => {
  assert.equal(fitScale('desktop', 344, 600, 1376, 400, 2), 0.25);
  assert.equal(fitScale('desktop', 344, 600, 172, 100, 1.92), 1.92);
  assert.equal(fitScale('phone', 344, 600, 172, 100, 1.92), 1);
  assert.equal(fitScale('phone', 344, 600, 688, 100, 1.92), 0.5);
  assert.equal(fitScale('desktop', 344, 600, 0, 0, 2), 1);
});

test('desktop fitting accounts for a rounded row-height plateau in landscape', () => {
  const measured: number[] = [];
  fitFont(2.1, (font) => {
    measured.push(font);
    const rowHeight = font >= 1.6 ? 3.42857 : 2.28571;
    return rowHeight * 39 <= 122;
  });
  assert.equal(measured.at(-1), 1.5);
  assert.ok(measured.length < 8);
  const fits: number[] = [];
  fitFont(12.5, (font) => {
    fits.push(font);
    return true;
  });
  assert.deepEqual(fits, [12.5]);
});

const normal = { alternate: false, mouse: 'none', appCursor: false, encoding: 0 };

test('swipeInput sends arrow keys to a full-screen program that does not read the mouse', () => {
  const alt = { ...normal, alternate: true };
  assert.equal(swipeInput(-2, alt, 1, 1), '\x1b[A\x1b[A');
  assert.equal(swipeInput(1, alt, 1, 1), '\x1b[B');
  assert.equal(swipeInput(-1, { ...alt, appCursor: true }, 1, 1), '\x1bOA');
  assert.equal(swipeInput(1, { ...alt, appCursor: true }, 1, 1), '\x1bOB');
  assert.equal(swipeInput(0, alt, 1, 1), '');
  assert.equal(swipeInput(-100, alt, 1, 1), '\x1b[A'.repeat(MAX_STEPS));
});

test('swipeInput sends wheel events in the encoding the program asked for', () => {
  const mouse = { ...normal, alternate: true, mouse: 'vt200' };
  assert.equal(swipeInput(-1, { ...mouse, encoding: SGR }, 5, 7), '\x1b[<64;5;7M');
  assert.equal(swipeInput(2, { ...mouse, encoding: SGR }, 5, 7), '\x1b[<65;5;7M\x1b[<65;5;7M');
  assert.equal(swipeInput(-1, { ...mouse, encoding: URXVT }, 5, 7), '\x1b[96;5;7M');
  assert.equal(swipeInput(-1, mouse, 5, 7), `\x1b[M${String.fromCharCode(96, 37, 39)}`);
  assert.equal(swipeInput(1, mouse, 300, 7), `\x1b[M${String.fromCharCode(97, 255, 39)}`);
  assert.equal(swipeInput(1, { ...mouse, encoding: UTF8 }, 300, 7), `\x1b[M${String.fromCharCode(97, 332, 39)}`);
  assert.equal(swipeInput(1, { ...mouse, encoding: SGR }, 0, 0), '\x1b[<65;1;1M');
});

test('RowAccumulator turns dragged pixels into whole rows and keeps the rest', () => {
  const r = new RowAccumulator();
  assert.equal(r.add(10, 14), 0);
  assert.equal(r.add(10, 14), 1);
  // 6 px left over from the first row, then 30 px back: -24 px is one row back with 10 px to spare.
  assert.equal(r.add(-30, 14), -1);
  assert.equal(r.add(-4, 14), -1);
  r.reset();
  assert.equal(r.add(13, 14), 0);
  assert.equal(r.add(5, 0), 0);
});
