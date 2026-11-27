import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('the desk window switches Thread and Raw TTY without remounting either view', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: {
      contents: "export { openTerminal, routeTerminalMessage } from './src/client/ui/terminal'; export { store } from './src/client/state'; export { Terminal } from '@xterm/xterm';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    external: ['*/wterm-runtime'], // This stand-alone xterm fixture has no Vite asset server.
    format: 'iife',
    globalName: 'TerminalUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.route('http://desk.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="modal-root"></div><div id="toasts"></div>' }));
  await page.goto('http://desk.test/');
  await page.setContent('<!doctype html><div id="modal-root"></div><div id="toasts"></div>');
  const css = (await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8')) + (await readFile(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8'));
  await page.evaluate((content) => {
    const style = document.createElement('style');
    style.textContent = content;
    document.head.append(style);
  }, css);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => ((window as any).__name = (fn: unknown) => fn));
  await page.evaluate(() => {
    const w = window as any;
    const { Terminal, store, openTerminal, routeTerminalMessage } = w.TerminalUI;
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (host: HTMLElement) {
      w.term = this;
      open.call(this, host);
    };
    const worker = { id: 'pixel', name: 'Pixel', kind: 'agent', deskId: 'desk', color: '#89d9ed', status: 'idle', sessionId: 'session', cols: 120, rows: 40, open: false };
    store.workers.set(worker.id, worker);
    w.messages = [];
    w.net = {
      up: true,
      send(msg: any) {
        w.messages.push(msg);
        if (msg.t === 'worker.attach') queueMicrotask(() => routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data: '', cols: worker.cols, rows: worker.rows, shared: false }));
        return true;
      },
      request: async (msg: any) => ({ t: 'action.result', requestId: msg.requestId, ok: true }),
      onMessage(fn: any) {
        w.receive = fn;
        return () => {};
      },
      onStatus() {
        return () => {};
      },
    };
    w.open = () => openTerminal(w.net, worker.id);
    w.open();
  });
  await page.waitForFunction(() => !!(window as any).term?.element && document.querySelector('.term-thread-host .worker-thread'));
  assert.equal(await page.locator('.term-thread-host').isVisible(), true, 'Thread is the initial desk view');
  assert.equal(await page.locator('.term-host').isVisible(), false);
  const initial = await page.evaluate(() => {
    const w = window as any;
    w.originalTerm = w.term.element;
    w.originalThread = document.querySelector('.term-thread-host .worker-thread');
    return true;
  });
  assert.equal(initial, true);

  await page.getByRole('button', { name: 'Raw TTY', exact: true }).click();
  assert.equal(await page.locator('.term-host').isVisible(), true);
  assert.equal(await page.locator('.term-thread-host').isVisible(), false);
  await page.waitForFunction(() => !(window as any).term.options.disableStdin);
  assert.equal(await page.evaluate(() => (window as any).messages.filter((msg: any) => msg.t === 'worker.attach').length >= 2), true, 'Raw TTY reattaches after the Thread detaches');

  await page.getByRole('button', { name: 'Thread', exact: true }).click();
  assert.equal(await page.locator('.term-thread-host').isVisible(), true);
  assert.equal(await page.locator('.term-host').isVisible(), false);
  assert.equal(
    await page.evaluate(() => {
      const w = window as any;
      return w.originalTerm === w.term.element && w.originalThread === document.querySelector('.term-thread-host .worker-thread');
    }),
    true,
    'both views and their state stay mounted',
  );

  await page.getByRole('button', { name: 'Raw TTY', exact: true }).click();
  await page.locator('.modal.term > header > button.close').click();
  await page.evaluate(() => (window as any).open());
  await page.waitForFunction(() => document.querySelectorAll('.modal.term').length === 1 && !!(window as any).term?.element);
  assert.equal(await page.locator('.term-host').isVisible(), true, 'the per-worker Raw TTY choice is remembered');
  assert.equal(await page.locator('.term-thread-host').isVisible(), false);
  await page.locator('.modal.term > header > button.close').click();
  await page.evaluate(() => {
    const w = window as any;
    const { store, openTerminal } = w.TerminalUI;
    const worker = { ...store.workers.get('pixel'), id: 'orchestrator', name: 'Orchestrator', deskId: '' };
    w.mission = (status: string, blocked?: string) => {
      store.apply({ t: 'missionControl', state: { orchestrator: { settings: { on: true }, agent: { worker: { ...worker, status }, team: [] }, team: [], blocked }, bots: [] } });
    };
    w.mission('idle');
    openTerminal(w.net, worker.id);
  });
  const badge = page.locator('.modal.term > header .dash-mission-mark');
  const arrow = badge.locator('.orc-mark-arrow');
  const animation = () => arrow.evaluate((el) => getComputedStyle(el).animationName);
  assert.equal(await animation(), 'orc-dispatch');
  await page.evaluate(() => (window as any).mission('exited', 'Droid is signed out.'));
  assert.equal(await animation(), 'none', 'an already-open terminal badge stops animating while blocked');
  assert.equal(await badge.getAttribute('data-status'), 'blocked');
  await page.evaluate(() => (window as any).mission('idle'));
  assert.equal(await animation(), 'orc-dispatch', 'the same badge animates when ready again');
  assert.equal(await badge.getAttribute('data-status'), 'idle');
  assert.deepEqual(errors, []);
});
