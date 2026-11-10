import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { workerMenuItems, type WorkerMenuState } from '../src/client/dashboard-worker-menu.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const worker = { id: 'pixel', name: 'Pixel', color: '#a8d354', kind: 'agent', status: 'working', sessionId: 'session' } as WorkerInfo;
const state: WorkerMenuState = { worker, floor: 'home', pane: 0, live: true, busy: false, native: true };
const actions = (s: WorkerMenuState) => workerMenuItems(s).map((i) => i.action);

test('grouped menu adapts to agents, shells and cloud workers without offering invalid actions', () => {
  assert.deepEqual(actions(state), ['open', 'split', 'close', 'interrupt', 'fork', 'copy-name', 'home']);
  assert.equal(workerMenuItems(state).find((i) => i.action === 'fork')?.disabled, true);
  assert.equal(workerMenuItems({ ...state, worker: { ...worker, status: 'done' } }).find((i) => i.action === 'fork')?.disabled, false);
  assert.equal(workerMenuItems(state).find((i) => i.action === 'close')?.shortcut, '⌘W');
  assert.ok(workerMenuItems({ ...state, native: false }).every((i) => !i.shortcut));
  assert.ok(workerMenuItems({ ...state, live: false }).every((i) => i.disabled));
  assert.ok(
    workerMenuItems({ ...state, busy: true })
      .filter((i) => i.section === 'Worker' || i.action === 'home')
      .every((i) => i.disabled),
  );
  const shell = { ...state, worker: { ...worker, kind: 'shell' as const, status: 'exited' as const }, pane: -1 };
  assert.deepEqual(actions(shell), ['open', 'split', 'resume', 'copy-name', 'home']);
  assert.equal(workerMenuItems(shell).find((i) => i.action === 'resume')?.label, 'Restart');
  assert.equal(
    workerMenuItems({ ...state, worker: { ...worker, cloud: {} as WorkerInfo['cloud'] } }).some((i) => i.action === 'fork'),
    false,
  );
  const branch = { ...state, worker: { ...worker, worktree: { branch: 'office/pixel', path: '/tmp/worktree' } } };
  assert.ok(actions(branch).includes('copy-branch'));
  assert.equal(workerMenuItems(branch).find((i) => i.action === 'pr')?.disabled, true);
  assert.equal(workerMenuItems({ ...branch, worker: { ...branch.worker, status: 'done' } }).find((i) => i.action === 'pr')?.disabled, false);
  assert.equal(workerMenuItems({ ...shell, worker: { ...shell.worker, lost: true } }).find((i) => i.action === 'resume')?.disabled, true);
});

test('roster context menu targets the clicked worker, supports keyboards, bounds, dismissal and stale-state guards', { skip: !browserStatus().installed }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 700, height: 550 });
  await page.setContent('<nav id="roster" style="width:240px"></nav><button id="outside">Outside</button>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.addScriptTag({
    content: buildSync({
      stdin: { contents: "export { createWorkerRoster } from './dashboard-roster'; export { createWorkerMenu } from './dashboard-worker-menu';", resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)) },
      bundle: true,
      format: 'iife',
      globalName: 'UI',
      write: false,
    }).outputFiles[0].text,
  });
  await page.evaluate((initial) => {
    const w = window as any;
    w.state = initial;
    w.calls = [];
    w.menu = w.UI.createWorkerMenu({
      state: (id: string) => w.state && { ...w.state, worker: { ...w.state.worker, id, name: id } },
      run: (action: string, s: any) => w.calls.push([action, s.worker.id]),
    });
    w.roster = w.UI.createWorkerRoster(
      document.querySelector('#roster'),
      (id: string) => w.calls.push(['click', id]),
      () => {},
      w.menu.open,
    );
    w.roster.update({ floor: 'home', focused: 'pixel', live: true, pane: () => 0, workers: [initial.worker, { ...initial.worker, id: 'shell', name: 'Shell', kind: 'shell' }] });
  }, state);
  const menu = page.getByRole('menu');
  const shell = page.locator('[data-worker=shell]');
  await shell.click({ button: 'right' });
  assert.equal(await menu.getAttribute('aria-label'), 'shell actions');
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [], 'right click does not open the worker');
  await page.locator('#outside').dispatchEvent('scroll');
  assert.equal(await menu.count(), 1, 'terminal or thread auto-scroll outside the sidebar does not dismiss the menu');
  await menu.dispatchEvent('scroll');
  assert.equal(await menu.count(), 1, 'scrolling a tall menu keeps it open');
  assert.deepEqual(await page.locator('.dash-worker-menu-section').allTextContents(), ['Workspace', 'Worker', 'Copy']);
  await page.keyboard.press('End');
  assert.match(await page.locator(':focus').innerText(), /Send home/);
  await page.keyboard.press('Home');
  assert.equal(await page.locator(':focus').innerText(), 'Focus its pane');
  await page.keyboard.press('ArrowDown');
  assert.match(await page.locator(':focus').innerText(), /Close pane/, 'disabled split is skipped');
  await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0);
  assert.equal(await shell.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('Shift+F10');
  assert.equal(await menu.count(), 1);
  await page.getByRole('menuitem', { name: /Send home/ }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [['home', 'shell']]);
  await shell.click({ button: 'right' });
  await page.locator('#outside').click();
  assert.equal(await menu.count(), 0);
  for (const change of ['floor', 'disconnected', 'removed', 'busy']) {
    await page.evaluate((initial) => {
      (window as any).state = initial;
    }, state);
    await shell.click({ button: 'right' });
    await page.evaluate((change) => {
      const w = window as any;
      if (change === 'floor') w.state.floor = 'other';
      if (change === 'disconnected') w.state.live = false;
      if (change === 'removed') w.state = undefined;
      if (change === 'busy') w.state.busy = true;
    }, change);
    await page.getByRole('menuitem', { name: /Send home/ }).click();
    assert.equal((await page.evaluate(() => (window as any).calls)).length, 1, `stale ${change} never acts`);
  }
  await page.evaluate((initial) => {
    (window as any).state = initial;
  }, state);
  await shell.dispatchEvent('contextmenu', { clientX: 699, clientY: 549 });
  const box = await menu.boundingBox();
  assert.ok(box && box.x >= 8 && box.y >= 8 && box.x + box.width <= 692 && box.y + box.height <= 542);
  await page.evaluate(() => {
    (window as any).state.worker.status = 'done';
    (window as any).menu.refresh();
  });
  assert.equal(await menu.count(), 0);
  await shell.click({ button: 'right' });
  await page.keyboard.press('Tab');
  assert.equal(await menu.count(), 0);
  await shell.click({ button: 'right' });
  await page.locator('#roster').dispatchEvent('scroll');
  assert.equal(await menu.count(), 0, 'scrolling the anchor sidebar dismisses the menu');
  await shell.click({ button: 'right' });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  assert.equal(await menu.count(), 0);
  assert.deepEqual(errors, []);
});
