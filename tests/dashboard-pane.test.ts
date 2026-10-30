import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { FIXTURE } from '../tools/thread-fixture.mjs';

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

test('only the focused thread pane shows its composer, reclaiming space without losing drafts or reading position', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: {
      contents: "export { createPane } from './dashboard-pane'; export { store } from './state';",
      resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'PaneUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf8')).cases.find((example: { name: string }) => example.name === 'reported_release_turn');
  await page.setContent('<!doctype html><div id="dashboard"><div class="dash-workspace"></div></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addStyleTag({
    content:
      '.dash-workspace { position: relative; flex: none; height: 360px; width: 100%; } .dash-pane { top: 0; width: 49%; height: 100%; transition: none; animation: none; } .dash-pane:first-child { left: 0; } .dash-pane:last-child { left: 51%; }',
  });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((captured) => {
    const w = window as any;
    // Pixel and Byte are the owner's workers; conversation rows use the captured golden session.
    w.workers = ['Pixel', 'Byte'].map((name) => ({ id: name.toLowerCase(), name, color: '#89d9ed', kind: 'agent', status: 'idle', sessionId: 'captured', acked: true }));
    for (const worker of w.workers) w.PaneUI.store.workers.set(worker.id, worker);
    const listeners = new Set<(msg: any) => void>();
    w.actions = [];
    w.focused = 0;
    const net = {
      send(msg: any) {
        if (msg.t === 'thread.read')
          queueMicrotask(() => {
            for (const receive of listeners)
              receive({ t: 'thread.snapshot', workerId: msg.workerId, request: msg.request, sessionId: 'captured', entries: captured.entries, hasMore: false, presentation: { version: 1, rows: captured.expected } });
          });
        return true;
      },
      onMessage(receive: (msg: any) => void) {
        listeners.add(receive);
        return () => listeners.delete(receive);
      },
    };
    w.paint = () =>
      w.panes.forEach((pane: any, index: number) =>
        pane.update({ worker: w.workers[index], view: 'thread', focused: index === w.focused, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false }),
      );
    const host = {
      net,
      live: () => true,
      floor: () => 'floor',
      busy: () => false,
      read: () => '',
      remember() {},
      action: async (msg: any) => {
        w.actions.push(msg);
      },
      focus(index: number) {
        if (w.focused === index) return;
        w.focused = index;
        w.paint();
      },
    };
    w.panes = [0, 1].map((index) => w.PaneUI.createPane(host, index));
    document.querySelector('.dash-workspace')!.append(...w.panes.map((pane: any) => pane.el));
    w.paint();
  }, captured);
  const panes = page.locator('.dash-pane');
  const first = panes.nth(0);
  const second = panes.nth(1);
  await first.locator('.wt-entry').first().waitFor();
  // Expand the captured activity so both viewport sizes have enough history to scroll.
  await first.locator('.wt-list').evaluate((el) => {
    for (const details of el.querySelectorAll('details')) details.open = true;
  });
  await first.locator('.wt-latest').click();
  assert.equal(await first.locator('.wt-composer').isVisible(), true);
  assert.equal(await second.locator('.wt-composer').isVisible(), false);
  const height = () => first.locator('.wt-scroll').evaluate((el) => el.clientHeight);
  const bottomGap = () => first.locator('.wt-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const smallHeight = await height();
  const composerHeight = await first.locator('.wt-composer').evaluate((el) => el.getBoundingClientRect().height);
  await first.locator('.wt-input').fill('Keep this unsent draft');
  await first.locator('.wt-input').evaluate((el) => ((window as any).originalInput = el));
  await second.locator('.dash-pane-head').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.wt-scroll')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  assert.equal(await first.locator('.wt-composer').isVisible(), false);
  assert.equal(await second.locator('.wt-composer').isVisible(), true);
  assert.ok(Math.abs((await height()) - smallHeight - composerHeight) < 2, 'the entire composer height becomes conversation space');
  assert.ok((await bottomGap()) < 2, 'following latest stays pinned when the composer collapses');
  // Keyboard entry into history selects the pane, but does not steal focus into its newly shown input.
  await first.locator('.wt-scroll').focus();
  assert.equal(await first.locator('.wt-input').isVisible(), true);
  assert.equal(await first.locator('.wt-scroll').evaluate((el) => document.activeElement === el), true);
  assert.equal(await first.locator('.wt-input').inputValue(), 'Keep this unsent draft');
  assert.equal(await first.locator('.wt-input').evaluate((el) => (window as any).originalInput === el), true);
  await page.waitForFunction(() => {
    const el = document.querySelector('.wt-scroll')!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  // Reading older messages must not be mistaken for following the tail after either resize.
  await first.locator('.wt-scroll').evaluate((el) => {
    el.scrollTop = 40;
    el.dispatchEvent(new Event('scroll'));
  });
  const top = await first.locator('.wt-scroll').evaluate((el) => el.scrollTop);
  assert.ok(top > 0 && (await bottomGap()) > 80, 'the captured conversation overflows the pane');
  await second.locator('.dash-pane-head').click();
  await first.locator('.wt-scroll').focus();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await first.locator('.wt-scroll').evaluate((el) => el.scrollTop), top);
  // A hidden composer is absent from keyboard navigation, not merely transparent.
  await second.locator('.dash-pane-head').click();
  await first.locator('.wt-input').evaluate((el: HTMLTextAreaElement) => el.focus());
  assert.equal(await first.locator('.wt-input').evaluate((el) => document.activeElement === el), false);
  assert.equal(await second.locator('.wt-composer').isVisible(), true);
  // Questions remain visible in unfocused panes, and still suppress the composer on focus.
  await page.evaluate(() => {
    const w = window as any;
    w.workers[0].status = 'needs_input';
    w.paint();
  });
  assert.equal(await first.locator('.dash-question').isVisible(), true);
  await first.locator('.wt-scroll').focus();
  assert.equal(await first.locator('.wt-composer').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => (window as any).actions), [], 'selecting a pane never sends a prompt');
  await page.evaluate(() => (window as any).panes.forEach((pane: any) => pane.dispose()));
  assert.deepEqual(errors, []);
});
