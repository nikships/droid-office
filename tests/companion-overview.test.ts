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

test('switching pane views keeps the thread until the pane is reset or disposed', () => {
  const pane = readFileSync(new URL('../src/client/dashboard-pane.ts', import.meta.url), 'utf8');
  assert.match(pane, /function teardown\(keepThread = false\)/);
  assert.match(pane, /if \(keepThread\) thread\?\.activate\(false\)/);
  assert.match(pane, /thread\?\.dispose\(\)/);
  assert.match(pane, /function reset\(next: string\) \{\s*teardown\(\)/);
  assert.match(pane, /function build\(w: WorkerInfo \| undefined, next: PaneMode\) \{\s*teardown\(!!w && next !== 'empty'\)/);
  assert.match(pane, /thread \?\?= mountWorkerThread/);
  assert.match(pane, /thread\.element\.querySelector\('\.wt-scroll'\)\?\.append\(question\)/);
});
