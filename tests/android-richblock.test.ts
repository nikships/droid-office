import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BAD_ELEMENTS, doneMessage, failedMessage, fitScale, isUnsafeAttr, KATEX_OPTIONS, naturalWidth } from '../android/app/src/main/assets/richblock/logic.js';
import { VENDORED, vendoredPaths } from '../tools/android-richblock.mjs';

test("the phone's vendored rich block libraries match the installed packages (node tools/android-richblock.mjs)", () => {
  for (const [from, to] of vendoredPaths()) assert.ok(readFileSync(from).equals(readFileSync(to)), `${to} is stale: run node tools/android-richblock.mjs`);
  // Nothing in vendor/ that the script doesn't write: a file a newer package dropped is removed too.
  const vendor = new URL('../android/app/src/main/assets/richblock/vendor/', import.meta.url);
  const present = readdirSync(vendor, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(vendor.pathname, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
  const written = VENDORED.map(([, to]) => to)
    .filter((to) => to.startsWith('richblock/vendor/'))
    .map((to) => to.slice('richblock/vendor/'.length))
    .sort();
  assert.deepEqual(present, written);
  for (const lib of ['mermaid', 'katex'])
    assert.ok(
      VENDORED.some(([, to]) => to === `licenses/${lib}-LICENSE.txt`),
      `${lib}'s license ships with it`,
    );
});

test('the rich block page stays offline: its policy loads nothing but its own files', () => {
  const html = readFileSync(new URL('../android/app/src/main/assets/richblock/index.html', import.meta.url), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /https?:|unsafe-eval|connect-src|img-src/);
});

test('a drawing drops script, embedded documents and HTML, as the web Thread does', () => {
  assert.equal(BAD_ELEMENTS, 'script, foreignObject, iframe, object, embed');
  assert.equal(isUnsafeAttr('onclick', 'x()'), true);
  assert.equal(isUnsafeAttr('ONLOAD', ''), true);
  assert.equal(isUnsafeAttr('href', 'javascript:alert(1)'), true);
  assert.equal(isUnsafeAttr('xlink:href', ' JavaScript:alert(1)'), true);
  assert.equal(isUnsafeAttr('href', 'data:text/html,<script>'), true);
  assert.equal(isUnsafeAttr('href', '#node-1'), false);
  assert.equal(isUnsafeAttr('class', 'node'), false);
  assert.equal(isUnsafeAttr('style', 'max-width: 120px'), false);
});

test("naturalWidth reads a drawing's viewBox width", () => {
  assert.equal(naturalWidth('0 0 320.5 140'), 320.5);
  assert.equal(naturalWidth('-8,-8,200,100'), 200);
  assert.equal(naturalWidth(null), 0);
  assert.equal(naturalWidth('0 0 0 10'), 0);
  assert.equal(naturalWidth('garbage'), 0);
});

test('an equation shrinks to fit the Thread, within reason, and never grows', () => {
  assert.equal(fitScale(300, 200), 1);
  assert.equal(fitScale(300, 600), 0.5);
  assert.equal(fitScale(300, 3000), 0.4);
  assert.equal(fitScale(0, 600), 1);
});

test("an equation's TeX can't link, run HTML or expand without bound", () => {
  assert.equal(KATEX_OPTIONS.trust, false);
  assert.equal(KATEX_OPTIONS.throwOnError, true);
  assert.equal(KATEX_OPTIONS.output, 'html');
  assert.ok(KATEX_OPTIONS.maxExpand <= 1000);
});

test('the page answers each draw request with its height and SVG, or the first line of why not', () => {
  assert.deepEqual(doneMessage(3, 120.2, '<svg/>'), { type: 'done', id: 3, ok: true, height: 121, svg: '<svg/>' });
  assert.deepEqual(failedMessage(4, new Error('Parse error on line 2:\n...')), { type: 'done', id: 4, ok: false, error: 'Parse error on line 2:' });
  assert.deepEqual(failedMessage(5, ''), { type: 'done', id: 5, ok: false, error: 'unknown error' });
});
