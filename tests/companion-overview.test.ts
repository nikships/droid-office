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
