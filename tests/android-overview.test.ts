import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildOverview, OVERVIEW_DIR } from '../tools/android-overview.mjs';

test("the Android overview page is built from the web companion's map (node tools/android-overview.mjs)", async (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'android-overview-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildOverview(out);
  assert.deepEqual(built, ['index.html', 'overview.css', 'overview.js']);
  assert.deepEqual(readdirSync(OVERVIEW_DIR).sort(), built, 'android/app/src/main/assets/overview has other files: run node tools/android-overview.mjs');
  for (const f of built) assert.ok(readFileSync(path.join(out, f)).equals(readFileSync(path.join(OVERVIEW_DIR, f))), `${f} is stale: run node tools/android-overview.mjs`);
});

test('the Android overview page loads nothing from the network but through the app', () => {
  const html = readFileSync(path.join(OVERVIEW_DIR, 'index.html'), 'utf8');
  assert.match(html, /src="\.\/overview\.js"/);
  assert.match(html, /href="\.\/overview\.css"/);
  assert.doesNotMatch(html, /https?:\/\//);
  const js = readFileSync(path.join(OVERVIEW_DIR, 'overview.js'), 'utf8');
  // The Draco decoder comes from the office's /props/draco/, never a copy bundled into the APK.
  assert.doesNotMatch(js, /draco_decoder-[\w-]+\.wasm/);
  assert.match(js, /\/icons\/models\//);
  const host = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/ui/overview/OverviewPage.kt', import.meta.url), 'utf8');
  assert.ok(host.includes('.addPathHandler("/icons/models/", OfficeFiles("/icons/models/"))'), 'model marks use the same office-only asset bridge as props and fonts');
});
