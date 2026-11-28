import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { terminalFixture } from './terminal-fixture.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../../src/server/whiteboard-browser.js';

const status = browserStatus();
export const skip = status.installed ? false : `Chromium is not installed in ${status.path}`;

export async function terminalResizeFixture(t: TestContext) {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const mountFixture = await terminalFixture(t);
  const errors: string[] = [];
  t.afterEach(async () => {
    await Promise.all(context.pages().map((page) => page.close()));
    assert.deepEqual(errors.splice(0), []);
  });
  return async (shared = true, delaySnapshot = false, hidden = false, mode = 'inline', pageHidden = false) => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
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
        } else w.handle = openTerminal(w.net, worker.id, undefined, undefined, { mount, focus: false, readOnly: mode === 'read-only' });
      },
      { shared, delaySnapshot, hidden, mode, pageHidden },
    );
    await page.waitForFunction(() => !!(window as any).term?.native?.element);
    if (!delaySnapshot && !pageHidden && mode !== 'read-only') await page.waitForFunction(() => !(window as any).term.options.disableStdin);
    await page.evaluate(() => (window as any).frames());
    return page;
  };
}
