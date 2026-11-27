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
      w.snapshots = 0;
      w.resync = () => {
        w.snapshots++;
        const { cols, rows } = store.worker(worker.id);
        routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data: lines.join('\r\n'), cols, rows, shared: true });
      };
      w.inputs = [];
      w.net = {
        up: true,
        onStatus: () => () => {},
        onMessage: () => () => {},
        request: async () => ({ ok: true }),
        send(msg: { t: string; stream?: boolean; data?: string }) {
          if (msg.t === 'term.input') w.inputs.push(msg.data);
          if (this.up && msg.t === 'worker.attach' && msg.stream !== false) {
            if (w.fitDuringAttach) window.dispatchEvent(new Event('resize'));
            if (!w.delaySnapshot) queueMicrotask(w.resync);
            if (w.doubleSnapshot) requestAnimationFrame(() => requestAnimationFrame(w.resync));
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
  const savedDesk = async () => {
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
    await page.evaluate(() => (window as any).narrow());
    return { page, root, before };
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
  for (const kind of ['settled fit', 'queued fit', 'superseding snapshot'])
    await t.test(`after a narrower reattach the reader returns beyond the old scroll range (${kind})`, async () => {
      const { page, root, before } = await savedDesk();
      await page.evaluate((kind) => {
        const w = window as any;
        w.fitDuringAttach = kind !== 'settled fit';
        w.doubleSnapshot = kind === 'superseding snapshot';
        w.snapshots = 0;
      }, kind);
      await page.getByRole('button', { name: 'Raw TTY', exact: true }).click();
      const actual = await root.evaluate(async (el) => {
        for (let i = 0; i < 9; i++) await new Promise(requestAnimationFrame);
        return el.scrollTop;
      });
      const expected = before.top + 90 * before.pitch; // Every long prefix now occupies two rows.
      t.diagnostic(`reader: original=${before.top}, old maximum=${before.max}, expected=${expected}, actual=${actual}`);
      assert.ok(expected > before.max);
      assert.equal(actual, expected);
      assert.equal(await page.evaluate(() => (window as any).snapshots), kind === 'superseding snapshot' ? 2 : 1);
      if (kind === 'superseding snapshot') {
        const next = await root.evaluate(async (el) => {
          (window as any).resync();
          for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame);
          return el.scrollTop;
        });
        assert.notEqual(next, expected, 'a later resync must not apply the saved reader twice');
      }
      await page.close();
    });
  await t.test('scrolling the retained Raw grid before its snapshot arrives keeps the newly selected row', async () => {
    const { page, root, before } = await savedDesk();
    await page.evaluate(() => {
      const w = window as any;
      w.snapshots = 0;
      w.delaySnapshot = true;
    });
    await page.getByRole('button', { name: 'Raw TTY', exact: true }).click();
    await root.hover();
    await page.mouse.wheel(0, 190);
    await page.waitForFunction((top) => document.querySelector('.office-wterm')!.scrollTop > top, before.top);
    const selected = await root.evaluate((el) => el.scrollTop);
    assert.equal(await page.evaluate(() => (window as any).snapshots), 0);
    const restored = await root.evaluate(async (el) => {
      (window as any).resync();
      for (let i = 0; i < 9; i++) await new Promise(requestAnimationFrame);
      return el.scrollTop;
    });
    assert.equal(restored, selected + 90 * before.pitch);
    await page.close();
  });

  for (const wheel of [false, true])
    await t.test(`a second reattach before paint preserves ${wheel ? 'the wheeled row on the retained grid' : 'the original reader'}`, async () => {
      const { page, root, before } = await savedDesk();
      const raw = page.getByRole('button', { name: 'Raw TTY', exact: true });
      await page.evaluate(() => ((window as any).delaySnapshot = true));
      await raw.click();
      if (!wheel) await page.setViewportSize({ width: 1200, height: 760 });
      await page.evaluate(async (wheel) => {
        const w = window as any;
        if (wheel) {
          // Stretch the fit across the trusted wheel event; the old rows stay painted.
          w.hold = true;
          const move = () => {
            if (!w.hold) return;
            window.dispatchEvent(new Event('resize'));
            requestAnimationFrame(move);
          };
          move();
        }
        w.resync();
        // The mirror drains writes and parses the snapshot in two microtasks.
        await Promise.resolve();
        await Promise.resolve();
        Array.from(document.querySelectorAll('button'))
          .find((b) => b.textContent === 'Thread')!
          .click();
      }, wheel);
      await raw.click();
      let selected = before.top;
      if (wheel) {
        const old = await root.evaluate((el) => el.scrollTop);
        await root.hover();
        await page.mouse.wheel(0, before.top + 10 * before.pitch - old);
        await page.waitForFunction((old) => document.querySelector('.office-wterm')!.scrollTop !== old, old);
        selected = await root.evaluate((el) => el.scrollTop);
        const visible = await root.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return document
            .elementFromPoint(r.left + 15, r.top + 9)
            ?.closest('.term-row')
            ?.textContent?.trim();
        });
        assert.equal(visible, 'anchor 110');
      }
      const actual = await root.evaluate(async (el) => {
        const w = window as any;
        w.resync();
        w.hold = false;
        for (let i = 0; i < 9; i++) await new Promise(requestAnimationFrame);
        const r = el.getBoundingClientRect();
        return {
          top: el.scrollTop,
          label: document
            .elementFromPoint(r.left + 15, r.top + 9)
            ?.closest('.term-row')
            ?.textContent?.trim(),
        };
      });
      const expected = { top: selected + (wheel ? 90 * before.pitch : 0), label: `anchor ${wheel ? 110 : 100}` };
      t.diagnostic(`overlapping reattach (wheel=${wheel}): ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
      assert.deepEqual(actual, expected);
      await page.close();
    });

  for (const action of ['scroll', 'type', 'Find']) {
    await t.test(`${action} supersedes the saved reader while reattach paint is pending`, async () => {
      const { page, root, before } = await savedDesk();
      await page.evaluate(() => {
        const w = window as any;
        w.fitDuringAttach = true;
        w.hold = true;
        const move = () => {
          if (w.hold) {
            window.dispatchEvent(new Event('resize'));
            requestAnimationFrame(move);
          }
        };
        move();
      });
      await page.getByRole('button', { name: 'Raw TTY', exact: true }).click();
      if (action === 'scroll') {
        const old = await root.evaluate((el) => el.scrollTop);
        await root.hover();
        await page.mouse.wheel(0, -180);
        await page.waitForFunction((old) => document.querySelector('.office-wterm')!.scrollTop < old, old);
      } else if (action === 'type') {
        await root.locator('textarea').focus();
        await page.keyboard.type('x');
        assert.ok(await page.evaluate(() => (window as any).inputs.includes('x')));
      } else {
        await root.locator('textarea').focus();
        await page.keyboard.press((await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))) ? 'Meta+f' : 'Control+Shift+f');
        await page.getByRole('textbox', { name: 'Find in terminal' }).fill('anchor 145');
      }
      const actual = await root.evaluate(async (el) => {
        const w = window as any;
        w.resync();
        w.hold = false;
        for (let i = 0; i < 9; i++) await new Promise(requestAnimationFrame);
        return el.scrollTop;
      });
      assert.notEqual(actual, before.top + 90 * before.pitch);
      await page.close();
    });
  }
});
