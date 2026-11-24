import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import type { Terminal } from '@xterm/xterm';
import { attachTerminalScrollbar, isModifierKey, isTerminalScrollKey, SCROLLBAR_HIDE_MS, SCROLL_INTENT_MS } from '../src/client/term-scrollbar.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

function makeClassList() {
  const set = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((n) => set.add(n)),
    remove: (...names: string[]) => names.forEach((n) => set.delete(n)),
    toggle: (name: string, force?: boolean) => {
      const on = force === undefined ? !set.has(name) : force;
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
    contains: (name: string) => set.has(name),
  };
}

function makeTarget() {
  const map = new Map<string, Set<(e: any) => void>>();
  return {
    addEventListener(type: string, fn: (e: any) => void) {
      let set = map.get(type);
      if (!set) {
        set = new Set();
        map.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      map.get(type)?.delete(fn);
    },
    emit(type: string, event: any = {}) {
      for (const fn of [...(map.get(type) ?? [])]) fn(event);
    },
    count(type: string) {
      return map.get(type)?.size ?? 0;
    },
  };
}

function makeEmitter<T>() {
  const listeners = new Set<(v: T) => void>();
  const subscribe = (fn: (v: T) => void) => {
    listeners.add(fn);
    return { dispose: () => listeners.delete(fn) };
  };
  const fire = (v: T) => {
    for (const fn of [...listeners]) fn(v);
  };
  return { subscribe, fire };
}

function makeFakeTerminal(opts: { withScroller?: boolean; openLater?: boolean } = {}) {
  const win = makeTarget();
  const root = Object.assign(makeTarget(), {
    classList: makeClassList(),
    ownerDocument: { defaultView: win },
  });
  const onWriteParsed = makeEmitter<void>();
  const onResize = makeEmitter<{ cols: number; rows: number }>();
  const onData = makeEmitter<string>();
  const onBufferChange = makeEmitter<any>();
  const onScrollerScroll = makeEmitter<{ scrollTop: number }>();

  let scrollTop = 0;
  let height = 200;
  let scrollHeight = 200;
  const active = { type: 'normal' as 'normal' | 'alternate', baseY: 0, viewportY: 0 };

  const scroller = {
    onScroll: onScrollerScroll.subscribe,
    getScrollPosition: () => ({ scrollTop }),
    getScrollDimensions: () => ({ height, scrollHeight }),
  };
  const viewport = { _scrollableElement: scroller, _isSyncing: false };

  let disposed = false;
  const term: any = {
    element: opts.openLater ? undefined : root,
    buffer: { active, onBufferChange: onBufferChange.subscribe },
    onWriteParsed: onWriteParsed.subscribe,
    onResize: onResize.subscribe,
    onData: onData.subscribe,
    _core: opts.withScroller === false ? undefined : { _viewport: viewport },
    open() {
      term.element = root;
    },
    dispose() {
      disposed = true;
    },
  };

  return {
    term: term as Terminal,
    root,
    win,
    active,
    viewport,
    setDims(h: number, sh: number) {
      height = h;
      scrollHeight = sh;
    },
    setScrollTop(px: number, syncing = false) {
      scrollTop = px;
      viewport._isSyncing = syncing;
      try {
        onScrollerScroll.fire({ scrollTop: px });
      } finally {
        viewport._isSyncing = false;
      }
    },
    fireWrite: () => onWriteParsed.fire(),
    fireResize: () => onResize.fire({ cols: 80, rows: 20 }),
    fireData: (d: string) => onData.fire(d),
    fireBufferChange: () => onBufferChange.fire(active),
    isDisposed: () => disposed,
  };
}

test('key helpers only classify Shift+PageUp/PageDown as terminal scroll keys', () => {
  assert.equal(isTerminalScrollKey({ key: 'PageUp', shiftKey: true }), true);
  assert.equal(isTerminalScrollKey({ key: 'PageDown', shiftKey: true }), true);
  assert.equal(isTerminalScrollKey({ key: 'PageUp', shiftKey: false }), false);
  assert.equal(isTerminalScrollKey({ key: 'PageDown', shiftKey: false }), false);
  assert.equal(isTerminalScrollKey({ key: ' ', shiftKey: false }), false);
  assert.equal(isTerminalScrollKey({ key: ' ', shiftKey: true }), false);
  assert.equal(isTerminalScrollKey({ key: 'ArrowUp', shiftKey: false }), false);
  assert.equal(isTerminalScrollKey({ key: 'Tab', shiftKey: false }), false);
  assert.equal(isModifierKey('Shift'), true);
  assert.equal(isModifierKey('Meta'), true);
  assert.equal(isModifierKey(' '), false);
  assert.equal(isModifierKey('a'), false);
});

test('attachTerminalScrollbar suppresses typing, streaming sync, and unscrollable terminals, and reveals on user scroll or drag', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000;
  const fake = makeFakeTerminal({ openLater: true });
  attachTerminalScrollbar(fake.term, { now: () => clock });
  fake.term.open({} as HTMLElement);

  // No scrollback: wheel, typing, and rail clicks never reveal or mark scrollable.
  assert.equal(fake.root.classList.contains('term-scrollable'), false);
  fake.root.emit('wheel', { deltaY: -100 });
  fake.root.emit('keydown', { key: ' ', shiftKey: false });
  fake.root.emit('pointerdown', { button: 0, target: { closest: (sel: string) => (sel === '.scrollbar.vertical' ? {} : null) } });
  assert.equal(fake.root.classList.contains('term-scrollable'), false);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);
  assert.equal(fake.root.classList.contains('term-scrollbar-drag'), false);

  // Add scrollback via streaming sync: marks scrollable, stays hidden.
  fake.active.baseY = 50;
  fake.active.viewportY = 50;
  fake.setDims(200, 1200);
  fake.fireWrite();
  fake.setScrollTop(1000, true);
  assert.equal(fake.root.classList.contains('term-scrollable'), true);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Typing keys (including Space, Arrows, Tab, unmodified PageUp) never reveal.
  for (const key of [' ', 'ArrowUp', 'ArrowDown', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'a']) {
    fake.root.emit('keydown', { key, shiftKey: false });
  }
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Horizontal wheel and in-bounds selection drag + capped-scrollback viewport sync stay hidden.
  fake.root.emit('wheel', { deltaX: 40, deltaY: 0 });
  fake.setScrollTop(980, true);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  const textTarget = { closest: () => null };
  fake.root.emit('pointerdown', { button: 0, target: textTarget });
  fake.win.emit('pointermove', { buttons: 1 });
  fake.setScrollTop(960, true);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);
  fake.win.emit('pointerup');

  // Genuine wheel scroll UP moves scrollTop -> reveals, then hides after SCROLLBAR_HIDE_MS.
  clock += 500;
  fake.root.emit('wheel', { deltaY: -120 });
  fake.active.viewportY = 40;
  fake.setScrollTop(800);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  t.mock.timers.tick(SCROLLBAR_HIDE_MS - 1);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  t.mock.timers.tick(1);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Typing immediately after a wheel scroll cancels the active reveal before xterm snaps to bottom.
  clock += 100;
  fake.root.emit('wheel', { deltaY: -120 });
  fake.active.viewportY = 38;
  fake.setScrollTop(760);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  fake.root.emit('keydown', { key: 'x', shiftKey: false });
  assert.equal(fake.root.classList.contains('term-scrolling'), false);
  assert.equal(fake.root.classList.contains('term-scrollbar-quiet'), true);
  fake.fireData('x');
  fake.active.viewportY = 50;
  fake.setScrollTop(1000);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Bare Shift followed by Shift+PageUp reveals on viewport movement and clears quiet mode.
  clock += 100;
  fake.root.emit('keydown', { key: 'Shift', shiftKey: true });
  fake.root.emit('keydown', { key: 'PageUp', shiftKey: true });
  fake.active.viewportY = 30;
  fake.setScrollTop(600);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  assert.equal(fake.root.classList.contains('term-scrollbar-quiet'), false);
  t.mock.timers.tick(SCROLLBAR_HIDE_MS);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Expired scroll intent does not reveal on subsequent programmatic scroll.
  clock += SCROLL_INTENT_MS + 50;
  fake.root.emit('touchmove');
  clock += SCROLL_INTENT_MS + 1;
  fake.setScrollTop(700);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Dragging the vertical scrollbar holds drag class and survives past SCROLLBAR_HIDE_MS until pointerup.
  const railTarget = { closest: (sel: string) => (sel === '.scrollbar.vertical' ? {} : null) };
  fake.root.emit('pointerdown', { button: 2, target: railTarget });
  assert.equal(fake.root.classList.contains('term-scrollbar-drag'), false);
  fake.root.emit('pointerdown', { button: 0, target: railTarget });
  assert.equal(fake.root.classList.contains('term-scrollbar-drag'), true);
  fake.setScrollTop(400);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  t.mock.timers.tick(SCROLLBAR_HIDE_MS * 3);
  assert.equal(fake.root.classList.contains('term-scrollbar-drag'), true);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  fake.win.emit('pointerup');
  assert.equal(fake.root.classList.contains('term-scrollbar-drag'), false);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  t.mock.timers.tick(SCROLLBAR_HIDE_MS);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Dragging a text selection past the edge (non-syncing scroll) reveals cleanly.
  fake.root.emit('pointerdown', { button: 0, target: textTarget });
  fake.win.emit('pointermove', { buttons: 1 });
  assert.equal(fake.root.classList.contains('term-scrolling'), false);
  fake.setScrollTop(360);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  fake.win.emit('pointerup');
  t.mock.timers.tick(SCROLLBAR_HIDE_MS);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Entering alternate screen clears scrollable and visible classes immediately.
  fake.root.emit('wheel', { deltaY: -100 });
  fake.setScrollTop(300);
  assert.equal(fake.root.classList.contains('term-scrolling'), true);
  fake.active.type = 'alternate';
  fake.active.baseY = 0;
  fake.setDims(200, 200);
  fake.fireBufferChange();
  assert.equal(fake.root.classList.contains('term-scrollable'), false);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Returning to normal buffer restores scrollable without flashing.
  fake.active.type = 'normal';
  fake.active.baseY = 50;
  fake.setDims(200, 1200);
  fake.fireBufferChange();
  assert.equal(fake.root.classList.contains('term-scrollable'), true);
  assert.equal(fake.root.classList.contains('term-scrolling'), false);

  // Dispose removes classes and detaches all listeners.
  fake.term.dispose();
  assert.equal(fake.isDisposed(), true);
  assert.equal(fake.root.classList.contains('term-scrollable'), false);
  assert.equal(fake.root.count('wheel'), 0);
  assert.equal(fake.win.count('pointerup'), 0);
});

