import assert from 'node:assert/strict';
import test from 'node:test';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { terminalFixture } from './helpers/terminal-fixture.js';

test('Raw TTY reattaches with a visible reader', { skip: !browserStatus().installed }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const mount = await terminalFixture(t);
  const desk = async () => {
    const page = await context.newPage();
    await mount(page, '<div id="modal-root"></div><div id="toasts"></div>');
    await page.evaluate(() => {
      const w = window as any,
        { openTerminal, routeTerminalMessage, store } = w.TerminalUI;
      const worker = { id: 'pixel', name: 'Pixel', kind: 'agent', deskId: 'desk', color: '#89d9ed', status: 'idle', sessionId: 'session', cols: 120, rows: 40, open: true };
      store.workers.set(worker.id, worker);
      const lines = Array.from({ length: 160 }, (_, i) => (i < 90 ? `prefix ${i} ${'x'.repeat(60)}` : `anchor ${i}`));
      w.net = {
        up: true,
        onStatus: () => () => {},
        onMessage: () => () => {},
        request: async () => ({ ok: true }),
        send(msg: { t: string; stream?: boolean }) {
          if (this.up && msg.t === 'worker.attach' && msg.stream !== false) {
            if (w.fitDuringAttach) window.dispatchEvent(new Event('resize'));
            const { cols, rows } = store.worker(worker.id);
            queueMicrotask(() => routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data: lines.join('\r\n'), cols, rows, shared: true }));
          }
          return this.up;
        },
      };
      w.narrow = () => store.apply({ t: 'worker.update', worker: { ...worker, cols: 40 } });
      openTerminal(w.net, worker.id);
    });
    await page.locator('.office-wterm textarea').waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Raw TTY', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.office-wterm:not(.replaying)')?.textContent?.includes('anchor 159'));
    return page;
  };
  await t.test('offline Thread to Raw and repeated Raw keep the last painted grid', async () => {
    const page = await desk();
    await page.evaluate(() => ((window as any).net.up = false));
    await page.getByRole('button', { name: 'Thread', exact: true }).click();
    const raw = page.getByRole('button', { name: 'Raw TTY', exact: true });
    await raw.click();
    await raw.click();
    const root = page.locator('.office-wterm');
    assert.equal(await root.evaluate((el) => getComputedStyle(el).opacity), '1');
    assert.match(await root.innerText(), /anchor 159/);
    await page.close();
  });
  for (const pending of [false, true])
    await t.test(`after a narrower reattach the reader returns beyond the old scroll range (${pending ? 'queued fit' : 'settled fit'})`, async () => {
      const page = await desk(),
        root = page.locator('.office-wterm');
      const before = await root.evaluate((el) => {
        const pitch = parseFloat(getComputedStyle(el).getPropertyValue('--term-row-height'));
        el.scrollTop = 100.25 * pitch;
        return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, pitch };
      });
      await page.waitForFunction(() => {
        const r = document.querySelector('.office-wterm')!.getBoundingClientRect();
        return document
          .elementFromPoint(r.left + 15, r.top + 9)
          ?.closest('.term-row')
          ?.textContent?.includes('anchor 100');
      });
      await page.getByRole('button', { name: 'Thread', exact: true }).click();
      await page.evaluate((pending) => {
        const w = window as any;
        w.narrow();
        w.fitDuringAttach = pending;
      }, pending);
      await page.getByRole('button', { name: 'Raw TTY', exact: true }).click();
      const actual = await root.evaluate(async (el) => {
        for (let i = 0; i < 9; i++) await new Promise(requestAnimationFrame);
        return el.scrollTop;
      });
      const expected = before.top + 90 * before.pitch; // Every long prefix now occupies two rows.
      t.diagnostic(`reader: original=${before.top}, old maximum=${before.max}, expected=${expected}, actual=${actual}`);
      assert.ok(expected > before.max);
      assert.equal(actual, expected);
      await page.close();
    });
});
