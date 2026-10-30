import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
test('worker roster preserves hierarchy, focus and entry motion across updates', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: { contents: "export { createWorkerRoster } from './dashboard-roster'; export { createPane } from './dashboard-pane'; export { store } from './state';", resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)) },
    bundle: true,
    format: 'iife',
    globalName: 'TeamUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setContent('<!doctype html><nav id="roster"></nav><div id="modal-root"></div>');
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as any;
    w.opened = [];
    w.split = [];
    w.arrivals = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      w.arrivals.push(this.querySelector<HTMLElement>('[data-worker]')?.dataset.worker);
      return animate.apply(this, args);
    };
    w.workers = [
      ['Pixel', '#a8d354', 'Document AWS Infrastructure'],
      ['Nibble', '#4dbed4', 'Verifying DNS & networking'],
      ['Dot', '#d395ce', 'Rerunning messaging collector'],
      ['Widget', '#ce95ce', 'Reviewing logs & cost data'],
    ].map(([name, color, prompt], index) => ({ id: name.toLowerCase(), name, color, prompt, createdAt: index, lead: index ? 'pixel' : undefined, kind: 'agent', status: 'working', acked: false }));
    w.roster = w.TeamUI.createWorkerRoster(
      document.querySelector('#roster'),
      (id: string) => w.opened.push(id),
      (id: string) => w.split.push(id),
    );
    w.state = { floor: 'home', workers: w.workers.slice(0, 2), focused: 'pixel', live: true, pane: () => -1 };
    w.paint = () => w.roster.update(w.state);
    w.paint();
  });
  assert.deepEqual(await page.evaluate(() => (window as any).arrivals), [], 'initial snapshot does not animate');
  assert.equal(await page.locator('.dash-worker-team').count(), 1);
  assert.equal(await page.locator('.dash-subworker').count(), 1);
  const toggle = page.locator('.dash-team-toggle');
  await toggle.focus();
  await page.evaluate(() => {
    const w = window as any;
    w.toggle = document.activeElement;
    w.state.workers = w.workers;
    w.paint();
    w.paint();
  });
  assert.equal(await page.evaluate(() => document.activeElement === (window as any).toggle), true);
  assert.deepEqual(await page.evaluate(() => (window as any).arrivals), ['dot', 'widget'], 'new children animate once, not on repaint');
  await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.dash-team-children').isHidden(), true);
  assert.deepEqual(await page.evaluate(() => (window as any).roster.visible().map((w: any) => w.id)), ['pixel']);
  await page.evaluate(() => {
    const w = window as any;
    w.workers[2].status = 'needs_input';
    w.paint();
  });
  assert.match(await toggle.innerText(), /2 working/);
  assert.doesNotMatch(await page.locator('#roster').innerText(), /needs? you/);
  assert.equal(await page.locator('.dash-subworker.attn, .dash-subworker .needs_input, .dash-subworker [data-status=needs_input]').count(), 0);
  assert.match((await page.locator('[data-worker=dot]').getAttribute('aria-label')) ?? '', /waiting for lead/);
  await page.evaluate(() => {
    const w = window as any;
    w.workers[0].status = 'needs_input';
    w.workers[3].status = 'done';
    w.paint();
  });
  assert.match(await page.locator('.dash-roster-caption').innerText(), /1 need you/);
  assert.equal(await page.locator('.dash-row.attn').count(), 1);
  assert.equal(await page.locator('.dash-subworker .pill').count(), 0, 'unread subagent completions are not owner alerts either');
  await page.evaluate(() => (window as any).roster.reveal('dot'));
  await page.getByRole('button', { name: /Open Dot, Subworker of Pixel/ }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).opened), ['dot']);
  await page.getByRole('button', { name: 'Open Dot in a new pane', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).split), ['dot']);
  await page.evaluate(() => {
    const w = window as any;
    w.state.live = false;
    w.paint();
  });
  assert.equal(await page.locator('[data-worker=dot]').isDisabled(), true);
  await page.evaluate(() => {
    const w = window as any;
    w.state.workers = w.workers.slice(0, 1);
    w.paint();
    w.state.live = true;
    w.state.workers = w.workers;
    w.paint();
  });
  assert.deepEqual(await page.evaluate(() => (window as any).arrivals), ['dot', 'widget'], 'reconnect snapshots do not spawn');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const w = window as any;
    w.state.workers = w.workers.slice(0, 1);
    w.paint();
    w.state.workers = w.workers;
    w.paint();
    w.state.floor = 'other';
    w.paint();
  });
  assert.deepEqual(await page.evaluate(() => (window as any).arrivals), ['dot', 'widget']);
  await page.evaluate(() => {
    const w = window as any;
    w.state.workers = w.workers.slice(1);
    w.paint();
  });
  assert.equal(await page.locator('.dash-worker-team').count(), 0);
  assert.equal(await page.locator('.dash-row').count(), 3, 'lead departure does not hide children');
  assert.match(await page.locator('[data-worker=dot]').innerText(), /Lead unavailable/);
  await page.evaluate(() => {
    const w = window as any;
    w.state.workers = [];
    w.paint();
  });
  assert.match(await page.locator('#roster').innerText(), /Nobody on this floor/);
  assert.deepEqual(errors, []);

  // Exercise the real pane's team trail, without starting a terminal or a worker.
  await page.evaluate(() => {
    const w = window as any;
    w.assignments = [];
    w.workers.forEach((m: any) => {
      m.status = 'offline';
      w.TeamUI.store.workers.set(m.id, m);
    });
    w.pane = w.TeamUI.createPane(
      {
        live: () => w.state.live,
        floor: () => 'home',
        read: () => '',
        focus() {},
        busy: () => false,
        terminal: async () => ({ openTerminal: () => ({ close() {}, attach() {}, focus() {} }) }),
        usable: (id: string) => w.state.live && w.TeamUI.store.workers.has(id),
        assign: (index: number, id: string) => w.assignments.push([index, id]),
      },
      0,
    );
    document.body.append(w.pane.el);
    w.paintPane = (id = 'pixel') =>
      w.pane.update({
        worker: w.TeamUI.store.workers.get(id),
        view: 'terminal',
        focused: true,
        maximized: false,
        canMaximize: true,
        covered: false,
        candidates: [],
        anyone: true,
        takeFocus: false,
      });
    w.paintPane();
  });
  assert.equal(await page.locator('.dash-team-chip').count(), 4);
  await page.locator('[data-member=dot]').click();
  assert.deepEqual(await page.evaluate(() => (window as any).assignments), [[0, 'dot']]);
  await page.evaluate(() => (window as any).paintPane('dot'));
  assert.equal(await page.locator('[data-member=dot]').getAttribute('aria-current'), 'true');
  await page.locator('[data-member=pixel]').focus();
  await page.evaluate(() => {
    const w = window as any;
    w.workers[1].name = 'Nibble updated';
    w.paintPane('dot');
  });
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.member), 'pixel');
  await page.evaluate(() => {
    const w = window as any;
    w.workers[2].status = 'needs_input';
    w.paintPane('dot');
  });
  assert.equal(await page.locator('.dash-pane.attn').count(), 0);
  assert.equal(await page.locator('.dash-pane-head .pill').innerText(), 'waiting for lead');
  assert.equal(await page.locator('.dash-question').isHidden(), true);
  assert.equal(await page.locator('[data-member=dot]').getAttribute('data-status'), 'waiting');
  assert.equal(await page.locator('.dash-pane [data-status=needs_input], .dash-pane .pill.needs_input').count(), 0);
  await page.evaluate(() => {
    const w = window as any;
    w.workers[0].status = 'needs_input';
    w.paintPane('pixel');
  });
  assert.equal(await page.locator('.dash-pane.attn').count(), 1);
  assert.match(await page.locator('.dash-question').innerText(), /Pixel needs you/);
  await page.evaluate(() => {
    const w = window as any;
    w.workers[0].status = 'offline';
    w.workers[2].status = 'offline';
    w.paintPane('dot');
  });
  await page.evaluate(() => {
    const w = window as any;
    w.state.live = false;
    w.paintPane('dot');
  });
  assert.equal(await page.locator('[data-member=pixel]').isDisabled(), true);
  await page.evaluate(() => {
    const w = window as any;
    w.TeamUI.store.workers.delete('pixel');
    w.paintPane('dot');
  });
  assert.equal(await page.locator('.dash-team-nav').isHidden(), true);
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    const w = window as any;
    w.state.live = true;
    w.pane.el.style.width = '184px';
    w.pane.el.style.height = '480px';
    w.paintPane('dot');
  });
  assert.equal(await page.locator('.dash-pane-views').isVisible(), false, 'the segmented control cannot override the dense header');
  assert.equal(await page.getByRole('button', { name: 'Maximize pane', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Close pane', exact: true }).isVisible(), false, 'secondary controls return after maximizing');
  assert.ok(await page.locator('.dash-pane-name').evaluate((n) => n.clientWidth >= n.scrollWidth), 'the worker name remains readable in an eighth-width pane');
  assert.ok(await page.locator('.dash-pane-head').evaluate((n) => n.scrollWidth <= n.clientWidth), 'dense controls fit inside the pane');
  await page.evaluate(() => (window as any).pane.dispose());
  assert.deepEqual(errors, []);
});
