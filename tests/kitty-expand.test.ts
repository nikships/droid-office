import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { hitTestKittyRect, isKittyModClick, isKittyPlainPress, isNormalKittyShell, kittyPlacementBounds, shouldExpandKittyClick, type DrawnKittyRect } from '../src/client/term-kitty.js';
import { KITTY_DIACRITICS, KITTY_PLACEHOLDER_CHAR } from '../src/shared/kitty.js';

test('pure Kitty image hit-testing, placement bounds and click rules', () => {
  const rects: DrawnKittyRect[] = [
    { imageId: 10, placementId: 1, dx: 0, dy: 0, dw: 100, dh: 40, z: 0 },
    { imageId: 10, placementId: 1, dx: 0, dy: 40, dw: 80, dh: 40, z: 0 },
    { imageId: 20, placementId: 0, dx: 50, dy: 20, dw: 40, dh: 40, z: 2 },
    { imageId: 30, placementId: 0, dx: 50, dy: 20, dw: 40, dh: 40, z: -1 },
  ];

  assert.equal(hitTestKittyRect(rects, 10, 10)?.imageId, 10);
  assert.equal(hitTestKittyRect(rects, 60, 30)?.imageId, 20, 'higher z wins over lower z regardless of order');
  assert.equal(hitTestKittyRect(rects, 200, 10), undefined);
  assert.deepEqual(kittyPlacementBounds(rects, 10, 1), { x: 0, y: 0, width: 100, height: 80 });
  assert.equal(kittyPlacementBounds(rects, 99, 0), undefined);

  const normalShell = { bufferType: 'normal', mouseTrackingMode: 'none' };
  const tuiMouse = { bufferType: 'normal', mouseTrackingMode: 'any' };
  const altScreen = { bufferType: 'alternate', mouseTrackingMode: 'none' };

  assert.equal(isNormalKittyShell(normalShell), true);
  assert.equal(isNormalKittyShell(tuiMouse), false);
  assert.equal(isNormalKittyShell(altScreen), false);

  const baseClick = {
    button: 0,
    detail: 1,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    movedPx: 1,
    hadSelection: false,
    hasSelection: false,
    shell: normalShell,
  };

  assert.equal(isKittyPlainPress(baseClick, normalShell), true);
  assert.equal(isKittyPlainPress(baseClick, tuiMouse), false);
  assert.equal(isKittyModClick({ ...baseClick, metaKey: true }), true);
  assert.equal(isKittyModClick({ ...baseClick, ctrlKey: true }), true);
  assert.equal(isKittyModClick({ ...baseClick, metaKey: true, shiftKey: true }), false);

  assert.equal(shouldExpandKittyClick(baseClick), true, 'plain click in normal shell expands');
  assert.equal(shouldExpandKittyClick({ ...baseClick, movedPx: 12 }), false, 'drag does not expand');
  assert.equal(shouldExpandKittyClick({ ...baseClick, detail: 2 }), false, 'double-click word select does not expand');
  assert.equal(shouldExpandKittyClick({ ...baseClick, hasSelection: true }), false, 'active selection does not expand');
  assert.equal(shouldExpandKittyClick({ ...baseClick, hadSelection: true }), false, 'clicking to dismiss selection does not expand');
  assert.equal(shouldExpandKittyClick({ ...baseClick, shell: tuiMouse }), false, 'plain click in mouse-mode TUI does not expand');
  assert.equal(shouldExpandKittyClick({ ...baseClick, shell: altScreen }), false, 'plain click in alternate screen does not expand');
  assert.equal(shouldExpandKittyClick({ ...baseClick, shell: tuiMouse, metaKey: true }), true, 'Cmd+click in TUI expands');
  assert.equal(shouldExpandKittyClick({ ...baseClick, shell: altScreen, ctrlKey: true }), true, 'Ctrl+click in alt screen expands');
});

const status = browserStatus();

function placeholderGrid(imageId: number, cols: number, rows: number): string {
  const r = (imageId >> 16) & 0xff;
  const g = (imageId >> 8) & 0xff;
  const b = imageId & 0xff;
  let out = `\x1b[38;2;${r};${g};${b}m`;
  for (let row = 0; row < rows; row++) {
    const dr = String.fromCodePoint(KITTY_DIACRITICS[row]);
    for (let col = 0; col < cols; col++) {
      const dc = String.fromCodePoint(KITTY_DIACRITICS[col]);
      out += `${KITTY_PLACEHOLDER_CHAR}${dr}${dc}`;
    }
    out += '\r\n';
  }
  out += '\x1b[39m';
  return out;
}

