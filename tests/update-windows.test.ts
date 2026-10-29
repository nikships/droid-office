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

for (const office of [false, true]) {
  for (const companion of [false, true]) {
    test(`an update restores office=${office}, companion=${companion} exactly once`, (t) => {
      const file = fileFor(t);
      assert.equal(takeUpdateWindows(file), undefined);
      saveUpdateWindows(file, { office, companion });
      assert.deepEqual(takeUpdateWindows(file), { office, companion });
      assert.equal(existsSync(file), false);
      assert.equal(takeUpdateWindows(file), undefined, 'a later ordinary launch has no saved update state');
    });
  }
}

test('the snapshot reflects the windows open at install time, not an earlier offer', (t) => {
  const file = fileFor(t);
  saveUpdateWindows(file, { office: true, companion: false });
  saveUpdateWindows(file, { office: false, companion: true });
  assert.deepEqual(takeUpdateWindows(file), { office: false, companion: true });
});

test('a snapshot write failure does not prevent installation', (t) => {
  const file = fileFor(t);
  saveUpdateWindows(file, { office: true, companion: true });
  assert.doesNotThrow(() => saveUpdateWindows(path.join(file, 'snapshot.json'), { office: false, companion: false }));
});

test('invalid update window state is discarded and consumed without affecting future launches', (t) => {
  const file = fileFor(t);
  saveUpdateWindows(file, { office: false, companion: true });
  for (const raw of ['{broken', 'null', '[]', '{}', '{"office":false}', '{"office":"false","companion":true}', '{"office":false,"companion":1}']) {
    writeFileSync(file, raw);
    assert.equal(takeUpdateWindows(file), undefined, raw);
    assert.equal(existsSync(file), false, raw);
  }
});

test('the update captures windows before shutdown and restores them before launch activation can open 3D', () => {
  const main = readFileSync(new URL('../src/desktop/main.ts', import.meta.url), 'utf8');
  assert.match(main, /beforeInstall: \(\) => \{\s*saveUpdateWindows\([\s\S]*?quitting = true;\s*return stopOffice\(true\);/);
  assert.match(main, /app\.on\('activate', \(\) => \{\s*if \(starting \|\|/);
  const restore = main.indexOf('const updateWindows = takeUpdateWindows(updateWindowsFile)');
  assert.ok(restore > main.indexOf('app.requestSingleInstanceLock()'), 'another app instance must not consume the snapshot');
  assert.ok(restore < main.indexOf("show(page('Opening the office…'))", restore), 'the initial splash must honor the saved office state');
  assert.match(main, /if \(updateWindows && !pendingThread\) windowWanted = updateWindows\.office/);
  assert.match(main, /await openOffice\(\);\s*if \(updateWindows\?\.companion && officeUrl\) companion\.open\(officeUrl\);\s*starting = false;\s*hideDockIfNoWindows\(\);/);
});
