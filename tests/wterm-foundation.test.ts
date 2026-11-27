import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

test('wterm real WASM: open, ordered write/drain, reset, fixed-size resize and close', { skip: !browserStatus().installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-wterm-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    configFile: false,
    cacheDir,
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@wterm/dom', '@wterm/ghostty'] },
  });
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address === 'object');
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/term-engine/wterm.css"><button id="other">other</button><div style="width:640px;height:200px" id="host"></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);
  await page.focus('#other');
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  const result = await page.evaluate(async () => {
    const mod = '/term-engine/wterm.ts',
      { WTermAdapter } = await import(mod);
    const a = new WTermAdapter({});
    await a.open(document.getElementById('host'));
    const focus = document.activeElement?.id;
    const sizes: number[][] = [];
    a.onResize(({ cols, rows }: { cols: number; rows: number }) => sizes.push([cols, rows, a.core.getCols(), a.core.getRows()]));
    a.resize(42, 8);
    a.resize(40, 8);
    a.resize(40, 8);
    a.write('one');
    a.write('two');
    const parsed = a.core.getCursor().col;
    await new Promise<void>((r) => a.write('', r));
    a.write('\r\nline'.repeat(30));
    const history = a.buffer.active.baseY;
    a.reset();
    const reset = [a.core.getCursor().col, a.buffer.active.baseY, a.cols, a.rows];
    const widths = [];
    for (const mode of ['', '\x1b[?2027h', '\x1b[?2027l', '\x1bc', '\x1b[?1;2027;2004h']) {
      a.write(`\r${mode}👩‍💻`);
      widths.push(a.core.getCursor().col);
    }
    a.dispose();
    return { focus, parsed, history, reset, sizes, widths, children: document.getElementById('host')!.childElementCount };
  });
  assert.deepEqual(result, {
    focus: 'other',
    parsed: 6,
    history: 23,
    reset: [0, 0, 40, 8],
    sizes: [
      [42, 8, 42, 8],
      [40, 8, 40, 8],
    ],
    widths: [4, 4, 4, 4, 4],
    children: 0,
  });
  await t.test('a hidden reader retains its viewport while output arrives and after reveal', async () => {
    const positions = await page.evaluate(async () => {
      const mod = '/term-engine/wterm.ts',
        { WTermAdapter } = await import(mod);
      const host = document.getElementById('host')!,
        a = new WTermAdapter({ scrollback: 64 });
      await a.open(host);
      a.resize(40, 12);
      const frame = async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      };
      const write = (start: number, n: number) => a.write(Array.from({ length: n }, (_, i) => `row ${start + i}\r\n`).join(''));
      write(0, 76);
      await frame();
      a.native.element.scrollTop = 30 * a.native.element.querySelector('.term-row').getBoundingClientRect().height;
      await frame();
      const visible = a.buffer.active;
      host.hidden = true;
      const hidden = a.buffer.active;
      a.setRenderingPaused(true);
      write(76, 6);
      const hiddenAfterTrim = a.buffer.active;
      host.hidden = false;
      a.setRenderingPaused(false);
      await frame();
      const revealed = a.buffer.active;
      a.dispose();
      return [visible, hidden, hiddenAfterTrim, revealed].map((s) => [s.baseY, s.viewportY]);
    });
    assert.deepEqual(positions, [
      [64, 30],
      [64, 30],
      [64, 24],
      [64, 24],
    ]);
  });
  await t.test('a scrolled Raw TTY returns to the same line after Thread and a fresh attach snapshot', async () => {
    const pane = await context.newPage();
    try {
      await pane.route('**/thread-fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="modal-root"></div><div id="toasts"></div>' }));
      await pane.goto(`http://127.0.0.1:${address.port}/thread-fixture`);
      await pane.addScriptTag({ content: 'window.__name=fn=>fn' });
      await pane.evaluate(async () => {
        const ui = '/ui/terminal.ts',
          state = '/state.ts';
        const { openTerminal, routeTerminalMessage } = await import(ui),
          { store } = await import(state);
        // Same local agent and attach contract as the mounted desk-thread fixture.
        const worker = { id: 'pixel', name: 'Pixel', kind: 'agent', deskId: 'desk', color: '#89d9ed', status: 'idle', sessionId: 'session', cols: 120, rows: 40, open: true };
        store.workers.set(worker.id, worker);
        let snapshots = 0;
        openTerminal(
          {
            up: true,
            send(msg: { t: string; stream?: boolean }) {
              if (msg.t === 'worker.attach' && msg.stream !== false) {
                const start = snapshots++ ? 7 : 0;
                // Row 37 repeats row 30, so its label alone is not a stable identity after trimming seven rows.
                const data = Array.from({ length: 150 }, (_, i) => `history row ${start + i === 37 ? 30 : start + i}\r\n`).join('');
                queueMicrotask(() => routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data, cols: 120, rows: 40, shared: true }));
              }
              return true;
            },
            request: async () => ({ t: 'action.result', requestId: 'r', ok: true }),
            onMessage: () => () => {},
            onStatus: () => () => {},
          },
          worker.id,
        );
      });
      await pane.locator('.office-wterm textarea').waitFor({ state: 'attached' });
      const raw = pane.getByRole('button', { name: 'Raw TTY', exact: true });
      await raw.click();
      await pane.waitForFunction(() => document.querySelector('.wterm.has-scrollback'));
      const element = pane.locator('.office-wterm');
      await element.evaluate((el) => {
        el.scrollTop = 30 * parseFloat(getComputedStyle(el).getPropertyValue('--term-row-height'));
      });
      const top = () =>
        element.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return document
            .elementFromPoint(r.left + 15, r.top + 9)
            ?.closest('.term-row')
            ?.textContent?.trim();
        });
      await pane.waitForFunction(() => {
        const el = document.querySelector('.office-wterm')!,
          r = el.getBoundingClientRect();
        return document
          .elementFromPoint(r.left + 15, r.top + 9)
          ?.closest('.term-row')
          ?.textContent?.includes('history row 30');
      });
      await pane.getByRole('button', { name: 'Thread', exact: true }).click();
      await raw.click();
      await pane.waitForFunction(() => document.querySelector('.wterm')?.textContent?.includes('history row 156'));
      await pane.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      assert.equal(await top(), 'history row 30');
      assert.equal(await element.evaluate((el) => Math.floor(el.scrollTop / parseFloat(getComputedStyle(el).getPropertyValue('--term-row-height')))), 23);
    } finally {
      await pane.close();
    }
  });
  await t.test('default mouse reports pass exactly when all bytes survive UTF-8 transport', async () => {
    const sent = await page.evaluate(async () => {
      const mod = '/term-engine/wterm.ts',
        { WTermAdapter } = await import(mod);
      const host = document.getElementById('host')!,
        a = new WTermAdapter({});
      host.style.width = '1250px';
      const data: string[] = [];
      a.onData((s: string) => data.push(s));
      await a.open(host);
      a.resize(140, 12);
      a.write('\x1b[?1000h');
      await new Promise(requestAnimationFrame);
      const el = a.native.element,
        rect = el.querySelector('.term-grid').getBoundingClientRect(),
        width = parseFloat(el.style.getPropertyValue('--term-cell-width'));
      for (const col of [10, 120])
        for (const phase of ['mousedown', 'mouseup'])
          el.dispatchEvent(new MouseEvent(phase, { bubbles: true, cancelable: true, buttons: phase === 'mousedown' ? 1 : 0, button: 0, clientX: rect.left + (col - 0.5) * width, clientY: rect.top + 4 }));
      a.dispose();
      host.style.width = '640px';
      return data;
    });
    assert.deepEqual(sent, ['\x1b[M *!', '\x1b[M#*!']);
  });
  await t.test('every whole and split query and unsolicited theme report is silent; real input still arrives', async () => {
    const queryCount = await page.evaluate(async () => {
      const mod = '/term-engine/wterm.ts',
        mirror = '/term-mirror.ts';
      const { WTermAdapter } = await import(mod),
        { suppressMirrorQueries } = await import(mirror);
      const a = new WTermAdapter({});
      const sent: string[] = [];
      a.onData((d: string) => sent.push(d));
      await a.open(document.getElementById('host'));
      const queries = [
        '\x1b[5n',
        '\x1b[6n',
        '\x1b[c',
        '\x1b[>c',
        '\x1bZ',
        '\x1b[?u',
        '\x1b[?996n',
        '\x1b]4;1;?\x07',
        '\x1b]10;?\x07',
        '\x1b]11;?\x07',
        '\x1b]12;?\x07',
        '\x1b[14t',
        '\x1b[16t',
        '\x1b[18t',
        '\x1b[?1004$p',
        '\x1b[4$p',
        '\x1b[>q',
        '\x1bP$qm\x1b\\',
      ];
      let cases = 0;
      for (const scanner of [false, true]) {
        if (scanner) suppressMirrorQueries(a);
        for (const q of queries)
          for (let i = 0; i < q.length; i++) {
            a.write(q.slice(0, i));
            a.write(q.slice(i));
            if (sent.length) throw Error(JSON.stringify({ q, i, scanner, sent }));
            cases++;
          }
        a.write('\x1b[?2031h');
        a.options.theme = { background: '#ffffff' };
        a.options.theme = { background: '#000000' };
        await new Promise(requestAnimationFrame);
        if (sent.length) throw Error(`theme report: ${JSON.stringify(sent)}`);
      }
      Object.assign(window, { a, sent });
      a.write('\x1b[?1004;1000;1006h');
      a.focus();
      return cases;
    });
    t.diagnostic(`${queryCount} whole/split query cases`);
    await page.keyboard.press('k');
    await page.evaluate(() => {
      const { a } = window as any;
      const paste = (text: string) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        a.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      };
      paste('plain');
      a.write('\x1b[?2004h');
      paste('bracketed');
      const { x, y } = a.native.element.querySelector('.term-grid').getBoundingClientRect();
      a.native.element.dispatchEvent(new WheelEvent('wheel', { clientX: x + 2, clientY: y + 2, deltaY: 40, bubbles: true, cancelable: true }));
    });
    await page.focus('#other');
    assert.deepEqual(await page.evaluate(() => (window as any).sent), ['\x1b[I', 'k', 'plain', '\x1b[200~bracketed\x1b[201~', '\x1b[<65;1;1M', '\x1b[O']);
    await page.evaluate(() => (window as any).a.dispose());
  });
  await t.test('core-only entry installs explicit features and preserves theme RGB independently of CSS alpha', async () => {
    const result = await page.evaluate(async () => {
      const url = '/term-engine/wterm.ts',
        { WTermAdapter } = await import(url);
      const attached: string[] = [];
      const a = new WTermAdapter({}, async () => [() => attached.push('first'), () => attached.push('second')]);
      try {
        await a.open(document.getElementById('host'));
        a.options.theme = { foreground: '#a1b2c37f', background: '#12345680', red: '#33445599', cursor: '#fedcba00' };
        a.core.writeString('\x1b[31mR\x1b]10;?\x07\x1b]11;?\x07');
        let replies = '';
        for (let reply = a.core.getResponse(); reply !== null; reply = a.core.getResponse()) replies += reply;
        return { attached, replies, red: a.core.getCell(0, 0).fgRgb, background: a.native.element.style.getPropertyValue('--term-bg'), cursor: a.native.element.style.getPropertyValue('--term-cursor') };
      } finally {
        a.dispose();
      }
    });
    assert.deepEqual(result.attached, ['first', 'second']);
    assert.equal(result.red, 0x334455);
    assert.equal(result.background, '#12345680');
    assert.equal(result.cursor, '#fedcba');
    for (const rgb of ['a1a1/b2b2/c3c3', '1212/3434/5656']) assert.match(result.replies, new RegExp(`rgb:${rgb}`, 'i'));
  });
  await t.test('font and row spacing remeasure without reflowing a shared grid; init waits for the modal', async () => {
    const data = await page.evaluate(async () => {
      const mod = '/term-engine/wterm.ts',
        { WTermAdapter } = await import(mod);
      const a = new WTermAdapter({ fontFamily: 'monospace', fontSize: 14, lineHeight: 1 });
      const host = document.getElementById('host')!;
      host.classList.add('modal');
      const animation = host.animate(
        [
          { transform: 'scale(.7)', opacity: 0.6 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 10000 },
      );
      animation.pause();
      const opening = a.open(host);
      await new Promise(requestAnimationFrame);
      const waited = !a.native;
      animation.finish();
      await opening;
      a.resize(61, 12);
      const el = a.native.element;
      const metrics = () => [parseFloat(getComputedStyle(el).getPropertyValue('--term-cell-width')), el.querySelector('.term-row').offsetHeight];
      const before = metrics(),
        initial = a.proposeDimensions();
      a.options.fontSize = 20;
      a.options.lineHeight = 1.25;
      const after = metrics(),
        next = a.proposeDimensions();
      const probe = document.createElement('span');
      probe.textContent = 'W';
      probe.style.position = 'absolute';
      el.append(probe);
      const width = probe.getBoundingClientRect().width;
      const size = [a.cols, a.rows];
      a.write('live');
      await new Promise(requestAnimationFrame);
      a.setRenderingPaused(true);
      a.write('-paused');
      await new Promise(requestAnimationFrame);
      const paused = el.querySelector('.term-row').textContent.trim();
      a.setRenderingPaused(false);
      await new Promise(requestAnimationFrame);
      const resumed = el.querySelector('.term-row').textContent.trim();
      a.dispose();
      animation.cancel();
      host.classList.remove('modal');
      return { before, after, waited, width, size, initial, next, paused, resumed };
    });
    assert.ok(data.waited);
    assert.deepEqual(data.size, [61, 12]);
    assert.ok(data.after[0] > data.before[0] && Math.abs(data.after[0] - data.width) < 0.05);
    assert.ok(data.after[1] > data.before[1]);
    assert.ok(data.initial.cols > data.next.cols && data.initial.rows > data.next.rows);
    assert.deepEqual([data.paused, data.resumed], ['live', 'live-paused']);
  });
});