test('Kitty terminal images expand on hover button, Cmd/Ctrl+click, and normal-shell plain click (first frame for animations, no-op if evicted)', {
  skip: status.installed ? false : `Chromium is not installed in ${status.path}`,
}, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());

  const bundle = buildSync({
    stdin: {
      contents: "export { openTerminal, openOfficeShell, routeTerminalMessage } from './src/client/ui/terminal'; export { store } from './src/client/state'; export { Terminal } from '@xterm/xterm';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'TerminalUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;

  const page = await context.newPage();
  await page.setViewportSize({ width: 960, height: 640 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addStyleTag({ path: fileURLToPath(new URL('../src/client/style.css', import.meta.url)) });
  await page.setContent('<!doctype html><div id="mount" style="width:720px;height:420px"></div><div id="toasts" data-single></div><div id="modal-root"></div>');
  await page.addStyleTag({ path: fileURLToPath(new URL('../src/client/style.css', import.meta.url)) });
  await page.addScriptTag({ content: bundle });

  // 2x2 red RGBA frame 0 (`#ff0000ff`) and 2x2 blue RGBA frame 1 (`#0000ffff`).
  const redRgba = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]).toString('base64');
  const blueRgba = Buffer.from([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]).toString('base64');
  const animStream = [`\x1b_Ga=T,U=1,q=2,f=32,s=2,v=2,i=7,c=8,r=4;${redRgba}\x1b\\`, `\x1b_Ga=f,q=2,f=32,s=2,v=2,i=7,z=20;${blueRgba}\x1b\\`, '\x1b_Ga=a,q=2,i=7,r=1,z=20\x1b\\', '\x1b_Ga=a,q=2,i=7,s=3\x1b\\', placeholderGrid(7, 8, 4)].join(
    '',
  );

  await page.evaluate((initialData) => {
    const w = window as any;
    const { Terminal, store, openTerminal, routeTerminalMessage } = w.TerminalUI;
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (host: HTMLElement) {
      w.term = this;
      open.call(this, host);
    };
    const worker = { id: 'sprocket', name: 'Sprocket', kind: 'shell', color: '#89d9ed', status: 'idle', cols: 80, rows: 24, open: true };
    store.workers.set(worker.id, worker);
    w.sent = [];
    w.net = {
      up: true,
      send(msg: any) {
        w.sent.push(msg);
        if (msg.t === 'worker.attach') {
          queueMicrotask(() => routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data: initialData, cols: worker.cols, rows: worker.rows, shared: true }));
        }
        return true;
      },
      onStatus() {
        return () => {};
      },
    };
    w.writeData = (data: string) => routeTerminalMessage({ t: 'term.data', workerId: worker.id, data });
    openTerminal(w.net, worker.id, undefined, undefined, { mount: document.getElementById('mount')!, focus: true });
  }, animStream);

  // Wait until the Kitty canvas actually paints non-transparent pixels in the top-left image area.
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.term-kitty-layer');
    if (!c || c.width === 0) return false;
    const ctx = c.getContext('2d');
    const px = ctx?.getImageData(8, 8, 1, 1).data;
    return !!px && px[3] === 255;
  });
  // Wait until animation advances at least once to blue so we prove lightbox still uses frame 0 (red).
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.term-kitty-layer');
    const px = c?.getContext('2d')?.getImageData(8, 8, 1, 1).data;
    return !!px && px[2] > 200 && px[0] < 30;
  });

  const imgCenter = await page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
    return { x: screen.left + 20, y: screen.top + 20 };
  });

  // 1. Hover reveals the expand button and sets zoom-in cursor in normal shell.
  await page.mouse.move(imgCenter.x, imgCenter.y);
  const hoverState = await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('.term-kitty-expand');
    const screen = document.querySelector('.xterm-screen')!;
    return {
      visible: !!btn && !btn.hidden,
      title: btn?.title ?? '',
      clickable: screen.classList.contains('term-kitty-clickable'),
    };
  });
  assert.equal(hoverState.visible, true);
  assert.match(hoverState.title, /Click/);
  assert.equal(hoverState.clickable, true);

  // 2. Plain click in normal shell opens `.wt-picture-window` showing frame 0 (red, 2x2).
  await page.mouse.click(imgCenter.x, imgCenter.y);
  await page.waitForSelector('.modal.wt-picture-window img.wt-picture-full');
  const expandedFrame = await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('.modal.wt-picture-window img.wt-picture-full')!;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 1, 1).data;
    const sub = document.querySelector('.modal.wt-picture-window header p.sub')?.textContent ?? '';
    return { w: img.naturalWidth, h: img.naturalHeight, r: d[0], g: d[1], b: d[2], a: d[3], sub };
  });
  assert.equal(expandedFrame.w, 2);
  assert.equal(expandedFrame.h, 2);
  assert.equal(expandedFrame.r, 255, 'animated Kitty image expands its first frame (red), not later blue frame');
  assert.equal(expandedFrame.b, 0);
  assert.match(expandedFrame.sub, /Sprocket · 2 × 2/);

  // 3. Escape closes ONLY the picture viewer without sending Esc to the PTY, and restores terminal focus.
  await page.evaluate(() => {
    (window as any).sent.length = 0;
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal.wt-picture-window'));
  const afterEsc = await page.evaluate(() => ({
    inputs: (window as any).sent.filter((m: any) => m.t === 'term.input'),
    focused: (window as any).term.textarea === document.activeElement,
  }));
  assert.deepEqual(afterEsc.inputs, [], 'Escape closing lightbox is not typed into the terminal');
  assert.equal(afterEsc.focused, true, 'Closing lightbox restores terminal focus');

  // 4. Switch terminal into TUI mouse-tracking mode (`?1000h` + `?1006h`): plain click does NOT expand,
  //    while hover button click and Ctrl+click DO expand without leaking mouse sequences to the PTY.
  await page.evaluate(() => (window as any).writeData('\x1b[?1000h\x1b[?1006h'));
  await page.waitForFunction(() => (window as any).term.modes.mouseTrackingMode !== 'none');
  await page.evaluate(() => {
    (window as any).sent.length = 0;
  });

  await page.mouse.click(imgCenter.x, imgCenter.y);
  const plainInTui = await page.evaluate(() => ({
    modal: !!document.querySelector('.modal.wt-picture-window'),
    inputs: (window as any).sent.filter((m: any) => m.t === 'term.input').length,
  }));
  assert.equal(plainInTui.modal, false, 'plain click in mouse-mode TUI does not open viewer');
  assert.ok(plainInTui.inputs > 0, 'plain click in mouse-mode TUI still reaches the TUI');

  // Hover button click in TUI opens viewer and sends zero PTY input.
  await page.evaluate(() => {
    (window as any).sent.length = 0;
  });
  await page.mouse.move(imgCenter.x, imgCenter.y);
  await page.click('.term-kitty-expand');
  await page.waitForSelector('.modal.wt-picture-window');
  assert.equal(await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'term.input').length), 0, 'clicking expand button never leaks mouse sequences to TUI');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal.wt-picture-window'));

  // Ctrl+click in TUI opens viewer and sends zero PTY input.
  await page.evaluate(() => {
    (window as any).sent.length = 0;
  });
  await page.keyboard.down('Control');
  await page.mouse.click(imgCenter.x, imgCenter.y);
  await page.keyboard.up('Control');
  await page.waitForSelector('.modal.wt-picture-window');
  assert.equal(await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'term.input').length), 0, 'Ctrl+click on image never leaks mouse sequences to TUI');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal.wt-picture-window'));

  // 5. Evicted / freed image (`a=d,d=I,i=7`): hover button hides and Ctrl+click is a graceful no-op.
  await page.evaluate(() => (window as any).writeData('\x1b[?1000l\x1b[?1006l\x1b_Ga=d,d=I,i=7,q=2\x1b\\'));
  await page.waitForFunction(() => {
    const btn = document.querySelector<HTMLButtonElement>('.term-kitty-expand');
    return !btn || btn.hidden;
  });
  await page.mouse.move(imgCenter.x, imgCenter.y);
  await page.mouse.click(imgCenter.x, imgCenter.y);
  assert.equal(await page.evaluate(() => !!document.querySelector('.modal.wt-picture-window')), false);
  assert.deepEqual(errors, []);
});
