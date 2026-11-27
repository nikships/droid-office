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
    await t.test(platform, async () => {
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
      assert.equal(await key('Control+Enter'), '\x1b[13;5u');
      await page.evaluate(() => ((window as any).agent = false));
      assert.equal(await key('Control+Enter'), '\r');
      assert.equal(await key('Shift+Enter'), '\x1b[13;2u');
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
      assert.equal(await sent(), 'a\nb');
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
