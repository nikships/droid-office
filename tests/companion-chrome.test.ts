import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const real = browserStatus();
const skip = real.installed ? false : `Chromium isn't downloaded in ${real.path}; run "node bin/droid-office.js browser install" to run this test`;

test('companion modals opt out of the native title bar drag region', { skip }, async (t) => {
  const source = readFileSync(new URL('../src/desktop/companion.ts', import.meta.url), 'utf8');
  const chrome = source.match(/const CHROME = `([\s\S]*?)`;/)?.[1];
  assert.ok(chrome);
  const browser = await launchBrowser();
  t.after(() => closeBrowser());
  const context = await newIsolatedContext(browser);
  t.after(() => context.close().catch(() => {}));
  const page = await context.newPage();
  await page.setContent('<body class="dashboard"><div class="dash-top"><button>Navigation</button><span>Drag</span></div><div id="modal-root"><div class="backdrop"><div class="modal"><button>Grid</button></div></div></div></body>');
  await page.addStyleTag({ content: chrome });
  const region = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
  assert.equal(await region('.dash-top'), 'drag');
  assert.equal(await region('.dash-top button'), 'no-drag');
  assert.equal(await region('.backdrop'), 'no-drag');
});
