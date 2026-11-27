import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

test('Ghostty link policy, search reflow, glass, selection, fonts and cursor on the shipped canvas', { skip: !browserStatus().installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-links-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    cacheDir,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['ghostty-web'] },
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
  const context = await newIsolatedContext(browser, { deviceScaleFactor: 1.25 });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="host"></div><div id="modal-root"></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await t.test('appearance installation preserves the canvas and owns no second blink or unscoped listeners', async () => {
    const lifecycle = await page.evaluate(async () => {
      const load = (url: string) => import(url);
      const { GhosttyAdapter } = await load('/term-engine/ghostty.ts');
      const { installAppearance } = await load('/term-engine/ghostty-links-appearance.ts');
      const term = new GhosttyAdapter({ cursorBlink: true, fontFamily: 'serif', fontSize: 20 });
      const intervals = new Set<number>();
      const start = window.setInterval;
      const stop = window.clearInterval;
      window.setInterval = (fn, ms, ...args) => {
        const id = start.call(window, fn, ms, ...args);
        intervals.add(id);
        return id;
      };
      window.clearInterval = (id) => {
        intervals.delete(id!);
        stop.call(window, id);
      };
      try {
        await term.open(document.querySelector('#host'));
        const native = term.native;
        const element = native.element;
        const canvas: HTMLCanvasElement = native.renderer.getCanvas();
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#2c44aa';
        ctx.fillRect(0, 0, 5, 5);
        ctx.font = 'bold 11px monospace';
        const snapshot = () => [canvas.width, canvas.height, canvas.style.cssText, ctx.font, ctx.fillStyle, ctx.getTransform().toString(), [...ctx.getImageData(1, 1, 1, 1).data]];
        const before = snapshot();
        const nativeBlinks = intervals.size;
        const adds: string[] = [];
        const measurements: string[] = [];
        const timeout = window.setTimeout;
        const frame = window.requestAnimationFrame;
        const listen = EventTarget.prototype.addEventListener;
        const measure = CanvasRenderingContext2D.prototype.measureText;
        let attachedSignal: AbortSignal | undefined;
        // Observe browser API calls only across the synchronous installation, not Ghostty.open.
        window.setTimeout = (...args) => {
          adds.push('timeout');
          return timeout(...args);
        };
        window.requestAnimationFrame = (fn) => {
          adds.push('frame');
          return frame(fn);
        };
        EventTarget.prototype.addEventListener = function (type, listener, opts) {
          const scoped = opts && typeof opts === 'object' && opts.signal === attachedSignal;
          adds.push(`${this === element ? 'root' : this === attachedSignal ? 'lifetime' : 'other'}:${type}:${scoped ? 'scoped' : 'unscoped'}`);
          listen.call(this, type, listener, opts);
        };
        CanvasRenderingContext2D.prototype.measureText = function (s) {
          measurements.push(`${this === ctx ? 'active' : 'scratch'}:${this.font}:${s}`);
          return measure.call(this, s);
        };
        try {
          term.onOpen((opened: typeof native, lifetime: AbortSignal) => {
            attachedSignal = lifetime;
            installAppearance(term, opened, lifetime);
          });
        } finally {
          window.setTimeout = timeout;
          window.requestAnimationFrame = frame;
          EventTarget.prototype.addEventListener = listen;
          CanvasRenderingContext2D.prototype.measureText = measure;
        }
        const after = snapshot();
        const installedBlinks = intervals.size;
        term.dispose();
        // A surviving focus listener would restart the original blink on the detached root.
        element.dispatchEvent(new FocusEvent('focusin'));
        return { before, after, nativeBlinks, installedBlinks, disposedBlinks: intervals.size, aborted: attachedSignal?.aborted, adds, measurements };
      } finally {
        window.setInterval = start;
        window.clearInterval = stop;
      }
    });
    assert.deepEqual(lifecycle.after, lifecycle.before);
    assert.deepEqual([lifecycle.nativeBlinks, lifecycle.installedBlinks, lifecycle.disposedBlinks], [1, 1, 0]);
    assert.deepEqual(lifecycle.adds, ['root:focusin:scoped', 'lifetime:abort:unscoped']);
    assert.equal(lifecycle.aborted, true);
    assert.deepEqual(lifecycle.measurements, ['scratch:20px serif:M']);
  });
  const metrics = await page.evaluate(async () => {
    const load = (url: string) => import(url);
    const [{ GhosttyAdapter }, { attachGhosttyLinks }, { TerminalPathLinksAddon }, { TERM_FONT, loadFonts }, { TERM_THEME }] = await Promise.all([
      load('/term-engine/ghostty.ts'),
      load('/term-engine/ghostty-links.ts'),
      load('/ui/terminal-path-links.ts'),
      load('/fonts.ts'),
      load('/term-theme.ts'),
    ]);
    await loadFonts();
    const theme = { ...TERM_THEME, background: 'rgba(0, 0, 0, 0)' };
    const term = new GhosttyAdapter({ fontFamily: TERM_FONT, fontSize: 14, scrollback: 100, minimumContrastRatio: 4.5, cursorBlink: false, cursorStyle: 'block', theme });
    const addon = new TerminalPathLinksAddon({ floor: 'f', workerId: 'w' });
    const links = attachGhosttyLinks(term, addon);
    await term.open(document.querySelector('#host'));
    const { native } = term;
    const { renderer } = native;
    const canvas: HTMLCanvasElement = renderer.getCanvas();
    const ctx = canvas.getContext('2d')!;
    const pixel = (x: number, y: number) => [...ctx.getImageData(Math.floor(x * devicePixelRatio), Math.floor(y * devicePixelRatio), 1, 1).data];
    const opened: (string | undefined)[][] = [];
    window.open = (url, target, features) => {
      opened.push([String(url), target, features]);
      return null;
    };
    const sample = (x: number, y: number, modifier: boolean) => {
      const { top, left } = canvas.getBoundingClientRect();
      const { width, height } = renderer.getMetrics();
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: left + (x + 0.5) * width, clientY: top + (y + 0.5) * height, ctrlKey: modifier }));
    };
    term.resize(40, 8);
    term.write('https://example.com\r\n\x1b]8;;https://example.com/osc\x1b\\label\x1b]8;;\x1b\\\r\n\x1b]8;;not-a-scheme:ref\x1b\\bad\x1b]8;;\x1b\\');
    for (const y of [0, 1, 2]) {
      sample(1, y, false);
      sample(1, y, true);
    }
    const geometry = [];
    for (const size of [14, 20]) {
      term.options.fontSize = size;
      term.write('\x1b[2J\x1b[H\x1b[48;2;255;0;0m        \x1b[0m\r\nM\x1b[1mM\x1b[0;3mM\x1b[0m\r\n');
      term.redraw();
      const { width, height } = renderer.getMetrics();
      const row = ctx.getImageData(1, 2, Math.floor(8 * width * devicePixelRatio) - 2, 1).data;
      const seamAlpha = Math.min(...row.filter((_, i) => i % 4 === 3));
      const pixelAt = (col: number, row: number) => pixel(col * width + 2, row * height + 2);
      const cursor = pixelAt(0, 2);
      const blank = pixelAt(8, 3);
      native.select(0, 1, 6);
      term.redraw();
      const selection = pixelAt(4, 1);
      native.clearSelection();
      const styles = ['normal', 'bold', 'italic'].map((style) => {
        ctx.font = `${style} ${size}px ${TERM_FONT}`;
        return [ctx.measureText('M').width, ctx.measureText('').width];
      });
      const facePixels = [0, 1, 3].map((sgr) => {
        term.write(`\x1b[H\x1b[0;${sgr}mM\x1b[0m\r\n`);
        term.redraw();
        return ctx
          .getImageData(0, 0, Math.floor(width * devicePixelRatio), Math.floor(height * devicePixelRatio))
          .data.filter((_, i) => i % 4 === 3)
          .reduce((a, v) => a + v, 0);
      });
      term.write('\x1b[H\x1b[0;38;2;40;40;40mM\x1b[0m\r\n');
      term.redraw();
      const ink = ctx.getImageData(0, 0, Math.floor(width * devicePixelRatio), Math.floor(height * devicePixelRatio)).data;
      let brightest = 0;
      for (let i = 0; i < ink.length; i += 4) if (ink[i + 3] > 200) brightest = Math.max(brightest, ink[i]);
      geometry.push({ size, width, height, styles, facePixels, brightest, seamAlpha, cursor, blank, selection });
    }
    term.write('\x1b[2J\x1b[H\u{10eeee}\u0301\r\n');
    term.redraw();
    const tile = ctx.getImageData(0, 0, renderer.charWidth, renderer.charHeight).data;
    const placeholderAlpha = Math.max(...tile.filter((_, i) => i % 4 === 3));
    const corePlaceholder = native.wasmTerm.getGraphemeString(0, 0);
    term.options.theme = { ...theme, cursor: '#00ff00', foreground: '#0000ff' };
    const liveCursor = pixel(2, renderer.charHeight + 2);
    term.write('\x1b[?25l');
    term.redraw();
    const hiddenCursor = pixel(2, renderer.charHeight + 2);
    const logTerm = new GhosttyAdapter({ fontSize: 14, fontFamily: TERM_FONT, theme });
    attachGhosttyLinks(logTerm);
    await logTerm.open(document.querySelector('#host'));
    logTerm.write('\x1b]8;;https://log.invalid\x1b\\log\x1b]8;;\x1b\\');
    const logCanvas = logTerm.native.renderer.getCanvas();
    const logBounds = logCanvas.getBoundingClientRect();
    logCanvas.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, clientX: logBounds.left + 3, clientY: logBounds.top + 3 }));
    logTerm.dispose();
    term.reset();
    term.write(`${'before\r\n'.repeat(16)}marker needle\r\n${'after\r\n'.repeat(20)}`);
    (window as any).rig = { term, links };
    return { geometry, opened, placeholderAlpha, corePlaceholder, liveCursor, hiddenCursor, result: links.find({ needle: 'marker needle', fromEnd: 22 }), missing: links.find({ needle: 'missing result', fromEnd: 1 }) };
  });
  assert.deepEqual(metrics.opened, [
    ['https://example.com', '_blank', 'noopener,noreferrer'],
    ['https://example.com/osc', '_blank', 'noopener,noreferrer'],
  ]);
  assert.equal(metrics.result, undefined);
  assert.equal(metrics.missing, 'That line has scrolled out of the terminal since');
  assert.equal(metrics.placeholderAlpha, 0);
  assert.equal(metrics.corePlaceholder, '\u{10eeee}\u0301');
  assert.deepEqual(metrics.liveCursor, [0, 255, 0, 255]);
  assert.deepEqual(metrics.hiddenCursor, [0, 0, 0, 0]);
  for (const m of metrics.geometry) {
    assert.deepEqual(m.cursor, [238, 96, 24, 255]);
    assert.deepEqual(m.blank, [0, 0, 0, 0]);
    assert.deepEqual(m.selection, [42, 42, 42, 255]);
    assert.equal(new Set(m.facePixels).size, 3);
    assert.ok(m.brightest >= 116, `SGR #282828 on black reaches 4.5:1 (${m.brightest})`);
    for (const [textWidth, iconWidth] of m.styles) {
      assert.ok(Math.abs(textWidth - m.size * 0.6) < 0.02);
      assert.ok(Math.abs(iconWidth - textWidth) < 0.02);
    }
    t.diagnostic(JSON.stringify(m));
  }
  await page.clock.install();
  await page.evaluate(() => {
    const { term, links } = (window as any).rig;
    links.find({ needle: 'marker needle', fromEnd: 22 });
    term.resize(32, 12);
  });
  await page.clock.runFor(80);
  const row = await page.evaluate(() => {
    const render = (window as any).rig.term.native.renderer;
    return (parseFloat((document.querySelector('.ghostty-find-line') as HTMLElement).style.top) - render.getCanvas().offsetTop) / render.charHeight;
  });
  assert.equal(row, 4);
  await page.clock.fastForward(8100);
  assert.equal(await page.locator('.ghostty-find-line').count(), 0);
  // Same remote response shape used by the paired-client path endpoint in terminal-paths.test.
  await page.route('**/api/term/paths?**', (r) => r.fulfill({ json: { paths: [{ path: '/checkout/src/server.ts', displayPath: 'src/server.ts', line: 120 }], local: false } }));
  await page.route('**/api/term/file?**', (r) => r.fulfill({ json: { path: 'src/server.ts', text: 'server.ts' } }));
  await page.evaluate(() => {
    const { term } = (window as any).rig;
    term.reset();
    term.resize(16, 8);
    term.write('漢e\u0301 Edit src/server.ts:120');
    const renderer = term.native.renderer;
    const canvas = renderer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, clientX: rect.left + renderer.charWidth * 2.5, clientY: rect.top + renderer.charHeight * 1.5 }));
  });
  await page.locator('[aria-label="File preview: src/server.ts"]').waitFor({ state: 'attached', timeout: 4000 });
  assert.match(await page.locator('.wt-file-modal').innerText(), /Line 120/);
  await page.evaluate(() => (window as any).rig.term.dispose());
});
