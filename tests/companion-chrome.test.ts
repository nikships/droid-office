import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COMPANION_CHROME } from '../src/desktop/companion-chrome.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const real = browserStatus();
const skip = real.installed ? false : `Chromium isn't downloaded in ${real.path}; run "node bin/droid-office.js browser install" to run this test`;

test('companion Mac window centers traffic lights in the 36px upper deck', () => {
  const companionSrc = readFileSync(new URL('../src/desktop/companion.ts', import.meta.url), 'utf8');
  assert.match(companionSrc, /trafficLightPosition:\s*\{\s*x:\s*16,\s*y:\s*12\s*\}/);
  assert.doesNotMatch(COMPANION_CHROME, /linear-gradient|backdrop-filter/);
});

test('companion controls, lower floor bays, popovers and modals opt out of the native title bar drag region', { skip }, async (t) => {
  const browser = await launchBrowser();
  t.after(() => closeBrowser());
  const context = await newIsolatedContext(browser);
  t.after(() => context.close().catch(() => {}));
  const page = await context.newPage();
  const styleCss = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
  await page.setContent(
    '<body class="dashboard"><header class="dash-top"><div class="dash-top-upper"><button>Navigation</button><span class="dash-git-pill" hidden>Pill</span><span>Drag</span><div class="dash-layout-pop">Layouts</div></div><div class="dash-top-lower"><button class="dash-floor-chip">01</button><button class="dash-quiet-bay" hidden>+2 quiet</button><div class="dash-quiet-pop"><input type="search" /></div></div></header><div id="modal-root"><div class="backdrop"><div class="modal"><button>Grid</button></div></div></div></body>',
  );
  await page.addStyleTag({ content: styleCss });
  await page.addStyleTag({ content: COMPANION_CHROME });
  const region = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
  const padLeft = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).paddingLeft);
  const display = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).display);
  assert.equal(await region('.dash-top'), 'drag');
  assert.equal(await padLeft('.dash-top-upper'), '88px');
  assert.equal(await padLeft('.dash-top-lower'), '0px');
  assert.equal(await display('.dash-git-pill'), 'none');
  assert.equal(await display('.dash-quiet-bay'), 'none');
  assert.equal(await region('.dash-top-upper button'), 'no-drag');
  assert.equal(await region('.dash-floor-chip'), 'no-drag');
  assert.equal(await region('.dash-top input'), 'no-drag');
  assert.equal(await region('.dash-top-lower'), 'no-drag');
  assert.equal(await region('.dash-quiet-pop'), 'no-drag');
  assert.equal(await region('.dash-layout-pop'), 'no-drag');
  assert.equal(await region('.backdrop'), 'no-drag');
});
