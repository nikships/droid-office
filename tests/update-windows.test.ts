import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveUpdateWindows, takeUpdateWindows } from '../src/desktop/update-windows.js';

function fileFor(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'update-windows-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'profile', 'update-windows.json');
}

for (const open of [false, true]) {
  test(`an update restores open=${open} exactly once`, (t) => {
    const file = fileFor(t);
    assert.equal(takeUpdateWindows(file), undefined);
    saveUpdateWindows(file, { open });
    assert.deepEqual(takeUpdateWindows(file), { open });
    assert.equal(existsSync(file), false);
    assert.equal(takeUpdateWindows(file), undefined, 'a later ordinary launch has no saved update state');
  });
}

test('the snapshot reflects the window at install time, not an earlier offer', (t) => {
  const file = fileFor(t);
  saveUpdateWindows(file, { open: true });
  saveUpdateWindows(file, { open: false });
  assert.deepEqual(takeUpdateWindows(file), { open: false });
});

test('a snapshot write failure does not prevent installation', (t) => {
  const file = fileFor(t);
  saveUpdateWindows(file, { open: true });
  assert.doesNotThrow(() => saveUpdateWindows(path.join(file, 'snapshot.json'), { open: false }));
});

test('the previous release saved a flag for each window; its session carries over', (t) => {
  const file = fileFor(t);
  saveUpdateWindows(file, { open: false });
  takeUpdateWindows(file);
  const cases: [string, unknown][] = [
    ['{"office":true,"companion":false}', { open: true, mode: 'office' }],
    ['{"office":false,"companion":true}', { open: true, mode: 'companion' }],
    ['{"office":true,"companion":true}', { open: true, mode: 'office' }],
    ['{"office":false,"companion":false}', { open: false }],
  ];
  for (const [raw, expected] of cases) {
    writeFileSync(file, raw);
    assert.deepEqual(takeUpdateWindows(file), expected, raw);
    assert.equal(existsSync(file), false, raw);
  }
});

test('invalid update window state is discarded and consumed without affecting future launches', (t) => {
  const file = fileFor(t);
  saveUpdateWindows(file, { open: true });
  for (const raw of ['{broken', 'null', '[]', '{}', '{"open":"true"}', '{"office":false}', '{"office":"false","companion":true}', '{"office":false,"companion":1}']) {
    writeFileSync(file, raw);
    assert.equal(takeUpdateWindows(file), undefined, raw);
    assert.equal(existsSync(file), false, raw);
  }
});

test('the update captures the window before shutdown and restores it before launch activation can open one', () => {
  const main = readFileSync(new URL('../src/desktop/main.ts', import.meta.url), 'utf8');
  assert.match(main, /beforeInstall: \(\) => \{\s*saveUpdateWindows\([\s\S]*?quitting = true;\s*return stopOffice\(true\);/);
  assert.match(main, /app\.on\('activate', \(\) => \{\s*if \(starting \|\|/);
  const restore = main.indexOf('const updateWindows = takeUpdateWindows(updateWindowsFile)');
  assert.ok(restore > main.indexOf('app.requestSingleInstanceLock()'), 'another app instance must not consume the snapshot');
  assert.ok(restore < main.indexOf("show(page('Opening the office…'))", restore), 'the initial splash must honor the saved window state');
  assert.match(main, /if \(updateWindows && !pendingThread\) windowWanted = updateWindows\.open/);
  assert.match(main, /await openOffice\(\);\s*starting = false;\s*hideDockIfNoWindows\(\);/);
});
