import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('empty pane clicks hire in place without swallowing worker picks or allowing offline hires', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/dashboard-pane.ts', import.meta.url))], bundle: true, format: 'iife', globalName: 'PaneUI', write: false, target: 'es2022' }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="modal-root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as any;
    w.hires = [];
    w.assignments = [];
    w.live = true;
    const pane = w.PaneUI.createPane(
      {
        live() {
          return w.live;
        },
        focus() {},
        hire(index: number) {
          w.hires.push(index);
        },
        assign(index: number, id: string) {
          w.assignments.push([index, id]);
        },
      },
      3,
    );
    document.body.append(pane.el);
    // Pixel is the existing worker offered by the owner's companion screenshot.
    w.paint = (anyone = true) =>
      pane.update({
        view: 'terminal',
        focused: true,
        maximized: false,
        canMaximize: false,
        covered: false,
        takeFocus: false,
        anyone,
        candidates: anyone ? [{ id: 'pixel', name: 'Pixel', color: '#89d9ed' }] : [],
      });
    w.paint();
  });
  await page.locator('.dash-pick span').last().click();
  assert.deepEqual(await page.evaluate(() => (window as any).assignments), [[3, 'pixel']]);
  assert.deepEqual(await page.evaluate(() => (window as any).hires), []);
  await page.getByRole('button', { name: 'Hire Droid here' }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3], 'button bubbling does not hire twice');
  await page.locator('.dash-empty h3').click();
  await page.locator('.dash-empty').dispatchEvent('click');
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3]);
  await page.evaluate(() => {
    document.querySelector('.dash-empty h3')!.firstChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(errors, [], 'non-element event targets do not throw');
  await page.evaluate(() => {
    (window as any).live = false;
    (window as any).paint();
  });
  assert.equal(await page.getByRole('button', { name: 'Hire Droid here' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Pixel' }).isDisabled(), true);
  await page.locator('.dash-empty h3').click();
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3], 'offline backgrounds do not hire');
  await page.evaluate(() => {
    (window as any).live = true;
    (window as any).paint(false);
  });
  await page.getByRole('button', { name: 'Hire Droid here' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => (window as any).hires), [3, 3, 3, 3], 'an unpopulated floor supports keyboard hiring');
});
