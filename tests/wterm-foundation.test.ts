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
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<button id="other">other</button><div style="width:640px;height:200px" id="host"></div>' }));
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
    assert.deepEqual([data.before[1], data.after[1]], [14, 25]);
    assert.ok(data.initial.cols > data.next.cols && data.initial.rows > data.next.rows);
    assert.deepEqual([data.paused, data.resumed], ['live', 'live-paused']);
  });
});
