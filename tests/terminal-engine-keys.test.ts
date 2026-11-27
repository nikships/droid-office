import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { Ghostty } from 'ghostty-web';
import { paneFactory } from '../src/client/term-engine/ghostty-runtime.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
test('pane factory calls public core and key constructors on the loaded instance', async (t) => {
  const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  const real = await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`);
  const terminal = t.mock.method(real, 'createTerminal');
  const encoder = t.mock.method(real, 'createKeyEncoder');
  const factory = paneFactory(real);
  factory.createTerminal().free();
  factory.createKeyEncoder().dispose();
  assert.deepEqual(
    [terminal, encoder].map((method) => method.mock.calls[0].this === real),
    [true, true],
  );
});

test('real terminal key handlers produce the same PTY bytes before and after Kitty negotiation', { skip: !status.installed && `No Chromium in ${status.path}` }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-keys-vite-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    cacheDir,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['ghostty-web', '@xterm/xterm', '@xterm/addon-fit'] },
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
  const cdp = await context.newCDPSession(page);
  // Playwright's US shortcut table drops the character on Alt+letter. Supply the
  // macOS layout's actual key and text so Chromium can dispatch its native keypress.
  const optionF = async () => {
    const key = { key: 'ƒ', code: 'KeyF', modifiers: 1, windowsVirtualKeyCode: 70 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: 'ƒ', unmodifiedText: 'f' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  };
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    // Keep selected text in this page, not in the test runner's OS clipboard.
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        async write([item]: ClipboardItem[]) {
          (window as any).copied = await (await item.getType('text/plain')).text();
        },
      },
    });
  });
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="host"></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);

  for (const name of ['xterm', 'ghostty']) {
    await page.evaluate(async (engineName) => {
      const modules = ['/term-engine/index.ts', '/term-engine/ghostty-keys.ts', '/term-kitty.ts', '/term-mirror.ts'];
      const [{ createTerminalEngine }, { attachGhosttyKeys }, { attachKittyTerminal }, { suppressMirrorQueries }] = await Promise.all(modules.map((url) => import(url)));
      const w = window as any;
      const engine = createTerminalEngine({ allowProposedApi: true, macOptionIsMeta: true }, engineName);
      const term = engine.term;
      const { keyAction } = engine.ghostty ? attachGhosttyKeys(term) : attachKittyTerminal(term);
      w.term = term;
      w.csiEnter = false;
      w.input = '';
      term.onData((data: string) => {
        w.input += data;
      });
      suppressMirrorQueries(term);
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        const action = keyAction(e, w.csiEnter);
        if (action.do === 'send') {
          e.preventDefault();
          term.input(action.data);
        }
        return action.do === 'default';
      });
      await term.open(document.querySelector('#host'));
      term.focus();
    }, name);

    const drain = () =>
      page.evaluate(() => {
        const w = window as any;
        const input = w.input;
        w.input = '';
        return input;
      });
    const write = (vt: string) => page.evaluate((vt) => new Promise<void>((r) => (window as any).term.write(vt, r)), vt);
    const check = async (key: string, expected: string) => {
      if (key.startsWith('Meta+')) {
        // Send the shortcut without invoking the machine's OS copy/paste command.
        const letter = key.slice(-1);
        const event = { key: letter, code: `Key${letter.toUpperCase()}`, modifiers: 4, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0) };
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
      } else await page.keyboard.press(key);
      assert.equal(await drain(), expected, `${name}: ${key}`);
    };
    await check('Enter', '\r');
    await check('Control+Enter', '\r');
    await page.evaluate(() => {
      (window as any).csiEnter = true;
    });
    await check('Control+Enter', '\x1b[13;5u');
    await check('Shift+Enter', '\x1b[13;2u');
    await optionF();
    assert.equal(await drain(), '\x1bf', `${name}: Option sends Meta`);
    const deadE = () => page.evaluate(() => (window as any).term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyE', keyCode: 69, altKey: true, bubbles: true, cancelable: true })));
    await deadE();
    assert.equal(await drain(), '\x1be', `${name}: Meta uses the physical letter before composition`);
    await check('Alt+ArrowLeft', '\x1b[1;3D');
    await check('Alt+Backspace', '\x1b\x7f');
    await check('Alt+Delete', '\x1b[3;3~');
    await write('\x1b[?1h');
    await check('Home', '\x1bOH');
    await check('End', '\x1bOF');
    await check('ArrowUp', '\x1bOA');
    await write('\x1b[?1l');
    await check('Control+c', '\x03');
    await write('select me');
    await page.evaluate(() => {
      const { term } = window as any;
      (term.native ?? term).select(0, 0, 9);
      if (!(term.native ?? term).hasSelection()) throw Error('selection missing');
    });
    await check('Meta+c', '');
    if (name === 'xterm') {
      // xterm delegates Cmd+C to the browser copy event; Ghostty uses clipboard.write.
      await page.evaluate(() => {
        const data = new DataTransfer();
        (window as any).term.textarea.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data }));
        (window as any).copied = data.getData('text/plain');
      });
    }
    await page.waitForFunction(() => (window as any).copied === 'select me');
    await page.evaluate(() => {
      delete (window as any).copied;
    });
    await check('Control+c', '\x03');
    assert.equal(
      await page.evaluate(() => {
        const { term } = window as any;
        return (term.native ?? term).hasSelection();
      }),
      false,
    );
    if (name === 'ghostty')
      await t.test('Ctrl letters follow Dvorak even across the physical paste key', async () => {
        for (const [key, code, expected] of [
          ['k', 'KeyV', '\x0b'],
          ['v', 'Period', '\x16'],
        ]) {
          const event = { key, code, modifiers: 2, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
          await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
          assert.equal(await drain(), expected, key);
        }
      });
    await check('Control+v', '\x16');
    await check('Meta+c', '');
    await check('Meta+v', '');
    await write('\x1b[?2004h');
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'paste me');
      (window as any).term.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    assert.equal(await drain(), '\x1b[200~paste me\x1b[201~');
    await page.evaluate(() => {
      (window as any).term.options.macOptionIsMeta = false;
    });
    await optionF();
    assert.equal(await drain(), 'ƒ', `${name}: Option types layout characters`);
    await check('Alt+ArrowLeft', '\x1b[1;3D');
    await check('Alt+Backspace', '\x1b\x7f');

    await write('\x1b[>'); // split a push at the transport boundary
    await write('1u\x1b[?u\x1b[?1h');
    await check('Space', ' ');
    await check('Shift+T', 'T');
    await check('Shift+Space', '\x1b[32;2u');
    await check('Enter', '\r');
    await check('ArrowLeft', '\x1bOD');
    await check('Control+a', '\x1b[97;5u');
    await check('Alt+Backspace', '\x1b[127;3u');
    await write('\x1b[=2;2u'); // OR flag 2 into flag 1
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.up('ArrowLeft');
    assert.equal(await drain(), '\x1bOD\x1b[1;1:2D\x1b[1;1:3D', `${name}: repeat/release`);
    await write('\x1b[?1049h\x1b[>31u');
    await check('Shift+T', '\x1b[57441;2u\x1b[116:84;2;84u\x1b[116:84;2:3u\x1b[57441;1:3u');
    await write('\x1b[?1049l');
    await check('Enter', '\r\x1b[13;1:3u');
    await write('\x1b[=2;3u');
    await check('Control+a', '\x1b[97;5u');
    await write('\x1b[<u\x1b[?1049h\x1b[<u');
    await check('Control+a', '\x01');
    await write('\x1b[>9u\x1bc'); // RIS clears both buffers
    await check('a', 'a');
    await write('\x1b[>31u');
    await page.evaluate(() => (window as any).term.reset());
    await check('Control+a', '\x01');
    await write('\x1b[>31u');
    // Even REPORT_ALL must leave composition to the text input. A dead-key
    // keydown can precede compositionstart and does not yet have isComposing.
    assert.equal(await deadE(), true);
    assert.equal(await drain(), '');
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '日' });
    await page.waitForFunction(() => (window as any).input !== '');
    assert.equal(await drain(), '日');
    await page.evaluate(() => (window as any).term.dispose());
  }
  assert.deepEqual(errors, []);
});
