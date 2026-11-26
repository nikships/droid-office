import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { FIXTURE } from '../tools/thread-fixture.mjs';

const status = browserStatus();

test('a share link’s view-only pane watches its worker without offering any work, and a write link keeps the work', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser, { viewport: { width: 1280, height: 720 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: { contents: "export { createPane } from './dashboard-pane'; export { store } from './state';", resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)) },
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
      '.dash-workspace { position: relative; flex: none; height: 600px; width: 100%; } .dash-pane { top: 0; width: 49%; height: 100%; transition: none; animation: none; } .dash-pane:first-child { left: 0; } .dash-pane:last-child { left: 51%; }',
  });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((captured) => {
    const w = window as any;
    // Pixel is watched through a view-only single-worker link; Byte through a floor link that can edit.
    w.workers = ['Pixel', 'Byte'].map((name) => ({
      id: name.toLowerCase(),
      name,
      color: '#89d9ed',
      kind: 'agent',
      status: 'done',
      sessionId: 'captured',
      acked: true,
      worktree: { branch: `office/${name.toLowerCase()}`, path: `/tmp/${name}` },
      pr: { number: 7, url: 'https://github.com/example/repo/pull/7' },
    }));
    for (const worker of w.workers) w.PaneUI.store.workers.set(worker.id, worker);
    const listeners = new Set<(msg: any) => void>();
    w.actions = [];
    w.sent = [];
    w.calls = [];
    const net = {
      up: true,
      send(msg: any) {
        w.sent.push(msg.t);
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
    const host = (work: boolean, pinned: boolean) => ({
      net,
      live: () => true,
      floor: () => 'floor',
      busy: () => false,
      read: () => '',
      remember() {},
      action: async (msg: any) => {
        w.actions.push(msg);
      },
      usable: () => true,
      mission: () => undefined,
      worker: (id: string) => w.workers.find((m: any) => m.id === id),
      focus() {},
      close: () => w.calls.push('close'),
      sendHome: () => w.calls.push('sendHome'),
      hire: () => w.calls.push('hire'),
      settings: () => w.calls.push('settings'),
      changes: () => w.calls.push('changes'),
      toWhiteboard: () => w.calls.push('toWhiteboard'),
      setView() {},
      work: () => work,
      owner: () => false,
      pinned: () => pinned,
    });
    w.panes = [w.PaneUI.createPane(host(false, true), 0), w.PaneUI.createPane(host(true, false), 1)];
    document.querySelector('.dash-workspace')!.append(...w.panes.map((pane: any) => pane.el));
    w.paint = () =>
      w.panes.forEach((pane: any, index: number) => pane.update({ worker: w.workers[index], view: 'thread', focused: index === 0, maximized: false, canMaximize: false, covered: false, candidates: [], anyone: true, takeFocus: false }));
    w.paint();
  }, captured);
  const view = page.locator('.dash-pane').nth(0);
  const edit = page.locator('.dash-pane').nth(1);
  await view.locator('.wt-entry').first().waitFor();
  await edit.locator('.wt-entry').first().waitFor();

  // View only: the thread arrives, nothing to type into, no worker actions beyond the PR link, no close or drag.
  // Only the conversation search box is visible; the composer stays in the DOM, hidden.
  assert.deepEqual(await view.locator('textarea, input:not([type=hidden])').evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent).map((el) => el.className)), ['wt-search-input']);
  assert.equal(
    await view
      .locator('.wt-composer')
      .isVisible()
      .catch(() => false),
    false,
  );
  assert.deepEqual(await view.locator('.dash-pane-actions > *').evaluateAll((els) => els.map((el) => `${el.tagName}:${el.getAttribute('title') ?? ''}`)), ['A:Pull request #7']);
  assert.equal(await view.locator('.dash-pane-close').isVisible(), false, 'a single-worker pane cannot be closed');
  assert.equal(await view.locator('.dash-pane-no').getAttribute('draggable'), 'false');
  assert.equal(await view.locator('.wt-rewind:visible, [aria-label*="Rewind" i]:visible, [title*="Rewind" i]:visible').count(), 0, 'no rewind');
  assert.equal(await view.locator('button:has-text("Resume"):visible').count(), 0);
  await page.screenshot({ path: '/tmp/sprocket-shots/unit-view-vs-edit-panes.png' });

  // Edit: the same worker's work is offered (Fork stays out: the worker has no captured fork state here).
  const editActions = await edit.locator('.dash-pane-actions > *').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.getAttribute('title')));
  assert.ok(editActions.includes('Send home'), editActions.join());
  assert.equal(await edit.locator('textarea.wt-input').count(), 1, 'a write link keeps the composer');
  assert.equal(await edit.locator('.dash-pane-close').isVisible(), true);

  // A question: the view-only pane says so and offers no way to answer; the write pane offers its answer button.
  await page.evaluate(() => {
    const w = window as any;
    for (const worker of w.workers) {
      worker.status = 'needs_input';
      w.PaneUI.store.workers.set(worker.id, worker);
    }
    w.paint();
    for (const pane of w.panes) pane.paintQuestion();
  });
  await view.locator('.dash-question').waitFor({ state: 'visible' });
  assert.match(await view.locator('.dash-question').innerText(), /waiting for an answer|is asking/);
  assert.equal(await view.locator('.dash-question button.btn.accent').count(), 0);
  assert.match(await edit.locator('.dash-question').innerText(), /needs you|needs your answer/);
  await page.screenshot({ path: '/tmp/sprocket-shots/unit-view-question.png' });

  // Nothing the view-only pane showed sent work or called the page's work hooks.
  await view.locator('.dash-pane-head').click();
  await view.locator('.wt-scroll').click();
  const work = await page.evaluate(() => ({ actions: (window as any).actions, calls: (window as any).calls, sent: (window as any).sent }));
  assert.deepEqual(work.actions, []);
  assert.deepEqual(work.calls, []);
  assert.ok(
    work.sent.every((t: string) => ['thread.read', 'thread.watch', 'worker.attach', 'worker.detach'].includes(t)),
    work.sent.join(),
  );
  await page.evaluate(() => (window as any).panes.forEach((pane: any) => pane.dispose()));
  assert.deepEqual(errors, []);
});
