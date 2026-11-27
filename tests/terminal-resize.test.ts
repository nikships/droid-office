import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFixture } from './helpers/terminal-fixture.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('inline terminals follow pane geometry without focus or stale size rollbacks', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const mountFixture = await terminalFixture(t);
  const rig = async (shared = true, delaySnapshot = false, hidden = false, mode = 'inline', pageHidden = false) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    t.after(async () => {
      await page.close();
      assert.deepEqual(errors, []);
    });
    await mountFixture(page, '<button id="focus">Keep focus here</button><div id="mount"></div><div id="modal-root"></div>');
    await page.evaluate(
      ({ shared, delaySnapshot, hidden, mode, pageHidden }) => {
        const w = window as any;
        w.visibility = (nextHidden: boolean) => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: nextHidden });
          document.dispatchEvent(new Event('visibilitychange'));
        };
        w.visibility(pageHidden);
        const { Terminal, store, openTerminal, openOfficeShell, routeTerminalMessage, OFFICE_SHELL_ID } = w.TerminalUI;
        const open = Terminal.prototype.open;
        Terminal.prototype.open = function (host: HTMLElement) {
          w.term = this;
          return open.call(this, host);
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
            if ((msg.t === 'worker.attach' || msg.t === 'shell.attach') && !delaySnapshot) queueMicrotask(w.snapshot);
            return true;
          },
          onStatus(fn: any) {
            w.connectionStatus = fn;
            return () => {};
          },
        };
        w.snapshot = (data = '') => routeTerminalMessage({ t: 'term.snapshot', workerId: mode === 'shell' ? OFFICE_SHELL_ID : worker.id, data, cols: worker.cols, rows: worker.rows, shared });
        w.update = (cols = worker.cols, rows = worker.rows) => {
          Object.assign(worker, { cols, rows });
          if (mode === 'shell') {
            store.screens.set(OFFICE_SHELL_ID, { cols, rows });
            store.emit('screens');
          } else store.apply({ t: 'worker.update', worker: { ...worker } });
        };
        w.resize = (width: number, height: number) => {
          mount.style.width = `${width}px`;
          mount.style.height = `${height}px`;
        };
        w.sizes = () => w.messages.filter((m: any) => m.t === 'term.resize' || m.t === 'shell.resize').map(({ cols, rows }: any) => [cols, rows]);
        w.frames = async () => {
          for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
        };
        document.getElementById('focus')!.focus();
        if (mode === 'shell') openOfficeShell(w.net);
        else if (mode === 'modal') {
          worker.kind = 'shell';
          openTerminal(w.net, worker.id);
        } else w.handle = openTerminal(w.net, worker.id, undefined, undefined, { mount, focus: false });
      },
      { shared, delaySnapshot, hidden, mode, pageHidden },
    );
    await page.waitForFunction(() => !!(window as any).term?.native?.element);
    if (!delaySnapshot && !pageHidden) await page.waitForFunction(() => !(window as any).term.options.disableStdin);
    await page.evaluate(() => (window as any).frames());
    return page;
  };

  for (const mode of ['inline', 'modal', 'shell']) {
    await t.test(`${mode} fits visible cells inside padding and refits shared views on layout and font changes`, async () => {
      const page = await rig(true, false, false, mode);
      assert.deepEqual(await page.evaluate(() => (window as any).sizes()), []);
      if (mode === 'inline') await page.evaluate(() => (window as any).resize(700, 400));
      else await page.setViewportSize({ width: 1024, height: 700 });
      await page.evaluate(() => (window as any).frames());
      assert.equal(await page.evaluate(() => (window as any).sizes().length), 1);
      const fits = () =>
        page.evaluate(() => {
          const host = document.querySelector('.term-host')!.getBoundingClientRect();
          const screen = document.querySelector('.term-grid')!.getBoundingClientRect();
          return screen.right <= host.right - 4 && screen.bottom <= host.bottom - 4 ? true : { host: host.toJSON(), screen: screen.toJSON() };
        });
      assert.equal(await fits(), true, 'last row and column must stay inside the padded host');
      await page.evaluate(() => {
        const w = window as any;
        for (const size of w.sizes()) w.update(...size);
        w.update(90, 25);
        w.messages = [];
        w.TerminalUI.setTermFontSize(20);
      });
      await page.evaluate(() => (window as any).frames());
      assert.equal(await page.evaluate(() => (window as any).sizes().length), 1, 'font change reclaims shared sizing');
      assert.equal(await fits(), true);
    });
  }

  for (const mode of ['inline', 'shell']) {
    await t.test(`${mode} enables clipboard and input only after snapshot and pending output drain`, async () => {
      const page = await rig(true, true, false, mode);
      const result = await page.evaluate(async (mode) => {
        const w = window as any;
        const writes: string[] = [];
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => writes.push(value) } });
        const data = (value: string) => w.TerminalUI.routeTerminalMessage({ t: 'term.data', workerId: mode === 'shell' ? w.TerminalUI.OFFICE_SHELL_ID : 'pixel', data: value });
        const marker = '\x1b]52;c;cHJvb2Y=\x07\x1b[6n';
        const initial = !!w.term.options.disableStdin;
        w.snapshot(marker);
        data(marker);
        await w.frames();
        const afterDrain = writes.length;
        data(marker);
        const live = writes.length;
        w.net.up = false;
        w.connectionStatus?.(false);
        data(marker);
        w.net.up = true;
        w.connectionStatus?.(true);
        data(marker);
        w.snapshot(marker);
        data(`${marker}\x1b]52;c;b2xk`);
        await w.frames();
        data('\x07'); // Live terminator of an OSC that started in the attach backlog.
        const reattached = writes.length;
        data(marker);
        return { initial, afterDrain, live, reattached, total: writes.length, ptyInput: w.messages.filter((m: any) => m.t.endsWith('.input')) };
      }, mode);
      assert.deepEqual(result, { initial: true, afterDrain: 0, live: 1, reattached: 1, total: 2, ptyInput: [] });
    });

    await t.test(`${mode} forwards focus changes once and never claims size for them`, async () => {
      const page = await rig(true, false, false, mode);
      // The Boss Shell focuses itself shortly after opening; let that land before taking focus away.
      if (mode === 'shell') await page.waitForFunction(() => document.activeElement === (window as any).term.textarea);
      await page.evaluate(() => {
        document.getElementById('focus')!.focus();
        (window as any).messages = [];
      });
      const reports = async (enable = 0) =>
        page.evaluate(async (enable) => {
          const w = window as any;
          // Droid turns focus reporting on again each time it regains focus.
          for (let i = 0; i < enable; i++) await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
          return { input: w.messages.filter((m: any) => m.t === 'term.input' || m.t === 'shell.input').map((m: any) => m.data), sizes: w.sizes() };
        }, enable);
      assert.deepEqual(await reports(3), { input: [], sizes: [] }, 'an unfocused window stays silent when focus reporting turns on');
      await page.evaluate(() => (window as any).term.focus());
      assert.deepEqual(await reports(3), { input: ['\x1b[I'], sizes: [] }, 'focus-in is sent once, not echoed for every re-enable');
      await page.evaluate(() => document.getElementById('focus')!.focus());
      assert.deepEqual(await reports(2), { input: ['\x1b[I', '\x1b[O'], sizes: [] });
      await page.evaluate(() => (window as any).term.input('x'));
      assert.equal((await reports()).sizes.length, 1, 'typing still claims the size');
    });

    await t.test(`${mode} sends focus-in again after focus changed while a snapshot loaded`, async () => {
      const page = await rig(true, false, false, mode);
      if (mode === 'shell') await page.waitForFunction(() => document.activeElement === (window as any).term.textarea);
      const sent = () => page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'term.input' || m.t === 'shell.input').map((m: any) => m.data));
      await page.evaluate(async () => {
        const w = window as any;
        w.term.focus();
        w.messages = [];
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
        document.getElementById('focus')!.focus();
        w.term.focus();
        // A fresh snapshot loads, and focus leaves while it does: that focus-out never reaches the program.
        w.snapshot();
        document.getElementById('focus')!.focus();
      });
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await sent(), ['\x1b[I']);
      await page.evaluate(async () => {
        const w = window as any;
        w.term.focus();
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
      });
      assert.deepEqual(await sent(), ['\x1b[I'], 'enabling focus mode on an already-focused terminal is not a focus transition');
      await page.locator('#focus').focus();
      await page.evaluate(() => (window as any).term.focus());
      assert.deepEqual(await sent(), ['\x1b[I', '\x1b[I'], 'the returning focus-in is not mistaken for a repeat');
    });

    await t.test(`${mode} keeps forwarding focus when it stays focused through a snapshot`, async () => {
      const page = await rig(true, false, false, mode);
      if (mode === 'shell') await page.waitForFunction(() => document.activeElement === (window as any).term.textarea);
      const sent = () => page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'term.input' || m.t === 'shell.input').map((m: any) => m.data));
      await page.evaluate(async () => {
        const w = window as any;
        w.term.focus();
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
        w.messages = [];
        // A snapshot carries the program's modes, focus reporting among them.
        w.snapshot('\x1b[?1004h');
      });
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await sent(), ['\x1b[I'], 'the snapshot reasserts this window’s focus');
      await page.evaluate(async () => {
        const w = window as any;
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
        document.getElementById('focus')!.focus();
      });
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await sent(), ['\x1b[I', '\x1b[O'], 'the next blur reaches the program');
    });
  }

  await t.test('shell acknowledgements do not roll back rapid resizes and external sizes stay passive', async () => {
    const page = await rig(false, false, false, 'shell');
    await page.evaluate(() => {
      const w = window as any;
      w.update(w.term.cols, w.term.rows);
      w.messages = [];
    });
    for (const width of [1440, 1024, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => (window as any).frames());
    }
    const final = await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]);
    const sizes = await page.evaluate(() => (window as any).sizes());
    assert.equal(sizes.length, 3);
    for (const size of sizes) {
      await page.evaluate((size) => (window as any).update(...size), size);
      assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), final);
    }
    await page.evaluate(() => {
      const w = window as any;
      w.update(90, 25);
      w.messages = [];
    });
    await page.evaluate(() => (window as any).frames());
    assert.deepEqual(await page.evaluate(() => [(window as any).term.cols, (window as any).term.rows]), [90, 25]);
    assert.equal(await page.evaluate(() => (window as any).sizes().length), 0, 'following another viewer must not create a resize loop');
    await page.evaluate(() => (window as any).term.input('x'));
    assert.equal(await page.evaluate(() => (window as any).sizes().length), 1, 'typing explicitly reclaims size');
  });

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

  await t.test('a hidden following pane detaches once, ignores late snapshots, and hydrates once on return', async () => {
    const page = await rig();
    await page.evaluate(() => {
      const w = window as any;
      w.messages = [];
      w.writes = 0;
      const write = w.term.write.bind(w.term);
      w.term.write = (...args: any[]) => {
        w.writes++;
        return write(...args);
      };
      w.visibility(true);
      w.visibility(true);
      w.handle.attach();
      w.snapshot();
      w.TerminalUI.routeTerminalMessage({ t: 'term.data', workerId: 'pixel', data: 'invisible output' });
    });
    assert.deepEqual(
      await page.evaluate(() => {
        const w = window as any;
        return { messages: w.messages.map((m: any) => m.t), writes: w.writes, stdinDisabled: w.term.options.disableStdin };
      }),
      { messages: ['worker.detach'], writes: 0, stdinDisabled: true },
    );
    await page.evaluate(() => (window as any).visibility(false));
    await page.waitForFunction(() => !(window as any).term.options.disableStdin);
    await page.evaluate(() => (window as any).visibility(false));
    assert.deepEqual(await page.evaluate(() => (window as any).messages.map((m: any) => m.t)), ['worker.detach', 'worker.attach']);
    await page.evaluate(() => {
      const w = window as any;
      w.handle.close();
      w.messages = [];
      w.visibility(true);
      w.visibility(false);
    });
    assert.deepEqual(await page.evaluate(() => (window as any).messages), []);
  });

  await t.test('initially hidden panes wait for visibility; reconnecting while hidden does not attach early', async () => {
    const page = await rig(true, false, false, 'inline', true);
    assert.deepEqual(await page.evaluate(() => (window as any).messages.map((m: any) => m.t)), ['worker.detach']);
    await page.evaluate(() => {
      const w = window as any;
      w.net.up = false;
      w.connectionStatus(false);
      w.net.up = true;
      w.connectionStatus(true);
      w.handle.attach();
    });
    assert.equal(await page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'worker.attach').length), 0);
    await page.evaluate(() => (window as any).visibility(false));
    await page.waitForFunction(() => !(window as any).term.options.disableStdin);
    assert.equal(await page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'worker.attach').length), 1);
  });

  await t.test('a scrolled-up reader keeps its exact history and input readiness across backgrounding', async () => {
    const page = await rig();
    await page.evaluate(async () => {
      const w = window as any;
      await new Promise<void>((resolve) => w.term.write(Array.from({ length: 100 }, (_, i) => `history ${i}\r\n`).join(''), resolve));
      await new Promise(requestAnimationFrame);
      w.term.native.element.scrollTop = 0;
    });
    await page.waitForFunction(() => {
      const b = (window as any).term.buffer.active;
      return b.baseY > 0 && b.viewportY === 0;
    });
    const before = await page.evaluate(() => {
      const w = window as any;
      w.messages = [];
      w.visibility(true);
      return { viewport: w.term.buffer.active.viewportY, base: w.term.buffer.active.baseY };
    });
    assert.ok(before.base > before.viewport);
    await page.evaluate(() => (window as any).visibility(false));
    assert.deepEqual(await page.evaluate(() => (window as any).messages), []);
    assert.equal(await page.evaluate(() => (window as any).term.buffer.active.viewportY), before.viewport);
    assert.equal(await page.evaluate(() => (window as any).term.options.disableStdin), false);
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
      [8000, 8000, [400, 200]],
    ] as const) {
      await page.evaluate(([width, height]) => (window as any).resize(width, height), [width, height]);
      await page.evaluate(() => (window as any).frames());
      assert.deepEqual(await page.evaluate(() => (window as any).sizes().at(-1)), expected);
      await page.evaluate((size) => (window as any).update(...size), expected);
    }
    const count = await page.evaluate(() => (window as any).sizes().length);
    await page.evaluate(() => (window as any).resize(8500, 8500));
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
