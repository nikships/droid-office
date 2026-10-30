import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('inline terminals follow pane geometry without focus or stale size rollbacks', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const bundle = buildSync({
    stdin: {
      contents: "export { openTerminal, routeTerminalMessage } from './src/client/ui/terminal'; export { store } from './src/client/state'; export { Terminal } from '@xterm/xterm';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'TerminalUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
  const xtermCss = await readFile(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
  const rig = async (shared = true, delaySnapshot = false, hidden = false) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    t.after(async () => {
      await page.close();
      assert.deepEqual(errors, []);
    });
    await page.setContent('<!doctype html><button id="focus">Keep focus here</button><div id="mount"></div><div id="modal-root"></div>');
    await page.addStyleTag({ content: css + xtermCss });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(
      ({ shared, delaySnapshot, hidden }) => {
        const w = window as any;
        const { Terminal, store, openTerminal, routeTerminalMessage } = w.TerminalUI;
        const open = Terminal.prototype.open;
        Terminal.prototype.open = function (host: HTMLElement) {
          w.term = this;
          open.call(this, host);
        };
        const mount = document.getElementById('mount')!;
        mount.style.width = '600px';
        mount.style.height = '350px';
        if (hidden) mount.style.display = 'none';
        const worker = { id: 'pixel', name: 'Pixel', kind: 'agent', color: '#89d9ed', status: 'idle', cols: 120, rows: 40, open: shared };
        store.workers.set(worker.id, worker);
        w.messages = [];
        w.connectionStatus = undefined;
        w.net = {
          up: true,
          send(msg: any) {
            w.messages.push(msg);
            if (msg.t === 'worker.attach' && !delaySnapshot) queueMicrotask(w.snapshot);
            return true;
          },
          onStatus(fn: any) {
            w.connectionStatus = fn;
            return () => {};
          },
        };
        w.snapshot = () => routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data: '', cols: worker.cols, rows: worker.rows, shared });
        w.update = (cols = worker.cols, rows = worker.rows) => {
          Object.assign(worker, { cols, rows });
          store.apply({ t: 'worker.update', worker: { ...worker } });
        };
        w.resize = (width: number, height: number) => {
          mount.style.width = `${width}px`;
          mount.style.height = `${height}px`;
        };
        w.sizes = () => w.messages.filter((m: any) => m.t === 'term.resize').map(({ cols, rows }: any) => [cols, rows]);
        w.frames = async () => {
          for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
        };
        document.getElementById('focus')!.focus();
        w.handle = openTerminal(w.net, worker.id, undefined, undefined, { mount, focus: false });
      },
      { shared, delaySnapshot, hidden },
    );
    await page.waitForFunction(() => !!(window as any).term?.element);
    if (!delaySnapshot) await page.waitForFunction(() => !(window as any).term.options.disableStdin);
    await page.evaluate(() => (window as any).frames());
    return page;
  };

  await t.test('shared attachment stays passive, but each pane size change claims its new box', async () => {
    const page = await rig();
    assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
    for (const [width, height] of [
      [600, 700],
      [1000, 700],
      [600, 350],
    ]) {
      await page.evaluate(([width, height]) => (window as any).resize(width, height), [width, height]);
      await page.evaluate(() => (window as any).frames());
      const state = await page.evaluate(() => {
        const w = window as any;
        const size = [w.term.cols, w.term.rows];
        // An unrelated status update still has the old server size.
        w.update();
        return { size, after: [w.term.cols, w.term.rows], sent: w.sizes().at(-1), focused: document.activeElement?.id };
      });
      assert.deepEqual(state.sent, state.size);
      assert.deepEqual(state.after, state.size, 'stale worker metadata cannot roll back the local fit');
      assert.equal(state.focused, 'focus');
    }
    await page.evaluate(() => {
      const w = window as any;
      const final = [w.term.cols, w.term.rows];
      for (const [cols, rows] of w.sizes()) {
        w.update(cols, rows);
        if (w.term.cols !== final[0] || w.term.rows !== final[1]) throw Error('An earlier acknowledgement rolled back the final size');
      }
      w.update(90, 25);
    });
    assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), [90, 25], 'a genuine resize from another window is still adopted');
    const before = await page.evaluate(() => (window as any).sizes().length);
    await page.evaluate(() => (window as any).frames());
    assert.equal(await page.evaluate(() => (window as any).sizes().length), before, 'following another window must not create a resize loop');
    await page.evaluate(() => (window as any).resize(700, 400));
    await page.evaluate(() => (window as any).frames());
    assert.equal(await page.evaluate(() => (window as any).sizes().length), before + 1);
  });

  await t.test('initial unshared fit survives the snapshot refresh before its acknowledgement', async () => {
    const page = await rig(false);
    const state = await page.evaluate(() => {
      const w = window as any;
      return { size: [w.term.cols, w.term.rows], sent: w.sizes() };
    });
    assert.equal(state.sent.length, 1);
    assert.deepEqual(state.size, state.sent[0]);
    assert.notDeepEqual(state.size, [120, 40]);
  });

  await t.test('first revealing a shared terminal is passive, including repeated hide/show at the same size', async () => {
    const page = await rig(true, false, true);
    for (const display of ['', 'none', '']) {
      await page.evaluate((display) => {
        document.getElementById('mount')!.style.display = display;
      }, display);
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
    }
  });

  await t.test('A to B to A cannot consume pending acknowledgements from stale status at A', async () => {
    const page = await rig(false);
    const original = await page.evaluate(() => {
      const w = window as any;
      const original = [w.term.cols, w.term.rows];
      w.update(...original);
      w.messages = [];
      return original;
    });
    for (const width of [800, 600]) {
      await page.evaluate((width) => (window as any).resize(width, 350), width);
      await page.evaluate(() => (window as any).frames());
    }
    const sizes = await page.evaluate(() => (window as any).sizes());
    assert.equal(sizes.length, 2);
    assert.deepEqual(sizes[1], original);
    await page.evaluate(() => (window as any).update());
    for (const size of sizes) {
      await page.evaluate((size) => (window as any).update(...size), size);
      assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), original);
    }
  });

  await t.test('pane changes while a snapshot is loading fit when it becomes ready', async () => {
    const page = await rig(true, true);
    await page.evaluate(() => (window as any).resize(900, 600));
    await page.evaluate(() => (window as any).frames());
    assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
    await page.evaluate(() => (window as any).snapshot());
    await page.waitForFunction(() => (window as any).sizes().length === 1);
    assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), await page.evaluate(() => (window as any).sizes()[0]));
  });

  await t.test('small and oversized panes use the PTY limits and do not repeat clamped requests', async () => {
    const page = await rig();
    for (const [width, height, expected] of [
      [100, 50, [20, 5]],
      [5000, 5000, [400, 200]],
    ] as const) {
      await page.evaluate(([width, height]) => (window as any).resize(width, height), [width, height]);
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await page.evaluate(() => (window as any).sizes().at(-1)), expected);
      await page.evaluate((size) => (window as any).update(...size), expected);
    }
    const count = await page.evaluate(() => (window as any).sizes().length);
    await page.evaluate(() => (window as any).resize(5500, 5500));
    await page.evaluate(() => (window as any).frames());
    assert.equal(await page.evaluate(() => (window as any).sizes().length), count);
  });

  await t.test('hidden and disconnected panes do not send sizes; restored panes fit without focus', async () => {
    const page = await rig();
    await page.evaluate(() => {
      document.getElementById('mount')!.style.display = 'none';
      (window as any).resize(800, 500);
    });
    await page.evaluate(() => (window as any).frames());
    assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
    await page.evaluate(() => {
      const w = window as any;
      w.net.up = false;
      w.connectionStatus(false);
      document.getElementById('mount')!.style.display = '';
    });
    await page.evaluate(() => (window as any).frames());
    assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
    await page.evaluate(() => {
      const w = window as any;
      w.net.up = true;
      w.connectionStatus(true);
      w.handle.attach();
    });
    await page.waitForFunction(() => (window as any).sizes().length === 1);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'focus');
    await page.evaluate(() => (window as any).handle.close());
    await page.evaluate(() => (window as any).resize(1000, 700));
    await page.evaluate(() => (window as any).frames());
    assert.equal(await page.evaluate(() => (window as any).sizes().length), 1, 'closed panes stop observing geometry');
  });
});
