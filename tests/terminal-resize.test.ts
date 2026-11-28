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
        localStorage.removeItem('droid-office.term-font');
        const { Terminal, store, openTerminal, openOfficeShell, routeTerminalMessage, OFFICE_SHELL_ID } = w.TerminalUI;
        const open = Terminal.prototype.open;
        Terminal.prototype.open = function (host: HTMLElement) {
          w.term = this;
          return open.call(this, host);
        };
        const mount = document.getElementById('mount')!;
        mount.style.width = '600px';
        mount.style.height = '350px';
        if (mode === 'dashboard' || mode === 'dragging') {
          const body = document.createElement('div');
          body.className = 'dash-body';
          body.style.cssText = 'position:fixed;inset:0';
          const workspace = document.createElement('div');
          workspace.className = mode === 'dragging' ? 'dash-workspace resizing' : 'dash-workspace';
          body.append(document.createElement('aside'), workspace);
          document.body.append(body);
          workspace.append(mount);
          mount.className = 'dash-pane';
          mount.dataset.mode = 'terminal';
          mount.style.cssText = '--x:0;--y:0;--w:0.5;--h:1;--gl:0px;--gr:0px;--gt:0px;--gb:0px';
        }
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
          onMessage: () => () => {},
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
          for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame);
        };
        // A layout observer runs after all rendering rAFs, including wterm's.
        w.eachPaint = (sample: () => void) => {
          const probe = document.createElement('div');
          probe.style.position = 'fixed';
          document.body.append(probe);
          const observer = new ResizeObserver(sample);
          observer.observe(probe);
          let id = requestAnimationFrame(function tick() {
            probe.style.width = probe.style.width === '1px' ? '2px' : '1px';
            id = requestAnimationFrame(tick);
          });
          return () => {
            cancelAnimationFrame(id);
            observer.disconnect();
            probe.remove();
          };
        };
        w.aroundNextFitTask = (before?: () => void, after?: () => void) => {
          const timer = window.setTimeout;
          window.setTimeout = (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
            if (delay !== 0 || typeof fn !== 'function') return timer(fn, delay, ...args);
            window.setTimeout = timer;
            return timer(() => {
              before?.();
              fn(...args);
              after?.();
            }, 0);
          };
        };
        document.getElementById('focus')!.focus();
        if (mode === 'shell') openOfficeShell(w.net);
        else if (mode === 'modal' || mode === 'thread') {
          if (mode === 'thread') localStorage.setItem('droid-office.desk-thread-view:pixel', 'raw');
          else worker.kind = 'shell';
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
    await t.test(`${mode} paints a text-size step with its fitted grid, including a burst`, async () => {
      const page = await rig(false, false, false, mode);
      const results = await page.evaluate(async () => {
        const w = window as any;
        const root: HTMLElement = w.term.native.element;
        const sample = () => [getComputedStyle(root.querySelector('.term-row')!).fontSize, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length, w.term.cols];
        const steps = [];
        for (const sizes of [[16], [14], [16, 18, 20, 22, 24]]) {
          const before = sample();
          w.update(w.term.cols, w.term.rows);
          w.messages = [];
          const frames: (string | number)[][] = [];
          const stop = w.eachPaint(() => frames.push(sample()));
          for (const px of sizes) {
            w.TerminalUI.setTermFontSize(px);
            await new Promise(requestAnimationFrame);
          }
          await w.frames();
          stop();
          steps.push({ before, after: sample(), frames, sent: w.sizes(), px: sizes.at(-1) });
        }
        return steps;
      });
      for (const { before, after, frames, sent, px } of results) {
        assert.equal(after[0], `${px}px`);
        assert.notEqual(before[2], after[2]);
        assert.deepEqual(sent, [[after[2], after[1]]]);
        assert.ok(frames.some((frame) => frame[0] === after[0]));
        for (const frame of frames) assert.deepEqual(frame, frame[0] === before[0] ? before : after, 'no intermediate font or partially refitted grid');
      }
    });

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
    await t.test(`${mode} sends 30 settled keystrokes without measuring or resizing`, async () => {
      const page = await rig(true, false, false, mode);
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type('x');
      assert.equal(await page.evaluate(() => (window as any).sizes().length), 1, 'first input claims the shared grid');
      await page.evaluate(() => {
        const w = window as any;
        w.messages = [];
        w.proposals = 0;
        const propose = w.term.proposeDimensions.bind(w.term);
        w.term.proposeDimensions = () => {
          w.proposals++;
          return propose();
        };
        // Apart from the adapter's proposal, the old input path read the host itself.
        const host = document.querySelector('.term-host')!;
        for (const name of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight', 'getBoundingClientRect'])
          Object.defineProperty(host, name, {
            get: () => {
              throw Error(`input measured ${name}`);
            },
          });
      });
      await page.keyboard.type('abcdefghijklmnopqrstuvwxyzabcd');
      assert.deepEqual(
        await page.evaluate(() => {
          const w = window as any;
          return [w.proposals, w.sizes().length, w.messages.filter((m: any) => m.t.endsWith('.input')).length];
        }),
        [0, 0, 30],
      );
    });
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
      // No notification is emitted for a blur while reporting is off. The next real focus-in still counts.
      await page.evaluate(async () => {
        const w = window as any;
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004l', resolve));
        document.getElementById('focus')!.focus();
      });
      assert.deepEqual(await reports(1), { input: ['\x1b[I'], sizes: [] });
      await page.evaluate(() => (window as any).term.focus());
      assert.deepEqual(await reports(), { input: ['\x1b[I', '\x1b[I'], sizes: [] }, 'off/on between transitions does not suppress the next focus-in');
      await page.evaluate(() => document.getElementById('focus')!.focus());
      assert.deepEqual(await reports(2), { input: ['\x1b[I', '\x1b[I', '\x1b[O'], sizes: [] });
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
      assert.deepEqual(await sent(), ['\x1b[O', '\x1b[I'], 'first blur after mode enable is a real transition');
      await page.evaluate(async () => {
        const w = window as any;
        w.term.focus();
        await new Promise<void>((resolve) => w.term.write('\x1b[?1004h', resolve));
      });
      assert.deepEqual(await sent(), ['\x1b[O', '\x1b[I'], 'enabling focus mode on an already-focused terminal is not a focus transition');
      await page.locator('#focus').focus();
      await page.evaluate(() => (window as any).term.focus());
      assert.deepEqual(await sent(), ['\x1b[O', '\x1b[I', '\x1b[O', '\x1b[I'], 'both real transitions reach the program');
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

  await t.test('an unpainted snapshot accepts keyboard input but not pointer reports', async () => {
    const page = await rig(true, true);
    await page.evaluate(() => (window as any).snapshot('\x1b[?1000h\x1b[?1006h\x1b[?2026h'));
    const root = page.locator('.office-wterm');
    await page.waitForFunction(() => !(window as any).term.options.disableStdin && !!document.querySelector('.office-wterm.replaying'));
    await page.evaluate(() => (window as any).term.focus());
    await page.keyboard.type('k');
    const bounds = (await root.boundingBox())!;
    await page.mouse.click(bounds.x + 25, bounds.y + 34);
    const input = await page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'term.input').map((m: any) => m.data));
    assert.deepEqual(input, ['k']);
    await page.evaluate(() => (window as any).term.write('\x1b[?2026l'));
    await page.waitForFunction(() => !document.querySelector('.office-wterm.replaying'));
    await page.keyboard.type('z');
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).data), 'z', 'the concealed click leaves keyboard input at the terminal');
    await page.mouse.click(bounds.x + 25, bounds.y + 34);
    assert.match(await page.evaluate(() => (window as any).messages.at(-1).data), /^\x1b\[<0;/);
  });

  for (const mode of ['shell', 'dragging']) {
    await t.test(`${mode} reveals its first grid only after a queued exclusive fit`, async () => {
      const page = await rig(false, true, false, mode);
      if (mode === 'shell') {
        await page.setViewportSize({ width: 1450, height: 900 });
        await page.evaluate(() => (window as any).frames());
      }
      await page.evaluate((mode) => {
        const w = window as any,
          el = w.term.native.element;
        w.firstVisible = new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (el.classList.contains('replaying')) return;
            observer.disconnect();
            resolve({ grid: [w.term.cols, w.term.rows], sizes: w.sizes() });
          });
          observer.observe(el, { attributes: true, attributeFilter: ['class'] });
        });
        if (mode === 'shell') window.addEventListener('resize', () => w.snapshot('first screen'), { once: true });
        else w.snapshot('first screen');
      }, mode);
      if (mode === 'shell') await page.setViewportSize({ width: 1510, height: 900 });
      else
        await page.evaluate(async () => {
          const w = window as any;
          await w.frames();
          document.querySelector('.dash-workspace')!.classList.remove('resizing');
        });
      const result = await page.evaluate(async () => {
        const w = window as any,
          first = await w.firstVisible,
          fit = w.term.proposeDimensions();
        return { first, expected: [fit.cols, fit.rows] };
      });
      assert.deepEqual(result.first, { grid: result.expected, sizes: [result.expected] });
    });
  }

  await t.test('showing a tab during a continuing drag waits for release before claiming size', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const result = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!,
        ws = raw.parentElement!;
      w.messages = [];
      ws.classList.add('resizing');
      raw.style.setProperty('--w', '.6');
      await w.frames();
      w.visibility(true);
      w.visibility(false);
      await w.frames();
      raw.style.setProperty('--w', '.7');
      await w.frames();
      const during = w.sizes();
      ws.classList.remove('resizing');
      await w.frames();
      const { cols, rows } = w.term.proposeDimensions();
      return { during, after: w.sizes(), expected: [cols, rows] };
    });
    assert.deepEqual(result.during, []);
    assert.deepEqual(result.after, [result.expected]);
  });

  for (const first of [false, true]) {
    await t.test(`disconnect cancels the ${first ? 'first' : 'replacement'} snapshot paint hold`, async () => {
      const page = await rig(true, true);
      const state = await page.evaluate(async (first) => {
        const w = window as any,
          el = w.term.native.element;
        if (!first) {
          w.snapshot('previous screen');
          await w.frames();
        }
        w.snapshot('incomplete snapshot');
        w.net.up = false;
        w.connectionStatus(false);
        await w.frames();
        return [!!w.term.paintSignal, el.classList.contains('replaying'), el.textContent.includes('incomplete snapshot')];
      }, first);
      assert.deepEqual(state, [true, first, false]);
    });
  }

  for (const mode of ['inline', 'shell']) {
    await t.test(`${mode} keeps a painted grid visible throughout a same-size resync`, async () => {
      const page = await rig(true, true, false, mode);
      const frames = await page.evaluate(async () => {
        const w = window as any,
          el = w.term.native.element;
        w.snapshot('old screen');
        await w.frames();
        const sample = () => [getComputedStyle(el).opacity, el.querySelector('.term-grid').textContent.trim()];
        w.snapshot('new screen');
        const samples = [sample()];
        for (let i = 0; i < 5; i++) {
          await new Promise(requestAnimationFrame);
          samples.push(sample());
        }
        return samples;
      });
      assert.ok(
        frames.every(([opacity, text]) => opacity === '1' && /old screen|new screen/.test(text)),
        JSON.stringify(frames),
      );
      assert.match(frames.at(-1)![1], /new screen/);
    });
  }

  await t.test('a late detached snapshot cannot conceal the last visible grid', async () => {
    const page = await rig(true, true);
    const result = await page.evaluate(async () => {
      const w = window as any,
        el = w.term.native.element;
      w.snapshot('old screen');
      await w.frames();
      w.visibility(true);
      w.snapshot('late screen');
      w.visibility(false);
      await w.frames();
      return [el.classList.contains('replaying'), getComputedStyle(el).opacity, el.querySelector('.term-grid').textContent.trim()];
    });
    assert.deepEqual(result, [false, '1', 'old screen']);
  });

  await t.test('a viewport resize with no box change releases the next input claim', async () => {
    const page = await rig(true);
    const sizes = await page.evaluate(async () => {
      const w = window as any;
      window.dispatchEvent(new Event('resize'));
      await w.frames();
      w.term.input('x');
      return w.sizes();
    });
    assert.equal(sizes.length, 1);
  });

  await t.test('a stepped width animation retains its grid through quiet intermediate boxes', async () => {
    const page = await rig(false);
    const result = await page.evaluate(async () => {
      const w = window as any,
        pane = document.getElementById('mount')!;
      w.messages = [];
      const start = w.term.cols;
      const movement = pane.animate([{ width: '600px' }, { width: '400px' }], { duration: 500, easing: 'steps(3)', fill: 'forwards' });
      await movement.ready;
      const intermediate = [];
      while (movement.playState === 'running') {
        if (pane.offsetWidth < 600 && pane.offsetWidth > 400) intermediate.push([w.term.cols, w.sizes().length]);
        await new Promise(requestAnimationFrame);
      }
      await w.frames();
      return { start, intermediate, after: w.sizes(), final: w.term.cols };
    });
    assert.ok(result.intermediate.length > 1);
    assert.ok(result.intermediate.every(([cols, packets]: number[]) => cols === result.start && packets === 0));
    assert.deepEqual(
      result.after.map(([cols]: number[]) => cols),
      [result.final],
    );
    assert.ok(result.final < result.start);
  });

  await t.test('trusted paging during a shrinking layout leaves the reader at the paged offset', async () => {
    const page = await rig(false);
    await page.evaluate(async () => {
      const w = window as any,
        pane = document.getElementById('mount')!;
      w.term.write(Array.from({ length: 180 }, (_, i) => `line ${i}\r\n`).join(''));
      w.term.scrollToBottom();
      w.term.focus();
      await w.frames();
      // Two 12px steps: PageDown has 12px less travel than PageUp, and
      // the new bottom is 12px farther away. The reader should finish 24px up.
      pane.style.transition = 'height 60s steps(4)';
      pane.style.height = '302px';
      w.shrink = pane.getAnimations()[0];
      w.shrink.currentTime = 16000;
      await w.frames();
    });
    await page.keyboard.press('Shift+PageUp');
    await page.evaluate(async () => {
      const w = window as any;
      await w.frames();
      w.shrink.currentTime = 31000;
      await w.frames();
    });
    await page.keyboard.press('Shift+PageDown');
    const gap = await page.evaluate(async () => {
      const w = window as any;
      await w.frames();
      const el = w.term.native.element;
      return el.scrollHeight - el.clientHeight - el.scrollTop;
    });
    assert.equal(gap, 24);
  });

  for (const reading of [false, true]) {
    await t.test(`an animated shrink preserves the ${reading ? 'reader offset' : 'tail'} through intermediate boxes`, async () => {
      const page = await rig(false);
      const result = await page.evaluate(async (reading) => {
        const w = window as any,
          term = w.term,
          root = term.native.element,
          pane = document.getElementById('mount')!;
        term.write(Array.from({ length: 180 }, (_, i) => `line ${i}\r\n`).join(''));
        term.scrollToBottom();
        await w.frames();
        if (reading) root.scrollTop -= 280;
        await w.frames();
        const start = root.scrollTop,
          offset = () => (reading ? Math.abs(root.scrollTop - start) : root.scrollHeight - root.clientHeight - root.scrollTop),
          offsets: number[] = [];
        w.messages = [];
        const observation = term.onFit(() => offsets.push(offset()));
        pane.style.transition = 'height 320ms ease';
        pane.style.height = '210px';
        const shrink = pane.getAnimations()[0];
        // rAF runs before ResizeObserver. The first shrinking frame must already be pinned.
        let frames = 0;
        while (shrink.playState === 'running') {
          await new Promise(requestAnimationFrame);
          offsets.push(offset());
          if (++frames === 3) term.write('in flight\r\n');
        }
        await shrink.finished;
        await w.frames();
        observation.dispose();
        return { offsets, final: offset(), sizes: w.sizes(), live: root.textContent.includes('in flight') };
      }, reading);
      assert.ok(result.offsets.length > 2);
      assert.ok(Math.max(...result.offsets, result.final) < 1, JSON.stringify(result));
      assert.equal(result.sizes.length, 1);
      assert.equal(result.live, true);
    });
  }

  await t.test('the first painted snapshot stays concealed while its observed fit is pending', async () => {
    const page = await rig(false, true, false, 'dashboard');
    const state = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!,
        el = w.term.native.element;
      const painted = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (!el.querySelector('.term-grid').textContent.includes('first screen')) return;
          observer.disconnect();
          raw.parentElement!.classList.add('resizing');
          raw.style.setProperty('--w', '.7');
          resolve();
        });
        observer.observe(el, { subtree: true, childList: true, characterData: true });
      });
      w.snapshot('first screen');
      await painted;
      await w.frames();
      const during = getComputedStyle(el).opacity;
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      await w.frames();
      return [during, getComputedStyle(el).opacity, w.term.cols, w.term.proposeDimensions().cols];
    });
    assert.deepEqual(state, ['0', '1', state[3], state[3]]);
  });

  await t.test('a sidebar toggle with a covered Raw terminal emits at most one resize', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const sizes = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!;
      raw.classList.add('covered');
      const thread = document.createElement('section');
      thread.className = 'dash-pane';
      thread.dataset.mode = 'thread';
      raw.after(thread);
      w.messages = [];
      const body = document.querySelector('.dash-body')!;
      body.classList.add('side-closed');
      await w.frames();
      await Promise.all(body.getAnimations().map((a) => a.finished));
      await w.frames();
      return w.sizes();
    });
    assert.ok(sizes.length <= 1, JSON.stringify(sizes));
  });

  await t.test('typing at successive splitter positions sends bytes immediately but claims only the final size', async () => {
    const page = await rig(true, false, false, 'dashboard');
    const sizes = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!;
      raw.parentElement!.classList.add('resizing');
      for (const [width, key] of [
        ['.4', 'a'],
        ['.7', 'b'],
      ]) {
        raw.style.setProperty('--w', width);
        await w.frames();
        w.term.input(key);
      }
      const during = w.sizes(),
        bytes = w.messages.filter((m: any) => m.t === 'term.input').map((m: any) => m.data);
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      const { cols, rows } = w.term.proposeDimensions();
      return { during, bytes, after: w.sizes(), expected: [cols, rows] };
    });
    assert.deepEqual(sizes.bytes, ['a', 'b']);
    assert.deepEqual(sizes.during, []);
    assert.deepEqual(sizes.after, [sizes.expected]);
  });

  await t.test('stepping text size during a splitter drag keeps both font and grid until release', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const { before, during, after, sizes } = await page.evaluate(async () => {
      const w = window as any;
      const pane = document.querySelector<HTMLElement>('#mount')!;
      const layout = () => [w.term.options.fontSize, w.term.cols, w.term.rows];
      const before = layout();
      w.messages = [];
      pane.parentElement!.classList.add('resizing');
      pane.style.setProperty('--w', '.4');
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      const during = { layout: layout(), sizes: w.sizes() };
      pane.style.setProperty('--w', '.7');
      pane.parentElement!.classList.remove('resizing');
      // Releasing the handle also allows the pane's width transition to finish.
      await new Promise(requestAnimationFrame);
      await Promise.all(pane.getAnimations().map((animation) => animation.finished));
      await w.frames();
      return { before, during, after: layout(), sizes: w.sizes() };
    });
    assert.deepEqual(during, { layout: before, sizes: [] });
    assert.equal(after[0], 16);
    assert.deepEqual(sizes, [after.slice(1)]);
  });

  for (const hide of [false, true]) {
    await t.test(hide ? 'a concealed font step uses the first settled visible box' : 'a box change after observation supersedes the pending font fit', async () => {
      const page = await rig(false, false, false, 'dashboard');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const result = await page.evaluate(async (hide) => {
        const w = window as any;
        const pane = document.querySelector<HTMLElement>('#mount')!;
        const root: HTMLElement = w.term.native.element;
        w.update(w.term.cols, w.term.rows);
        w.messages = [];
        const sample = () => [getComputedStyle(root.querySelector('.term-row')!).fontSize, w.term.cols, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length];
        const before = sample();
        const paints: (string | number)[][] = [];
        const stop = w.eachPaint(() => {
          if (root.clientWidth) paints.push(sample());
        });
        // A layout task runs after the last box observation, immediately before
        // the zero-delay fit commit. Interpose there, not at a guessed wall time.
        w.aroundNextFitTask(() => {
          if (hide) pane.style.display = 'none';
          else pane.style.setProperty('--w', '.35');
        });
        w.TerminalUI.setTermFontSize(16);
        await w.frames();
        const hiddenFont = w.term.options.fontSize;
        if (hide) pane.style.display = '';
        await w.frames();
        await w.frames();
        stop();
        return { before, hiddenFont, after: sample(), sizes: w.sizes(), paints, width: pane.style.getPropertyValue('--w') };
      }, hide);
      if (hide) assert.equal(result.hiddenFont, 14, 'keep the request, not just the old grid, while hidden');
      else assert.equal(result.width, '.35');
      assert.equal(result.after[0], '16px');
      assert.deepEqual(result.sizes, [result.after.slice(1)]);
      for (const frame of result.paints) assert.deepEqual(frame, frame[0] === '14px' ? result.before : result.after);
    });
  }

  await t.test('typing during a shared font-only wait paints the live echo at the next frame', async () => {
    const page = await rig(true);
    const result = await page.evaluate(async () => {
      const w = window as any;
      w.messages = [];
      w.TerminalUI.setTermFontSize(16);
      w.term.input('x');
      w.TerminalUI.routeTerminalMessage({ t: 'term.data', workerId: 'pixel', data: 'LIVE-ECHO' });
      await new Promise(requestAnimationFrame);
      const echo = w.term.native.element.querySelector('.term-grid').textContent.includes('LIVE-ECHO');
      await w.frames();
      return { echo, input: w.messages.filter((m: any) => m.t === 'term.input').map((m: any) => m.data), sizes: w.sizes() };
    });
    assert.deepEqual(result.input, ['x']);
    assert.ok(result.echo, 'do not hold output while coalescing a font choice');
    assert.equal(result.sizes.length, 1);
  });

  await t.test('a scaled pane at a fractional column boundary fits once to the unscaled probe', async () => {
    const page = await rig(false);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const root: HTMLElement = w.term.native.element;
      const pane = document.getElementById('mount')!;
      const probe = root.querySelector('.term-size-probe')!.cloneNode(true) as HTMLElement;
      probe.style.fontSize = '16px';
      root.append(probe);
      const pitch = probe.getBoundingClientRect().width;
      probe.remove();
      const css = getComputedStyle(root);
      const inset = pane.offsetWidth - root.clientWidth + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
      // Round offsetWidth *up* while leaving less than one layout pixel past
      // the last column. A counter-scale based on offsetWidth loses that column.
      let cols = 30;
      for (; cols < 100; cols++) {
        const fraction = (cols * pitch + inset) % 1;
        if (fraction >= 0.5 && fraction < 0.8) break;
      }
      pane.style.width = `${cols * pitch + inset}px`;
      pane.style.transform = 'scale(.83)';
      await w.frames();
      w.update(w.term.cols, w.term.rows);
      w.messages = [];
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      return { cols, observed: w.term.observedDimensions, sizes: w.sizes() };
    });
    assert.ok(result.cols < 100);
    assert.equal(result.observed.cols, result.cols);
    assert.deepEqual(result.sizes, [[result.cols, result.observed.rows]]);
  });

  await t.test('a Boss Shell snapshot becoming ready between a font task and observation takes the new proposal', async () => {
    const page = await rig(false, true, false, 'shell');
    const result = await page.evaluate(async () => {
      const w = window as any;
      w.aroundNextFitTask(undefined, () => w.snapshot('ready'));
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      return { font: w.term.options.fontSize, actual: [w.term.cols, w.term.rows], observed: w.term.observedDimensions, sizes: w.sizes() };
    });
    assert.equal(result.font, 16);
    assert.deepEqual(result.actual, [result.observed.cols, result.observed.rows]);
    assert.deepEqual(result.sizes, [result.actual]);
  });

  for (const [mode, resize] of [
    ['shell', false],
    ['inline', false],
    ['inline', true],
  ] as const) {
    await t.test(`${mode} canceling an unaccepted font step ${resize ? 'preserves a genuine box claim' : 'preserves the shared grid'}`, async () => {
      const page = await rig(true, true, false, mode);
      const result = await page.evaluate(async (resize) => {
        const w = window as any;
        await new Promise<void>((resolve) => {
          w.aroundNextFitTask(undefined, resolve);
          w.TerminalUI.setTermFontSize(16);
        });
        const waiting = w.term.options.fontSize;
        if (resize) {
          w.resize(440, 350);
          await w.frames();
        }
        w.TerminalUI.setTermFontSize(14);
        const probes = w.term.native.element.querySelectorAll('.term-size-probe').length;
        w.snapshot('shared');
        await w.frames();
        await w.frames();
        return { waiting, probes, font: w.term.options.fontSize, grid: [w.term.cols, w.term.rows], fit: w.term.observedDimensions, sizes: w.sizes() };
      }, resize);
      const grid = resize ? [result.fit.cols, result.fit.rows] : [120, 40];
      assert.deepEqual(result.sizes, resize ? [grid] : []);
      assert.deepEqual(result.grid, grid);
      assert.equal(result.waiting, 14);
      assert.equal(result.font, 14);
      assert.equal(result.probes, 1, 'the canceled measurement probe is removed immediately');
    });
  }

  await t.test('a declined font proposal releases the paint hold for a settled pane resize', async () => {
    const page = await rig(true, true);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const holds: boolean[] = [];
      const hold = w.term.setFitPending.bind(w.term);
      w.term.setFitPending = (value: boolean) => {
        holds.push(value);
        hold(value);
      };
      w.resize(440, 350);
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      const waiting = { font: w.term.options.fontSize, sizes: w.sizes(), held: holds.at(-1) };
      w.snapshot();
      await w.frames();
      await w.frames();
      return { waiting, heldDuringResize: holds.includes(true), font: w.term.options.fontSize, grid: [w.term.cols, w.term.rows], sizes: w.sizes() };
    });
    assert.equal(result.heldDuringResize, true);
    assert.deepEqual(result.waiting, { font: 14, sizes: [], held: false });
    assert.equal(result.font, 16);
    assert.deepEqual(result.sizes, [result.grid]);
  });

  await t.test('stepping the font during a synchronized update never paints a partially refitted grid', async () => {
    const page = await rig(false);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const term = w.term;
      const sample = () => [Number.parseFloat(getComputedStyle(term.native.element.querySelector('.term-row')).fontSize), term.native.element.querySelectorAll('.term-row:not(.term-scrollback-row)').length, term.cols];
      const write = (s: string) => new Promise<void>((resolve) => term.write(s, resolve));
      const before = sample();
      const frames: number[][] = [];
      const stop = w.eachPaint(() => frames.push(sample()));
      await write('\x1b[?2026h');
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      const held = sample();
      const synchronized = term.native.bridge.synchronizedOutput?.();
      await write('\x1b[?2026l');
      await w.frames();
      await w.frames();
      stop();
      return { before, held, synchronized, frames, after: sample() };
    });
    assert.equal(result.synchronized, true);
    assert.deepEqual(result.held, result.before, 'keep the original font and grid while the program holds output');
    assert.equal(result.after[0], 16);
    assert.notDeepEqual(result.before.slice(1), result.after.slice(1));
    for (const frame of result.frames) assert.deepEqual(frame, frame[0] === 14 ? result.before : result.after, `synchronized=${result.synchronized}, before close: ${result.held}`);
  });

  await t.test('a synchronized update can start after font commit but before wterm paints', async () => {
    const page = await rig(false);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const root = w.term.native.element;
      const sample = () => {
        const rows = root.querySelectorAll('.term-row:not(.term-scrollback-row)');
        const style = getComputedStyle(rows[0]);
        return [style.fontSize, rows.length, rows[0].offsetHeight, style.getPropertyValue('--term-cell-width')];
      };
      const before = sample();
      const frames: (string | number)[][] = [];
      const stop = w.eachPaint(() => frames.push(sample()));
      w.aroundNextFitTask(undefined, () => w.term.write('\x1b[?2026h'));
      w.TerminalUI.setTermFontSize(16);
      await w.frames();
      await w.frames();
      w.term.write('\x1b[?2026l');
      await w.frames();
      stop();
      return { before, frames, after: sample() };
    });
    assert.equal(result.after[0], '16px');
    assert.notEqual(result.before[1], result.after[1]);
    for (const frame of result.frames) assert.deepEqual(frame, frame[0] === '14px' ? result.before : result.after);
  });

  for (const layout of ['font only', 'pane resize', 'same column count']) {
    await t.test(`a font step keeps the same visible history row on every paint: ${layout}`, async () => {
      const page = await rig(false);
      const result = await page.evaluate(async (layout) => {
        const w = window as any;
        const root: HTMLElement = w.term.native.element;
        const sample = () => {
          const y = root.getBoundingClientRect().top + 2;
          const row = [...root.querySelectorAll<HTMLElement>('.term-row')].find((el) => {
            const box = el.getBoundingClientRect();
            return box.top <= y && box.bottom > y;
          });
          return row?.textContent.trim();
        };
        if (layout === 'same column count') {
          w.resize(140, 350);
          await w.frames();
        }
        const cols = w.term.cols;
        w.term.write(Array.from({ length: 250 }, (_, i) => (i < 80 ? `${i} ${'long prefix '.repeat(6)}` : `passage ${i}`)).join('\r\n'));
        await w.frames();
        const height = Number.parseFloat(getComputedStyle(root).getPropertyValue('--term-row-height'));
        root.scrollTop = root.scrollHeight - root.clientHeight - 35.5 * height;
        await w.frames();
        const before = sample();
        const frames: (string | undefined)[] = [];
        const stop = w.eachPaint(() => frames.push(sample()));
        if (layout === 'pane resize') w.resize(440, 240);
        // A program can start a synchronized redraw between resize and its
        // first paint. The retained rows must keep their old scroll coordinate.
        w.aroundNextFitTask(undefined, () => w.term.write('\x1b[?2026h'));
        w.TerminalUI.setTermFontSize(16);
        await w.frames();
        await w.frames();
        w.term.write('\x1b[?2026l');
        await w.frames();
        stop();
        return { before, frames, after: sample(), font: w.term.options.fontSize, sameCols: cols === w.term.cols };
      }, layout);
      assert.match(result.before ?? '', /^passage \d+$/);
      assert.equal(result.font, 16);
      assert.equal(result.sameCols, layout === 'same column count');
      assert.equal(result.after, result.before);
      assert.deepEqual([...new Set(result.frames)], [result.before]);
    });
  }

  for (const stream of ['reopen every third frame', 'remain open', 'replace every third frame'] as const) {
    await t.test(`a queued font step has one synchronized-output deadline: ${stream}`, async () => {
      const page = await rig(false);
      const result = await page.evaluate(async (stream) => {
        const w = window as any;
        const term = w.term;
        w.messages = [];
        term.write('\x1b[?2026h');
        let start = 0;
        let elapsed = 0;
        let frame = 0;
        let committedFrame = -1;
        let committedOpen = false;
        const set = term.setFontForFit.bind(term);
        term.setFontForFit = (px: number) => {
          elapsed = performance.now() - start;
          committedFrame = frame;
          committedOpen = term.core.synchronizedOutput();
          set(px);
        };
        await new Promise<void>((resolve) => {
          w.aroundNextFitTask(() => (start = performance.now()), resolve);
          w.TerminalUI.setTermFontSize(16);
        });
        while (frame < 9 || (elapsed === 0 && performance.now() - start < 600)) {
          await new Promise(requestAnimationFrame);
          frame++;
          if (stream === 'reopen every third frame' && frame % 3 === 1) term.write('\x1b[?2026l');
          if (stream === 'reopen every third frame' && frame % 3 === 2) term.write('\x1b[?2026h');
          if (stream === 'replace every third frame' && frame % 3 === 0) term.write('\x1b[?2026l\x1b[?2026h');
          term.write(`frame ${frame}\r\n`);
        }
        const open = term.core.synchronizedOutput();
        term.write('\x1b[?2026l');
        await w.frames();
        return { elapsed, committedFrame, committedOpen, open, sizes: w.sizes().length, output: term.native.element.textContent.includes(`frame ${frame}`) };
      }, stream);
      assert.equal(result.sizes, 1);
      assert.equal(result.output, true);
      assert.ok(result.elapsed > 0 && result.elapsed < 300, `commit after ${result.elapsed} ms`);
      if (stream === 'reopen every third frame') {
        assert.equal(result.committedFrame, 1, 'use the first frame between blocks');
        assert.equal(result.committedOpen, false);
      } else {
        assert.ok(result.elapsed >= 249, `held for ${result.elapsed} ms`);
        assert.equal(result.committedOpen, true);
        assert.equal(result.open, true, 'the font commit does not flush the program’s block');
      }
    });
  }

  await t.test('A+ from Thread returns to Raw without painting larger cells on the retained grid', async () => {
    const page = await rig(false, false, false, 'thread');
    await page.getByRole('button', { name: 'Thread', exact: true }).click();
    await page.evaluate(() => (window as any).frames());
    const result = await page.evaluate(async () => {
      const w = window as any;
      const root: HTMLElement = w.term.native.element;
      w.update(w.term.cols, w.term.rows);
      w.messages = [];
      const paints: number[][] = [];
      const stop = w.eachPaint(() => {
        if (root.clientWidth && !root.classList.contains('replaying') && getComputedStyle(root.querySelector('.term-row')!).fontSize === '16px')
          paints.push([w.term.cols, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length]);
      });
      document.querySelector<HTMLButtonElement>('[aria-label="Bigger terminal text"]')!.click();
      await w.frames();
      await w.frames();
      stop();
      return { paints, sizes: w.sizes(), observed: w.term.observedDimensions };
    });
    const grid = [result.observed.cols, result.observed.rows];
    assert.deepEqual(result.sizes, [grid]);
    assert.ok(result.paints.length);
    for (const actual of result.paints) assert.deepEqual(actual, grid);
  });

  await t.test('a second post-commit press paints both fitted grids without holding live output', async () => {
    const page = await rig(false, false, false, 'modal');
    const result = await page.evaluate(async () => {
      const w = window as any;
      const click = () => document.querySelector<HTMLButtonElement>('[aria-label="Bigger terminal text"]')!.click();
      const send = w.net.send.bind(w.net);
      let second = false;
      w.net.send = (msg: any) => {
        if (!second && msg.t === 'term.resize') {
          second = true;
          // Queue the second press after the commit returns, before any paint.
          queueMicrotask(click);
        }
        return send(msg);
      };
      w.messages = [];
      const root: HTMLElement = w.term.native.element;
      const sample = () => [getComputedStyle(root.querySelector('.term-row')!).fontSize, w.term.cols, root.querySelectorAll('.term-row:not(.term-scrollback-row)').length];
      const before = sample();
      const paints: (string | number)[][] = [];
      let firstEcho: boolean | undefined;
      const stop = w.eachPaint(() => {
        paints.push(sample());
        if (!second) return;
        if (firstEcho === undefined && paints.filter((p) => p[0] === '16px').length === 1) w.TerminalUI.routeTerminalMessage({ t: 'term.data', workerId: 'pixel', data: 'NEXT-ECHO' });
        else if (firstEcho === undefined) firstEcho = root.querySelector('.term-grid')!.textContent.includes('NEXT-ECHO');
      });
      click();
      await w.frames();
      await w.frames();
      stop();
      return { before, paints, firstEcho, sizes: w.sizes() };
    });
    assert.equal(result.sizes.length, 2);
    const [first, last] = result.sizes;
    const layouts = [result.before, ['16px', ...first], ['18px', ...last]];
    assert.deepEqual(
      result.paints.filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0]),
      layouts,
    );
    for (const paint of result.paints)
      assert.deepEqual(
        paint,
        layouts.find((layout) => layout[0] === paint[0]),
      );
    assert.equal(result.firstEcho, true, 'superseded font probe must not hold the next echo');
    t.diagnostic(`post-commit press: ${JSON.stringify(layouts)}`);
  });

  await t.test('desk and shell buttons step from their own requested size after another tab changes its preference', async () => {
    for (const mode of ['modal', 'shell']) {
      const page = await rig(false, false, false, mode);
      const other = await context.newPage();
      await other.route(page.url(), (route) => route.fulfill({ contentType: 'text/html', body: '<title>Other tab</title>' }));
      await other.goto(page.url());
      await other.evaluate(() => localStorage.setItem('droid-office.term-font', '22'));
      const result = await page.evaluate(async () => {
        const w = window as any;
        const before = [w.term.options.fontSize, localStorage.getItem('droid-office.term-font')];
        const bigger = document.querySelector<HTMLButtonElement>('[aria-label="Bigger terminal text"]')!;
        bigger.click();
        bigger.click();
        await w.frames();
        return { before, after: w.term.options.fontSize };
      });
      await other.close();
      assert.deepEqual(result, { before: [14, '22'], after: 18 });
    }
  });

  for (const mode of ['inline', 'shell']) {
    await t.test(`${mode} snapshot-ready and input share the settling viewport fit`, async () => {
      const page = await rig(true, true, false, mode);
      const result = await page.evaluate(async () => {
        const w = window as any,
          pane = w.term.native.element.parentElement;
        const observed = () =>
          new Promise<void>((resolve) => {
            const sub = w.term.onFit(() => {
              sub.dispose();
              resolve();
            });
          });
        window.dispatchEvent(new Event('resize'));
        let next = observed();
        pane.style.width = '510px';
        await next;
        w.snapshot();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        w.term.input('x');
        const during = w.sizes(),
          bytes = w.messages.filter((m: any) => m.t.endsWith('.input')).map((m: any) => m.data);
        next = observed();
        pane.style.width = '730px';
        await next;
        await w.frames();
        const { cols, rows } = w.term.proposeDimensions();
        return { bytes, during, after: w.sizes(), expected: [cols, rows] };
      });
      assert.deepEqual(result.bytes, ['x']);
      assert.deepEqual(result.during, []);
      assert.deepEqual(result.after, [result.expected]);
    });
  }

  await t.test('removing the drag class without a pointer event resumes live painting', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const output = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!;
      raw.parentElement!.classList.add('resizing');
      raw.style.setProperty('--w', '.7');
      await w.frames();
      w.term.write('still streaming');
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      return w.term.native.element.textContent;
    });
    assert.match(output, /still streaming/);
  });

  await t.test('hiding a tab or disposing a pane clears its unfinished fit', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const result = await page.evaluate(async () => {
      const w = window as any,
        raw = document.querySelector<HTMLElement>('#mount')!;
      raw.parentElement!.classList.add('resizing');
      raw.style.setProperty('--w', '.7');
      await w.frames();
      w.visibility(true);
      const hiddenFit = w.term.fitting;
      raw.parentElement!.classList.remove('resizing');
      w.visibility(false);
      await w.frames();
      w.term.write('paint after interrupted drag');
      await w.frames();
      const painted = w.term.native.element.textContent.includes('paint after interrupted drag');
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      raw.parentElement!.classList.add('resizing');
      raw.style.setProperty('--w', '.4');
      await w.frames();
      w.messages = [];
      w.handle.close();
      raw.parentElement!.classList.remove('resizing');
      await w.frames();
      return [hiddenFit, painted, w.term.fitting, w.sizes()];
    });
    assert.deepEqual(result, [false, true, false, []]);
  });

  await t.test('the divider stays on the terminal edge, and Thread-only dividers still animate', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const result = await page.evaluate(async () => {
      const raw = document.querySelector<HTMLElement>('#mount')!,
        handle = document.createElement('div');
      handle.className = 'dash-handle col';
      handle.style.setProperty('--at', '.5');
      raw.after(handle);
      await Promise.all(raw.getAnimations().map((a) => a.finished));
      const offset = () => handle.getBoundingClientRect().left + 4 - raw.getBoundingClientRect().right;
      const offsets = [offset()];
      raw.style.setProperty('--w', '.7');
      handle.style.setProperty('--at', '.7');
      for (let i = 0; i < 6; i++) {
        await new Promise(requestAnimationFrame);
        offsets.push(offset());
      }
      raw.dataset.mode = 'thread';
      return { offsets, threadOnly: getComputedStyle(handle).transitionProperty };
    });
    assert.ok(
      result.offsets.every((n) => Math.abs(n) < 1),
      `divider offsets: ${result.offsets}`,
    );
    assert.match(result.threadOnly, /left/);
  });

  await t.test('reduced motion disables all mixed-pane and divider transitions', async () => {
    const page = await rig(false, false, false, 'dashboard');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const properties = await page.evaluate(() => {
      const raw = document.querySelector<HTMLElement>('#mount')!,
        thread = document.createElement('section'),
        handle = document.createElement('div');
      thread.className = 'dash-pane';
      thread.dataset.mode = 'thread';
      handle.className = 'dash-handle col';
      raw.after(thread, handle);
      return [raw, thread, handle].map((el) => getComputedStyle(el).transitionProperty);
    });
    assert.deepEqual(properties, ['none', 'none', 'none']);
  });

  await t.test('dashboard sidebar breakpoints and pane splits send only the settled grid', async () => {
    const page = await rig(false, false, false, 'dashboard');
    await page.setViewportSize({ width: 1120, height: 720 });
    const settle = () =>
      page.evaluate(async () => {
        const w = window as any;
        await w.frames();
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished),
        );
        await w.frames();
        const sizes = w.sizes();
        w.messages = [];
        return sizes;
      });
    await settle();
    for (const width of [1080, 1230]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal((await settle()).length, 1, 'one resize across the responsive sidebar breakpoint');
    }
    await page.locator('#mount').evaluate((el) => el.style.setProperty('--w', '1'));
    assert.equal((await settle()).length, 1, 'one resize when the terminal takes the full workspace');
    await page.evaluate(async () => {
      const pane = document.getElementById('mount')!;
      pane.parentElement!.classList.add('resizing');
      for (const width of ['0.4', '0.5', '0.6']) {
        pane.style.setProperty('--w', width);
        await (window as any).frames();
      }
    });
    assert.deepEqual(await settle(), [], 'a live divider drag does not repeatedly reflow the PTY');
    await page.evaluate(async () => {
      const w = window as any;
      w.term.write('output during drag');
      await w.frames();
    });
    assert.ok(!(await page.locator('.term-grid').innerText()).includes('output during drag'), 'the previous complete grid stays painted');
    await page.evaluate(() => {
      const workspace = document.querySelector('.dash-workspace')!;
      workspace.classList.remove('resizing');
      const handle = document.createElement('div');
      handle.className = 'dash-handle';
      workspace.append(handle);
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    assert.equal((await settle()).length, 1, 'release commits the last observed box even when the pointer stopped moving');
    assert.match(await page.locator('.term-grid').innerText(), /output during drag/);
  });

  await t.test('a Thread pane stays next to a visible Raw TTY throughout a layout change', async () => {
    const page = await rig(false, false, false, 'dashboard');
    const result = await page.evaluate(async () => {
      const raw = document.querySelector<HTMLElement>('#mount')!;
      const thread = document.createElement('section');
      thread.className = 'dash-pane';
      thread.dataset.mode = 'thread';
      thread.style.cssText = '--x:.5;--y:0;--w:.5;--h:1;--gl:3px;--gr:0px;--gt:0px;--gb:0px';
      raw.style.setProperty('--gr', '3px');
      raw.after(thread);
      // Both newly mounted panes scale around their centers before layout begins.
      await Promise.all([raw, thread].flatMap((el) => el.getAnimations().map((a) => a.finished)));
      const gap = () => thread.getBoundingClientRect().left - raw.getBoundingClientRect().right;
      const samples = [gap()];
      for (const width of ['.333333', '.5']) {
        raw.style.setProperty('--w', width);
        thread.style.setProperty('--x', width);
        thread.style.setProperty('--w', width);
        for (let i = 0; i < 5; i++) {
          await new Promise(requestAnimationFrame);
          samples.push(gap());
        }
      }
      raw.hidden = true;
      return { samples, threadOnly: getComputedStyle(thread).transitionProperty };
    });
    assert.ok(
      result.samples.every((value) => Math.abs(value - 6) <= 1),
      `6px divider gaps: ${result.samples}`,
    );
    assert.match(result.threadOnly, /\bwidth\b/, 'Thread-only workspaces still animate');
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

  await t.test('first visible desk cells are the painted PTY snapshot, never the provisional 80×24 grid', async () => {
    const page = await rig(true, true);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const root = w.term.native.element;
      const before = [w.term.cols, w.term.rows, getComputedStyle(root).opacity, root.querySelector('.term-grid').getBoundingClientRect().height];
      const visible: number[][] = [];
      w.snapshot(Array.from({ length: 120 }, (_, i) => `settled row ${i}\r\n`).join(''));
      for (let i = 0; i < 10; i++) {
        await new Promise(requestAnimationFrame);
        if (getComputedStyle(root).opacity !== '0') visible.push([w.term.cols, w.term.rows, root.scrollTop]);
      }
      return { before, visible, tail: root.scrollHeight - root.clientHeight, text: root.textContent.includes('settled row 119') };
    });
    assert.deepEqual(result.before, [80, 24, '0', 0]);
    assert.ok(result.visible.length && result.text);
    assert.ok(result.tail > 0);
    for (const grid of result.visible) assert.deepEqual(grid, [120, 40, result.tail]);
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
});
