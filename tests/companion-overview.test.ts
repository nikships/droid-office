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
  assert.match(web, /hire: \(index\) => hire\('agent', 'auto', index\)/);
  assert.match(web, /function hire\(kind: 'agent' \| 'shell', deskId = 'auto', targetPane\?: number\)/);
  assert.match(web, /await action\(\{ t: 'worker\.spawn',[^\n]+targetPane\)/);
  assert.match(web, /msg\.t === 'worker\.spawn' && result\.workerId && floor === intendedFloor/);
  assert.match(web, /if \(hired\) openHere\(hired, true, targetPane\)/);
  assert.match(web, /openWorker\(ws, id, targetPane\)/);
});
