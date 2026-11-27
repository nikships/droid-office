import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('Chromium sends identical keyboard bytes from xterm and wterm', { skip: !status.installed && `No Chromium in ${status.path}` }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-wterm-keys-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    cacheDir,
    configFile: false,
    resolve: { alias: { '/oracle': fileURLToPath(new URL('./oracle', import.meta.url)) } },
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@xterm/xterm', '@wterm/dom', '@wterm/ghostty'] },
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
  const errors: string[] = [];

  for (const platform of ['MacIntel', 'Win32']) {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((value) => Object.defineProperty(navigator, 'platform', { value }), platform);
    await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div style="width:640px;height:320px" id="host"></div>' }));
    await page.goto(`http://127.0.0.1:${address.port}/fixture`);

    const run = async (name: string) => {
      await page.evaluate(async (name) => {
        const modules = ['/oracle/terminal.ts', '/term-engine/wterm-keys.ts', '/oracle/kitty.ts', '/term-mirror.ts'];
        const [{ comparisonTerminal }, { attachWtermKeys }, { attachKittyTerminal }, { suppressMirrorQueries }] = await Promise.all(modules.map((url) => import(url)));
        const w = window as any;
        const term = comparisonTerminal({ allowProposedApi: true, macOptionIsMeta: true }, name);
        const { keyAction } = name !== 'xterm' ? attachWtermKeys(term) : attachKittyTerminal(term);
        w.term = term;
        w.csiEnter = false;
        w.bytes = '';
        term.onData((data: string) => {
          w.bytes += data;
        });
        suppressMirrorQueries(term);
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if ((e.ctrlKey && e.key === ']') || (e.shiftKey && e.key === 'Escape')) return false;
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
      const results: Record<string, string> = {};
      let state = '';
      const record = async (label: string, fn: () => Promise<unknown>) => {
        await fn();
        results[`${state}/${label}`] = await page.evaluate(() => {
          const w = window as any;
          const bytes = w.bytes;
          w.bytes = '';
          return bytes;
        });
      };
      const key = (k: string) => record(k, () => page.keyboard.press(k));
      const layout = async (key: string, code: string, windowsVirtualKeyCode: number, modifiers: number, text?: string) => {
        const event = { key, code, windowsVirtualKeyCode, modifiers };
        await cdp.send('Input.dispatchKeyEvent', { ...event, type: text ? 'keyDown' : 'rawKeyDown', text });
        await cdp.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
      };
      const write = (vt: string) => page.evaluate((vt) => new Promise<void>((done) => (window as any).term.write(vt, done)), vt);
      for (const [label, vt] of [
        ['legacy', ''],
        ['disambiguate', '\x1b[>1u'],
        ['events', '\x1b[=2;2u'],
      ]) {
        state = label;
        if (vt) {
          await write(vt.slice(0, 3));
          await write(vt.slice(3));
        }
        await record('query', () => write('\x1b[?u'));
        if (platform === 'Win32') {
          // Chromium reports AltGr as Ctrl+Alt with a right Alt held on Windows.
          await record('AltGr+Q', async () => {
            await page.keyboard.down('ControlLeft');
            await page.keyboard.down('AltRight');
            await layout('@', 'KeyQ', 81, 3, '@');
            await page.keyboard.up('AltRight');
            await page.keyboard.up('ControlLeft');
          });
          continue;
        }
        for (const k of [
          'Enter',
          'Control+Enter',
          'Shift+Enter',
          'Alt+ArrowLeft',
          'Alt+ArrowRight',
          'Alt+Backspace',
          'Alt+Delete',
          'Control+v',
          'Control+a',
          'Control+c',
          'Control+Space',
          'Space',
          'Shift+T',
          'Shift+Tab',
          'Escape',
          'Tab',
          'Backspace',
          'ArrowUp',
          'ArrowDown',
          'F1',
          'F5',
          'Shift+F12',
          'Control+]',
          'Shift+Escape',
          'Alt+Tab',
          'Control+Alt+Backspace',
          'Meta+Backspace',
          'Control+Shift+A',
          'Control+Shift+V',
          'Control+2',
          'Control+3',
          'Control+8',
          'Control+[',
          'Control+\\',
          'Control+Insert',
          'Alt+PageUp',
          'Alt+Insert',
        ])
          await key(k);
        // Avoid dispatching the OS paste command to the test machine's clipboard.
        await record('Shift+Insert', () => page.evaluate(() => (window as any).term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Insert', keyCode: 45, shiftKey: true, bubbles: true, cancelable: true }))));
        for (const [key, code, vk] of [
          ['k', 'KeyV', 75],
          ['v', 'Period', 86],
          ['м', 'KeyV', 86],
        ] as const)
          await record(`${key}@${code}`, () => layout(key, code, vk, 2));
        await record('Cmd+V and paste', async () => {
          await write('\x1b[?2004h');
          await layout('v', 'KeyV', 86, 4);
          await page.evaluate(() => {
            const data = new DataTransfer();
            data.setData('text/plain', 'paste\nsecond line');
            (window as any).term.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
          });
        });
        for (const meta of [true, false]) {
          await page.evaluate((v) => {
            (window as any).term.options.macOptionIsMeta = v;
          }, meta);
          await record(`Option-F meta=${meta}`, () => layout('ƒ', 'KeyF', 70, 1, 'ƒ'));
          await record(`Option-; meta=${meta}`, () => layout('…', 'Semicolon', 186, 1, '…'));
          await record(`word navigation meta=${meta}`, async () => {
            for (const key of ['Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Backspace', 'Alt+Delete']) await page.keyboard.press(key);
          });
          // The layout reports Option+` and Option+E as dead before compositionstart.
          for (const [code, vk] of [
            ['KeyE', 69],
            ['Backquote', 192],
          ] as const) {
            await record(`Option-${code} meta=${meta}`, async () => {
              await layout('Dead', code, vk, 1);
              if (!meta) {
                const accented = code === 'KeyE' ? 'á' : 'à';
                await layout(accented, 'KeyA', 65, 0, accented);
              }
            });
          }
        }
        await record('IME commit', async () => {
          await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
          await page.evaluate(() => (window as any).term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })));
          await cdp.send('Input.insertText', { text: '日' });
          await page.waitForFunction(() => (window as any).bytes !== '');
        });
        await page.evaluate(() => {
          (window as any).term.options.macOptionIsMeta = true;
        });
        await record('Ctrl+C with a selection', async () => {
          await write('\rselect me');
          await page.evaluate(async () => {
            const { term } = window as any;
            await (term.native ?? term).selectAll();
            if (!(term.native ? term.native.getSelectionText() : term.getSelection())) throw Error('expected selected text');
          });
          await page.keyboard.press('Control+c');
        });
        await record('CSI Enter enabled', async () => {
          await page.evaluate(() => {
            (window as any).csiEnter = true;
          });
          await page.keyboard.press('Control+Enter');
          await page.keyboard.press('Shift+Enter');
          await page.evaluate(() => {
            (window as any).csiEnter = false;
          });
        });
        await write('\x1b[?1h');
        for (const k of ['Home', 'End', 'ArrowLeft']) await key(k);
        await record('repeat/release', async () => {
          await page.keyboard.down('ArrowLeft');
          await page.keyboard.down('ArrowLeft');
          await page.keyboard.up('ArrowLeft');
        });
        await write('\x1b[?1l');
        await record('disabled', async () => {
          await page.evaluate(() => {
            (window as any).term.options.disableStdin = true;
          });
          await page.keyboard.press('a');
          await page.keyboard.press('Control+v');
          await page.keyboard.press('Shift+Enter');
          await page.evaluate(() => {
            (window as any).term.options.disableStdin = false;
          });
        });
      }
      if (platform === 'MacIntel') {
        state = 'transitions';
        await write('\x1b[?1049h\x1b[>31u');
        await key('Shift+T');
        await write('\x1b[?1049l\x1b[<u\x1b[>4;2m');
        await key('Control+a');
        await write('\x1b[>9u\x1bc');
        await key('a');
        await write('\x1b[>31u');
        await page.evaluate(() => (window as any).term.reset());
        await key('Control+x');
        // Deliberate safety difference: wterm strips embedded ESC in bracketed paste.
        await write('\x1b[?2004h');
        const paste = await page.evaluate(() => {
          const w = window as any;
          const data = new DataTransfer();
          data.setData('text/plain', 'a\x1bb');
          w.term.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
          return w.bytes;
        });
        assert.equal(paste, name === 'xterm' ? '\x1b[200~a\x1bb\x1b[201~' : '\x1b[200~ab\x1b[201~');
        if (name === 'ghostty') {
          await write('\x1b[=1u\x1b[>3u\x1b[>4;2m');
          const modes = await page.evaluate(() => {
            const { core } = (window as any).term;
            return [core.kittyKeyboardFlags(), core.modifyOtherKeys()];
          });
          assert.deepEqual(modes, [0, 0], 'only the office encoder negotiated modes');
        }
      }
      await page.evaluate(() => (window as any).term.dispose());
      return results;
    };
    const xterm = await run('xterm');
    const wterm = await run('ghostty');
    for (const [key, expected] of Object.entries(xterm)) assert.equal(wterm[key], expected, `${platform} ${key}`);
    if (platform === 'Win32') {
      assert.equal(xterm['legacy/AltGr+Q'], '@');
      assert.equal(xterm['disambiguate/AltGr+Q'], '\x1b[113;7u', 'the office encoder reports Ctrl+Alt after negotiation');
    } else {
      assert.equal(wterm['legacy/Control+v'], '\x16');
      assert.equal(wterm['legacy/k@KeyV'], '\x0b');
      assert.equal(wterm['legacy/v@Period'], '\x16');
      assert.equal(wterm['legacy/м@KeyV'], '\x16');
      for (const state of ['legacy', 'disambiguate', 'events']) {
        for (const shortcut of ['query', 'Control+]', 'Shift+Escape', 'disabled']) assert.equal(wterm[`${state}/${shortcut}`], '', shortcut);
        assert.equal(wterm[`${state}/IME commit`], '日');
        assert.equal(wterm[`${state}/Cmd+V and paste`], '\x1b[200~paste\rsecond line\x1b[201~');
      }
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
});
