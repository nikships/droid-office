import assert from 'node:assert/strict';
import test from 'node:test';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { terminalFixture } from './helpers/terminal-fixture.js';

const status = browserStatus();

test('wterm owns desktop keyboard negotiation, selection and text input', { skip: !status.installed && `No Chromium in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const mount = await terminalFixture(t);
  for (const platform of ['MacIntel', 'Win32']) {
    await t.test(platform, async (sub) => {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await page.addInitScript((value) => Object.defineProperty(navigator, 'platform', { value }), platform);
      await mount(page, '<div id="host" style="width:400px;height:200px"></div><button id="next">Next</button>');
      await page.evaluate(async () => {
        const url = '/term-engine/web-terminal.ts';
        const { term, features } = (await import(url)).createWebTerminal({ macOptionIsMeta: true });
        const w = window as any;
        w.term = term;
        w.bytes = [];
        w.agent = true;
        term.onData((data: string) => w.bytes.push(data));
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => !features.keyException(e, w.agent) && !features.handleKey(e));
        await term.open(document.querySelector('#host'));
        term.resize(40, 8);
        term.focus();
      });
      const sent = () => page.evaluate(() => (window as any).bytes.splice(0).join(''));
      const write = (data: string) => page.evaluate((data) => (window as any).term.write(data), data);
      const key = async (k: string) => {
        await page.keyboard.press(k);
        return sent();
      };
      const layout = async (key: string, code: string, vk: number, modifiers: number, text?: string) => {
        const event = { key, code, windowsVirtualKeyCode: vk, modifiers };
        await cdp.send('Input.dispatchKeyEvent', { ...event, type: text ? 'keyDown' : 'rawKeyDown', text });
        await cdp.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
      };
      if (platform === 'MacIntel') {
        const reset = async (flags: number, agent = true) => {
          await page.evaluate(
            ({ flags, agent }) => {
              const w = window as any;
              w.agent = agent;
              w.term.reset();
              w.term.write(`\x1b[=${flags}ux`);
              w.term.focus();
              w.bytes.length = 0;
            },
            { flags, agent },
          );
        };
        const event = (type: string, props: KeyboardEventInit & { keyCode?: number }) =>
          page.evaluate(
            ({ type, props }) => {
              (window as any).term.textarea.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...props }));
            },
            { type, props },
          );
        await sub.test('Escape clears empty and unserializable terminal selections before interrupting', async () => {
          await reset(1);
          const seen = [];
          for (const kind of ['blank row', 'non-grid text']) {
            const selection = await page.evaluate(async (kind) => {
              const { native } = (window as any).term;
              await new Promise(requestAnimationFrame);
              const node = kind === 'blank row' ? native.element.querySelectorAll('.term-grid .term-row')[1] : native.element.appendChild(document.createElement('span'));
              if (kind === 'non-grid text') node.textContent = 'label';
              const range = document.createRange(),
                sel = document.getSelection()!;
              range.selectNodeContents(node);
              sel.removeAllRanges();
              sel.addRange(range);
              return [sel.isCollapsed, native.getSelectionText()];
            }, kind);
            assert.deepEqual(selection, [false, kind === 'blank row' ? '' : null]);
            seen.push([await key('Escape'), await page.evaluate(() => document.getSelection()!.isCollapsed)]);
          }
          assert.deepEqual(seen, [
            ['', true],
            ['', true],
          ]);
        });
        await sub.test('a composed or missed keyup cannot rename the next plain key', async () => {
          const seen = [];
          for (const composing of [true, false]) {
            await reset(11);
            const digit = { code: 'Digit2', keyCode: 50 };
            await event('keydown', { ...digit, key: '@', altKey: true, shiftKey: true });
            if (composing) {
              await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
              await event('keyup', { ...digit, key: '2', isComposing: true });
              await cdp.send('Input.insertText', { text: '日' });
            }
            await sent();
            await event('keydown', { ...digit, key: '2' });
            await event('keydown', { ...digit, key: '2', repeat: true });
            await event('keyup', { ...digit, key: '2' });
            seen.push(await sent());
          }
          assert.deepEqual(seen, Array(2).fill('\x1b[50u\x1b[50;1:2u\x1b[50;1:3u'));
        });
        await sub.test('Kitty Escape retains its identity without a recognized physical code', async () => {
          await reset(3);
          for (const type of ['keydown', 'keyup']) await event(type, { key: 'Escape', code: 'Unidentified' });
          assert.equal(await sent(), '\x1b[27u\x1b[27;1:3u');
          assert.equal(await key('Tab'), '\t');
        });
        await sub.test('plain Escape keeps Tab and Shift+Tab in the program', async () => {
          const seen = [];
          for (const flags of [0, 1, 3])
            for (const tab of ['Tab', 'Shift+Tab']) {
              await reset(flags);
              seen.push([await key('Escape'), await key(tab)]);
            }
          assert.deepEqual(seen, [
            ['\x1b', '\t'],
            ['\x1b', '\x1b[Z'],
            ['\x1b[27u', '\t'],
            ['\x1b[27u', '\x1b[9;2u'],
            ['\x1b[27u\x1b[27;1:3u', '\t'],
            ['\x1b[27u\x1b[27;1:3u', '\x1b[9;2u\x1b[9;2:3u'],
          ]);
          await reset(1);
          assert.equal(await key('Alt+Enter'), '\x1b[13;3u');
        });
        await sub.test('Mac Control chords use Latin shortcuts on Cyrillic and Caps Lock layouts', async () => {
          const seen = [];
          for (const flags of [0, 1]) {
            await reset(flags);
            for (const [ch, code, vk] of [
              ['C', 'KeyC', 67],
              ['с', 'KeyC', 67],
              ['м', 'KeyV', 86],
              ['ф', 'KeyA', 65],
            ] as const) {
              if (code === 'KeyC') await page.evaluate(() => (window as any).term.native.selectAll());
              await layout(ch, code, vk, 2);
              seen.push(await sent());
            }
          }
          assert.deepEqual(seen, ['\x03', '\x03', '\x16', '\x01', '\x1b[99;5u', '\x1b[99;5u', '\x1b[118;5u', '\x1b[97;5u']);
          await page.evaluate(() => (window as any).term.native.selectAll());
          for (const key of ['C', 'V']) {
            const ev = { key, code: 'Key' + key, ctrlKey: true, modifierCapsLock: true };
            await event('keydown', ev);
            await event('keyup', ev);
          }
          assert.equal(await sent(), '\x1b[99;69u\x1b[118;69u');
        });
        await sub.test('text commits, paste and pointer presses cancel selection traversal', async () => {
          const seen = [];
          for (const activity of ['compositionstart', 'input', 'paste', 'pointerdown']) {
            await reset(1);
            await page.evaluate(() => {
              const sel = document.getSelection()!,
                r = document.createRange();
              r.selectNodeContents(document.querySelector('.term-row')!);
              sel.removeAllRanges();
              sel.addRange(r);
            });
            await key('Escape');
            await page.evaluate((activity) => {
              const { textarea } = (window as any).term;
              textarea.dispatchEvent(new Event(activity, { bubbles: true }));
              if (activity === 'compositionstart') textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '日' }));
            }, activity);
            await sent();
            seen.push(await key('Tab'));
          }
          assert.deepEqual(seen, ['\t', '\t', '\t', '\t']);
        });
        await sub.test('only unnegotiated shell Shift+Enter submits a CR', async () => {
          const seen = [];
          for (const [flags, agent] of [
            [0, false],
            [0, true],
            [1, false],
            [1, true],
          ] as const) {
            await reset(flags, agent);
            seen.push(await key('Shift+Enter'));
          }
          assert.deepEqual(seen, ['\r', '\x1b[13;2u', '\x1b[13;2u', '\x1b[13;2u']);
        });
        await sub.test('clipboard and programmatic paste normalize only outside bracketed mode', async () => {
          await reset(0, false);
          const seen = [];
          for (const mode of ['l', 'h']) {
            await write('\x1b[?2004' + mode);
            await page.evaluate(() => {
              const t = (window as any).term,
                text = 'a\nb\r\nc',
                clipboardData = new DataTransfer();
              clipboardData.setData('text/plain', text);
              t.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
              t.paste(text);
            });
            seen.push(await sent());
          }
          assert.deepEqual(seen, ['a\rb\rc'.repeat(2), '\x1b[200~a\nb\r\nc\x1b[201~'.repeat(2)]);
        });
        await sub.test('Option Meta uses base Space and dead key without a virtual key', async () => {
          await reset(1);
          await layout('\u00a0', 'Space', 32, 1, '\u00a0');
          await event('keydown', { key: 'Dead', code: 'KeyE', keyCode: 0, altKey: true });
          await event('keyup', { key: 'Dead', code: 'KeyE', keyCode: 0, altKey: true });
          assert.equal(await sent(), '\x1b[32;3u\x1b[101;3u');
        });
        await sub.test('remapped Option repeats and releases retain the pressed key', async () => {
          await reset(3);
          await event('keydown', { key: '@', code: 'Digit2', keyCode: 50, altKey: true, shiftKey: true });
          await event('keydown', { key: '™', code: 'Digit2', keyCode: 50, altKey: true, repeat: true });
          await event('keyup', { key: '2', code: 'Digit2', keyCode: 50, altKey: true });
          assert.equal(await sent(), '\x1b[64;4u\x1b[64;3:2u\x1b[64;3:3u');
        });
        await reset(0);
      }
      assert.equal(await key('Control+Enter'), '\x1b[13;5u');
      await page.evaluate(() => ((window as any).agent = false));
      assert.equal(await key('Control+Enter'), '\r');
      assert.equal(await key('Shift+Enter'), '\r');
      if (platform === 'MacIntel') assert.equal(await key('Control+v'), '\x16');
      await write('\x1b[>');
      await write('3u\x1b[>4;2m');
      assert.deepEqual(await page.evaluate(() => [(window as any).term.core.kittyKeyboardFlags(), (window as any).term.core.modifyOtherKeys()]), [3, 2]);
      await page.keyboard.down('ArrowLeft');
      await page.keyboard.down('ArrowLeft');
      await page.keyboard.up('ArrowLeft');
      assert.equal(await sent(), '\x1b[D\x1b[1;1:2D\x1b[1;1:3D');
      await page.evaluate(() => (window as any).term.textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true })));
      assert.equal(await sent(), '', 'no release without a delivered press');
      if (platform === 'MacIntel') {
        assert.equal(await key('Control+v'), '\x1b[118;5u\x1b[118;5:3u');
        await layout('ƒ', 'KeyF', 70, 1, 'ƒ');
        assert.equal(await sent(), '\x1b[102;3u\x1b[102;3:3u');
        await page.evaluate(() => ((window as any).term.options.macOptionIsMeta = false));
        await layout('@', 'KeyL', 76, 1, '@');
        await layout('€', 'KeyE', 69, 1, '€');
        await layout('Dead', 'KeyE', 69, 1);
        await layout('é', 'KeyE', 69, 0, 'é');
        assert.equal(await sent(), '@€é');
      } else {
        await page.keyboard.down('ControlLeft');
        await page.keyboard.down('AltRight');
        await layout('@', 'KeyQ', 81, 3, '@');
        await page.keyboard.up('AltRight');
        await page.keyboard.up('ControlLeft');
        assert.equal(await sent(), '@');
      }
      await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
      await cdp.send('Input.insertText', { text: '日' });
      assert.equal(await sent(), '日');
      await write('\x1b[<u\x1b[>1u\x1b[?2004hselected');
      const select = () =>
        page.evaluate(async () => {
          const { native } = (window as any).term;
          await native.selectAll();
          if (!native.getSelectionText()) throw Error('missing selection');
        });
      await select();
      assert.equal(await key('Escape'), '');
      assert.equal(await page.evaluate(() => (window as any).term.native.getSelectionText()), null);
      assert.equal(await key('Tab'), '');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'next');
      await page.locator('#host textarea').focus();
      await page.evaluate(() => {
        const selection = document.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#host .term-grid .term-row')!);
        selection.removeAllRanges();
        selection.addRange(range);
        if (selection.isCollapsed) throw Error('missing DOM range');
      });
      assert.equal(await key('Escape'), '', 'a mounted-row drag is not an interrupt');
      assert.equal(await page.evaluate(() => document.getSelection()!.isCollapsed), true);
      assert.equal(await key('Tab'), '');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'next');
      await page.locator('#host textarea').focus();
      await select();
      assert.equal(await key('Control+c'), platform === 'MacIntel' ? '\x1b[99;5u' : '');
      const paste = (data: string) =>
        page.evaluate((data) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', data);
          (window as any).term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        }, data);
      await paste('a\nb\x1bc');
      assert.equal(await sent(), '\x1b[200~a\nbc\x1b[201~');
      await page.evaluate(() => (window as any).term.paste("'file name'"));
      assert.equal(await sent(), "\x1b[200~'file name'\x1b[201~");
      await write('\x1b[?2004l');
      await paste('a\nb');
      assert.equal(await sent(), 'a\rb');
      await write('\r\n' + 'reader text\r\n'.repeat(80));
      await page.waitForFunction(() => document.querySelector('#host .wterm')!.scrollHeight > 500);
      await write('\x1b[?1004h');
      assert.equal(await sent(), '', 'enabling focus mode does not report a synthetic focus');
      const reader = await page.evaluate(async () => {
        const w = window as any;
        const el = w.term.native.element;
        el.scrollTop = 63;
        await new Promise(requestAnimationFrame);
        const before = el.scrollTop;
        document.getElementById('next')!.focus();
        const blurred = el.scrollTop;
        w.term.focus();
        await new Promise(requestAnimationFrame);
        return [before, blurred, el.scrollTop];
      });
      assert.deepEqual(reader, [63, 63, 63]);
      assert.equal(await sent(), '\x1b[O\x1b[I');
      await page.evaluate(() => ((window as any).term.options.disableStdin = true));
      await key('a');
      await paste('disabled');
      assert.equal(await sent(), '');
      await page.close();
    });
  }
});