test('attachTerminalScrollbar degrades cleanly when xterm viewport internals are absent', () => {
  const fake = makeFakeTerminal({ withScroller: false });
  const handle = attachTerminalScrollbar(fake.term);
  assert.equal(fake.root.classList.contains('term-scrollable'), false);
  assert.equal(fake.root.count('wheel'), 0);
  handle.dispose();
  handle.dispose();
});

const status = browserStatus();

test('terminal scrollbar in Chromium stays hidden during typing and without scrollback, and renders a 3px neutral pill on scroll', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());

  const bundle = buildSync({
    stdin: {
      contents:
        "import './src/client/scrollbars'; export { openTerminal, routeTerminalMessage } from './src/client/ui/terminal'; export { store } from './src/client/state'; export { Terminal } from '@xterm/xterm'; export { SCROLLBAR_HIDE_MS } from './src/client/term-scrollbar';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'TermSB',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
  const xtermCss = await readFile(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');

  const page = await context.newPage();
  await page.setViewportSize({ width: 960, height: 600 });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });

  await page.setContent('<!doctype html><div id="mount"></div><div id="modal-root"></div>');
  await page.addStyleTag({ content: `${xtermCss}\n${css}\nbody { margin: 0; background: #000; }` });
  await page.addScriptTag({ content: bundle });

  await page.evaluate(async () => {
    const w = window as any;
    const { Terminal, store, openTerminal, routeTerminalMessage } = w.TermSB;
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (host: HTMLElement) {
      w.term = this;
      open.call(this, host);
    };
    const mount = document.getElementById('mount')!;
    mount.style.width = '800px';
    mount.style.height = '420px';
    const worker = { id: 'sb', name: 'Pixel', kind: 'agent', color: '#89d9ed', status: 'idle', cols: 100, rows: 20, open: false };
    store.floor = 'floor';
    store.workers.set(worker.id, worker);
    w.net = {
      up: true,
      send(msg: any) {
        if (msg.t === 'worker.attach') queueMicrotask(() => routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data: '', cols: worker.cols, rows: worker.rows, shared: false }));
        if (msg.t === 'term.resize') queueMicrotask(() => store.apply({ t: 'worker.update', worker: { ...worker, cols: msg.cols, rows: msg.rows } }));
        return true;
      },
      async request() {
        return { ok: true };
      },
      onStatus() {
        return () => {};
      },
    };
    openTerminal(w.net, worker.id, undefined, undefined, { mount, focus: true, hideTeam: true });
    while (!w.term?.element?.querySelector('.scrollbar.vertical')) await new Promise((r) => setTimeout(r, 10));
    w.feed = (data: string) => new Promise<void>((resolve) => w.term.write(data, resolve));
    w.frames = async (n = 4) => {
      for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
    };
    w.inspect = () => {
      const root = w.term.element as HTMLElement;
      const bar = root.querySelector('.scrollbar.vertical') as HTMLElement;
      const slider = bar.querySelector('.slider') as HTMLElement;
      const barCs = getComputedStyle(bar);
      const sliderCs = getComputedStyle(slider);
      const pillCs = getComputedStyle(slider, '::before');
      return {
        classes: [...root.classList],
        opacity: Number.parseFloat(barCs.opacity),
        pointerEvents: barCs.pointerEvents,
        sliderBg: sliderCs.backgroundColor,
        pillWidth: pillCs.width,
        pillBg: pillCs.backgroundColor,
        barRect: bar.getBoundingClientRect().toJSON(),
        rootRect: root.getBoundingClientRect().toJSON(),
        viewportY: w.term.buffer.active.viewportY,
        baseY: w.term.buffer.active.baseY,
      };
    };
  });

  // 1. Short content (no scrollback): typing spaces/arrows/tabs, wheeling, and hovering rail stay hidden.
  await page.evaluate(async () => {
    const w = window as any;
    await w.feed('short prompt line\r\n> ');
    await w.frames();
    w.term.focus();
  });
  await page.keyboard.type('hello world this has many spaces');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  const beforeScroll = await page.evaluate(() => (window as any).inspect());
  assert.equal(beforeScroll.classes.includes('term-scrollable'), false);
  assert.equal(beforeScroll.classes.includes('term-scrolling'), false);
  assert.equal(beforeScroll.classes.includes('user-scrolling'), false);
  assert.equal(beforeScroll.opacity, 0);
  assert.equal(beforeScroll.pointerEvents, 'none');

  // Wheel over unscrollable terminal still stays completely hidden.
  await page.mouse.move(beforeScroll.rootRect.left + 200, beforeScroll.rootRect.top + 150);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(150);
  const afterUnscrollableWheel = await page.evaluate(() => (window as any).inspect());
  assert.equal(afterUnscrollableWheel.opacity, 0);
  assert.equal(afterUnscrollableWheel.pointerEvents, 'none');

  // 2. Overflow with real scrollback: stays hidden at rest and while typing, even with spaces & arrows.
  await page.evaluate(async () => {
    const w = window as any;
    w.term.options.scrollback = 100;
    const lines = Array.from({ length: 140 }, (_, i) => `output line ${i + 1}`).join('\r\n');
    await w.feed(`${lines}\r\n`);
    await w.frames(6);
    w.term.focus();
  });
  await page.waitForTimeout(350);
  const atRest = await page.evaluate(() => (window as any).inspect());
  assert.equal(atRest.classes.includes('term-scrollable'), true);
  assert.equal(atRest.classes.includes('term-scrolling'), false);
  assert.equal(atRest.opacity, 0);
  assert.equal(atRest.pointerEvents, 'auto');

  // Hovering terminal text area (not rail) and typing never reveals scrollbar.
  await page.mouse.move(atRest.rootRect.left + 200, atRest.rootRect.top + 150);
  await page.keyboard.type('typing a prompt with spaces and arrows');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  const afterTyping = await page.evaluate(() => (window as any).inspect());
  assert.equal(afterTyping.classes.includes('term-scrolling'), false);
  assert.equal(afterTyping.classes.includes('user-scrolling'), false);
  assert.equal(afterTyping.opacity, 0);

  // 3. Real wheel scroll UP reveals minimal 3px neutral hairline pill, then fades back out.
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(160);
  const whileScrolling = await page.evaluate(() => (window as any).inspect());
  assert.equal(whileScrolling.classes.includes('term-scrolling'), true);
  assert.ok(whileScrolling.opacity > 0.9, `expected visible scrollbar while scrolling, got opacity=${whileScrolling.opacity}`);
  assert.equal(whileScrolling.sliderBg, 'rgba(0, 0, 0, 0)');
  assert.equal(whileScrolling.pillWidth, '3px');
  assert.equal(whileScrolling.pillBg, 'rgba(255, 255, 255, 0.22)');

  // 4. Typing immediately while the pill is still visible cancels the reveal right away before snapping to bottom.
  await page.keyboard.type('xyz');
  const rightAfterType = await page.evaluate(() => (window as any).inspect());
  assert.equal(rightAfterType.viewportY, rightAfterType.baseY);
  assert.equal(rightAfterType.classes.includes('term-scrolling'), false);
  assert.equal(rightAfterType.opacity, 0);

  // 4b. Moving the pointer outside the terminal (so xterm sets .invisible.fade) then typing cancels immediately.
  await page.mouse.move(atRest.rootRect.left + 200, atRest.rootRect.top + 150);
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(160);
  await page.mouse.move(atRest.rootRect.right + 40, atRest.rootRect.top + 150);
  await page.waitForTimeout(40);
  await page.keyboard.type('a');
  const afterOutsideType = await page.evaluate(() => (window as any).inspect());
  assert.equal(afterOutsideType.viewportY, afterOutsideType.baseY);
  assert.equal(afterOutsideType.classes.includes('term-scrolling'), false);
  assert.equal(afterOutsideType.opacity, 0);

  // 4c. Typing mid-idle-fade (after .term-scrolling expired, while fading out) also cancels immediately.
  await page.mouse.move(atRest.rootRect.left + 200, atRest.rootRect.top + 150);
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(SCROLLBAR_HIDE_MS + 60);
  await page.keyboard.type('b');
  const afterMidFadeType = await page.evaluate(() => (window as any).inspect());
  assert.equal(afterMidFadeType.viewportY, afterMidFadeType.baseY);
  assert.equal(afterMidFadeType.classes.includes('term-scrolling'), false);
  assert.equal(afterMidFadeType.opacity, 0);

  // 5. Horizontal wheel or in-bounds selection drag followed by capped-scrollback trimming stays hidden.
  await page.mouse.wheel(0, -160);
  // Smooth scrolling can extend the reveal; wait for the actual fade to finish.
  await page.waitForFunction(() => (window as any).inspect().classes.includes('term-scrolling'), null, { timeout: 3000 });
  await page.waitForFunction(
    () => {
      const state = (window as any).inspect();
      return !state.classes.includes('term-scrolling') && state.opacity === 0;
    },
    null,
    { timeout: 3000 },
  );
  const beforeTrim = await page.evaluate(() => (window as any).inspect());
  assert.equal(beforeTrim.opacity, 0);
  assert.ok(beforeTrim.viewportY < beforeTrim.baseY);
  await page.mouse.wheel(80, 0);
  await page.evaluate(async () => {
    const w = window as any;
    await w.feed('trimmed line 1\r\ntrimmed line 2\r\n');
    await w.frames(4);
  });
  await page.waitForTimeout(140);
  const afterHorizTrim = await page.evaluate(() => (window as any).inspect());
  assert.equal(afterHorizTrim.viewportY, beforeTrim.viewportY - 2);
  assert.equal(afterHorizTrim.classes.includes('term-scrolling'), false);
  assert.equal(afterHorizTrim.opacity, 0);

  // In-bounds selection drag followed by capped-scrollback output trimming also stays hidden.
  await page.mouse.move(atRest.rootRect.left + 80, atRest.rootRect.top + 120);
  await page.mouse.down();
  await page.mouse.move(atRest.rootRect.left + 160, atRest.rootRect.top + 120);
  await page.evaluate(async () => {
    const w = window as any;
    await w.feed('trimmed during selection\r\n');
    await w.frames(4);
  });
  await page.waitForTimeout(140);
  const afterSelectTrim = await page.evaluate(() => (window as any).inspect());
  assert.equal(afterSelectTrim.classes.includes('term-scrolling'), false);
  assert.equal(afterSelectTrim.opacity, 0);
  await page.mouse.up();

  // 6. Hovering the right-edge scrollbar rail reveals and widens pill to 5px; dragging keeps it active.
  const railX = atRest.barRect.left + atRest.barRect.width / 2;
  const railY = atRest.barRect.top + atRest.barRect.height / 2;
  await page.mouse.move(railX, railY);
  await page.waitForTimeout(200);
  const onRailHover = await page.evaluate(() => (window as any).inspect());
  assert.ok(onRailHover.opacity > 0.9, `expected rail hover to reveal scrollbar, got opacity=${onRailHover.opacity}`);
  assert.equal(onRailHover.pillWidth, '5px');
  assert.equal(onRailHover.pillBg, 'rgba(255, 255, 255, 0.42)');

  await page.mouse.down();
  await page.mouse.move(railX - 80, railY - 40);
  await page.waitForTimeout(160);
  const whileDragging = await page.evaluate(() => (window as any).inspect());
  assert.equal(whileDragging.classes.includes('term-scrollbar-drag'), true);
  assert.ok(whileDragging.opacity > 0.9, 'expected scrollbar to stay visible while dragging off-rail');
  assert.equal(whileDragging.pillWidth, '5px');
  assert.equal(whileDragging.pillBg, 'rgba(255, 255, 255, 0.58)');
  await page.mouse.up();

  // 7. Clearing scrollback (CSI 3 J) while the pill is visible hides immediately with no full-height ghost pill.
  await page.mouse.move(atRest.rootRect.left + 200, atRest.rootRect.top + 150);
  await page.mouse.wheel(0, -160);
  await page.waitForTimeout(160);
  const beforeClear = await page.evaluate(() => (window as any).inspect());
  assert.ok(beforeClear.opacity > 0.9);
  await page.evaluate(async () => {
    const w = window as any;
    await w.feed('\x1b[3J\x1b[2J\x1b[H');
    await w.frames(3);
  });
  // Sample mid-fade (100ms): must already be opacity 0, never a fading full-height pill.
  await page.waitForTimeout(100);
  const afterClear = await page.evaluate(() => (window as any).inspect());
  assert.equal(afterClear.baseY, 0);
  assert.equal(afterClear.classes.includes('term-scrollable'), false);
  assert.equal(afterClear.opacity, 0);
  assert.equal(afterClear.pointerEvents, 'none');

  // 8. Re-fill scrollback and verify entering alternate screen removes scrollable and hides immediately.
  await page.evaluate(async () => {
    const w = window as any;
    const lines = Array.from({ length: 80 }, (_, i) => `refill line ${i + 1}`).join('\r\n');
    await w.feed(`${lines}\r\n`);
    await w.frames(4);
  });
  await page.mouse.wheel(0, -160);
  await page.waitForTimeout(160);
  await page.evaluate(async () => {
    const w = window as any;
    await w.feed('\x1b[?1049hALT SCREEN');
    await w.frames(3);
  });
  await page.waitForTimeout(100);
  const inAlt = await page.evaluate(() => (window as any).inspect());
  assert.equal(inAlt.classes.includes('term-scrollable'), false);
  assert.equal(inAlt.opacity, 0);
  assert.equal(inAlt.pointerEvents, 'none');
});
