import assert from 'node:assert/strict';
import test from 'node:test';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { terminalFixture } from './helpers/terminal-fixture.js';

test('a late worker title does not move or shrink the desk terminal', { skip: !browserStatus().installed }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const mount = await terminalFixture(t);
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
  ]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    await mount(page, '<div id="modal-root"></div><div id="toasts"></div>');
    await page.evaluate(() => {
      const { store, openTerminal } = (window as any).TerminalUI;
      const worker = { id: 'pixel', name: 'Pixel '.repeat(40).trim(), kind: 'agent', deskId: 'desk', status: 'idle', color: '#89d9ed' };
      store.workers.set(worker.id, worker);
      openTerminal({ up: true, onStatus: () => () => {}, onMessage: () => () => {}, send: () => true }, worker.id);
    });
    await page.getByRole('button', { name: 'Raw TTY', exact: true }).click();
    const metrics = () =>
      page.locator('.modal.term').evaluate((el) => {
        const host = el.querySelector<HTMLElement>('.term-host')!;
        return [el.querySelector('header')!.offsetHeight, host.offsetTop, host.offsetHeight];
      });
    const before = await metrics();
    assert.ok(before[2] > 0);
    const title = 'New Session '.repeat(24).trim();
    await page.evaluate((title) => {
      const { store } = (window as any).TerminalUI;
      store.apply({ t: 'worker.update', worker: { ...store.worker('pixel'), title } });
    }, title);
    const sub = page.locator('.modal.term header .sub');
    assert.equal(await sub.textContent(), title);
    for (const label of [page.locator('.modal.term header h2'), sub]) {
      assert.equal(await label.getAttribute('title'), await label.textContent());
      assert.ok(await label.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'));
    }
    assert.deepEqual(await metrics(), before, `${width}×${height} header height, host top and host height`);
    await page.close();
  }
});
