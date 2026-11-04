import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('companions open worker panes or a list instead of the 3D floor', () => {
  const web = readFileSync(new URL('../src/client/dashboard.ts', import.meta.url), 'utf8');
  const android = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/ui/MainTabs.kt', import.meta.url), 'utf8');
  assert.doesNotMatch(web, /office-map|OfficeMap/);
  assert.match(web, /function paintWorkspace\(\)/);
  assert.match(web, /createPane\(paneHost, i\)/);
  assert.match(android, /MainTab\.Office -> HomeScreen\(/);
  assert.doesNotMatch(android, /MainTab\.Office -> OfficeTab\(/);
});

test('companion hiring forwards its captured pane through confirmed floor-scoped actions', () => {
  const web = readFileSync(new URL('../src/client/dashboard.ts', import.meta.url), 'utf8');
  assert.match(web, /hire: \(index\) => hire\('auto', index\)/);
  assert.match(web, /function hire\(deskId = 'auto', targetPane\?: number\)/);
  assert.match(web, /await action\(\{ t: 'worker\.spawn',[^\n]+targetPane\)/);
  assert.match(web, /msg\.t === 'worker\.spawn' && result\.workerId && floor === intendedFloor/);
  assert.match(web, /if \(hired\) openHere\(hired, true, targetPane\)/);
  assert.match(web, /openWorker\(ws, id, targetPane\)/);
});

test('the companion Shell button opens a shell at once, with no prompt or worktree, like B in the office', () => {
  const web = readFileSync(new URL('../src/client/dashboard.ts', import.meta.url), 'utf8');
  assert.match(web, /onclick: \(\) => openShell\(\) \}, icon\('terminal'/);
  const body = web.match(/function openShell\(\) \{\n([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'openShell is defined');
  assert.match(body, /action\(\{ t: 'worker\.spawn', deskId: 'auto', kind: 'shell' \}/);
  assert.doesNotMatch(body, /openPrompt|worktree/);
});
