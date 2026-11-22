import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as nodeModule from 'node:module';
import { test } from 'node:test';
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions, MessageBoxOptions } from 'electron';
import { type CompanionBounds, parseCompanionBounds, resolveCompanionBounds } from '../src/desktop/companion-bounds.js';
import type { CompanionWindowOptions } from '../src/desktop/companion.js';

const primary = { id: 1, workArea: { x: 0, y: 24, width: 1440, height: 876 } };
const secondary = { id: 2, workArea: { x: -1280, y: -40, width: 1280, height: 960 } };
const displays = [primary.workArea, secondary.workArea];
const office = 'http://localhost:4677/';
const dashboard = `${office}dashboard`;

test('companion bounds validate their dimensions, coordinate pair and presentation flags', () => {
  const dimensions = { width: 700, height: 450 };
  assert.deepEqual(parseCompanionBounds(dimensions), { width: 720, height: 480 });
  assert.deepEqual(parseCompanionBounds({ ...dimensions, x: -250, y: 0, maximized: false, fullScreen: true, extra: 2 }), {
    x: -250,
    y: 0,
    width: 720,
    height: 480,
    maximized: false,
    fullScreen: true,
  });
  for (const bounds of [
    null,
    [],
    {},
    { ...dimensions, width: '720' },
    { ...dimensions, height: Number.POSITIVE_INFINITY },
    { ...dimensions, width: 1.5 },
    { ...dimensions, x: 250 },
    { ...dimensions, y: 0 },
    { ...dimensions, x: 250, y: Number.NaN },
    { ...dimensions, x: 250.5, y: 0 },
    { ...dimensions, maximized: 1 },
    { ...dimensions, fullScreen: null },
  ]) {
    assert.equal(parseCompanionBounds(bounds), undefined);
  }
});

test('restoring the companion keeps it fully visible, including on the left-hand or smaller display', () => {
  const normal = { maximized: false, fullScreen: false };
  assert.deepEqual(resolveCompanionBounds(undefined, displays), { ...normal, x: 120, y: 62, width: 1200, height: 800 });
  assert.deepEqual(resolveCompanionBounds({ x: -1220, y: 25, width: 850, height: 500 }, displays), { ...normal, x: -1220, y: 25, width: 850, height: 500 });
  assert.deepEqual(resolveCompanionBounds({ x: -1360, y: -150, width: 1300, height: 1100, maximized: true }, displays), {
    ...normal,
    x: -1280,
    y: -40,
    width: 1280,
    height: 960,
    maximized: true,
  });
  assert.deepEqual(resolveCompanionBounds({ x: -400, y: 30, width: 920, height: 600 }, displays), { ...normal, x: 0, y: 30, width: 920, height: 600 });
  assert.deepEqual(resolveCompanionBounds({ x: 4500, y: 20, width: 900, height: 600, fullScreen: true }, displays), {
    ...normal,
    x: 270,
    y: 162,
    width: 900,
    height: 600,
    fullScreen: true,
  });
  assert.deepEqual(resolveCompanionBounds(undefined, [{ x: 20, y: 10, width: 650, height: 400 }]), { ...normal, x: 20, y: 10, width: 650, height: 400 });
  assert.deepEqual(resolveCompanionBounds(undefined, []), { ...normal, width: 1200, height: 800 });
});

class Contents extends EventEmitter {
  url = dashboard;
  destroyed = false;
  zoom = 1.5;
  scripts: string[] = [];
  styles: string[] = [];
  zoomLimits: number[][] = [];
  loads: string[] = [];
  edits: string[] = [];
  session = { addWordToSpellCheckerDictionary: (word: string) => this.edits.push(`add:${word}`) };
  reloads = 0;
  crashes = 0;
  open?: (details: { url: string }) => unknown;
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  getZoomFactor = () => this.zoom;
  setZoomFactor = (zoom: number) => (this.zoom = zoom);
  setVisualZoomLevelLimits = async (...limits: number[]) => this.zoomLimits.push(limits);
  executeJavaScript = async (source: string) => this.scripts.push(source);
  insertCSS = async (css: string) => this.styles.push(css);
  replaceMisspelling = (word: string) => this.edits.push(`replace:${word}`);
  copy = () => this.edits.push('copy');
  cut = () => this.edits.push('cut');
  paste = () => this.edits.push('paste');
  selectAll = () => this.edits.push('selectAll');
  reload = () => this.reloads++;
  forcefullyCrashRenderer = () => this.crashes++;
  loadURL = async (url: string) => this.loads.push(url);
  setWindowOpenHandler = (handler: Contents['open']) => (this.open = handler);
}

// Redirect only Electron's host API; drive the real companion factory and its registered listeners.
export class BrowserWindow extends EventEmitter {
  readonly webContents = new Contents();
  readonly calls: string[] = [];
  readonly normal: { x: number; y: number; width: number; height: number };
  fullScreen = false;
  maximized = false;
  destroyed = false;
  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
    const { x = 0, y = 0, width = 0, height = 0 } = options;
    this.normal = { x, y, width, height };
  }
  isDestroyed = () => this.destroyed;
  isMaximized = () => this.maximized;
  isFullScreen = () => this.fullScreen;
  getNormalBounds = () => this.normal;
  maximize = () => {
    this.calls.push('maximize');
    this.maximized = true;
    this.emit('maximize');
  };
  show = () => this.calls.push('show');
  focus = () => this.calls.push('focus');
  setFullScreen = (fullScreen: boolean) => {
    this.calls.push(`fullScreen:${fullScreen}`);
    this.fullScreen = fullScreen;
    this.emit(fullScreen ? 'enter-full-screen' : 'leave-full-screen');
  };
}
export const screen = { getPrimaryDisplay: () => primary, getAllDisplays: () => [secondary, primary] };
export const app = { quit: () => quitCount++ };
export const shell = { openExternal: async (url: string) => opened.push(url) };
export const clipboard = { writeText: (text: string) => copied.push(text) };
export const Menu = { buildFromTemplate: (items: MenuItemConstructorOptions[]) => ({ popup: (options: unknown) => menus.push({ items, options }) }) };
export const dialog = {
  showMessageBox: (window: BrowserWindow, options: MessageBoxOptions) => new Promise<{ response: number }>((resolve) => pending.push({ window, options, respond: (response) => resolve({ response }) })),
};

let quitCount = 0;
const opened: string[] = [];
const copied: string[] = [];
const menus: { items: MenuItemConstructorOptions[]; options: unknown }[] = [];
const pending: { window: BrowserWindow; options: MessageBoxOptions; respond: (response: number) => void }[] = [];
const skip = !nodeModule.registerHooks && 'The Electron event harness needs Node 22.15+';
let factory: typeof import('../src/desktop/companion.js') | undefined;

async function create(options: CompanionWindowOptions | (() => string | undefined) = () => office): Promise<BrowserWindow> {
  if (!factory) {
    const hooks = nodeModule.registerHooks({
      resolve(specifier, context, next) {
        return specifier === 'electron' ? { url: import.meta.url, shortCircuit: true } : next(specifier, context);
      },
    });
    try {
      factory = await import('../src/desktop/companion.js');
    } finally {
      hooks.deregister();
    }
  }
  return factory.createCompanionWindow(options) as unknown as BrowserWindow;
}

test('companion restores window modes and reapplies chrome and zoom to a fresh document', { skip }, async () => {
  const ordinary = await create();
  assert.equal(ordinary.options.minWidth, 720);
  assert.equal(ordinary.options.minHeight, 480);
  assert.deepEqual(ordinary.normal, { x: 120, y: 62, width: 1200, height: 800 });
  ordinary.emit('ready-to-show');
  assert.deepEqual(ordinary.calls, ['show', 'focus']);
  const zoomed = await create({ officeUrl: () => office, bounds: { width: 920, height: 620, maximized: true } });
  zoomed.emit('ready-to-show');
  assert.deepEqual(zoomed.calls, ['maximize', 'show']);
  const win = await create({ officeUrl: () => office, bounds: { width: 900, height: 600, maximized: true, fullScreen: true } });
  win.emit('ready-to-show');
  assert.deepEqual(win.calls, ['show', 'fullScreen:true']);
  win.webContents.emit('dom-ready');
  assert.equal(win.webContents.styles.length, 1);
  assert.deepEqual(win.webContents.zoomLimits, [[1, 1]]);
  assert.equal(win.webContents.zoom, 1);
  win.setFullScreen(false);
  assert.deepEqual(
    win.webContents.scripts.map((source) => source.match(/'companion-fullscreen', (true|false)/)?.[1]),
    ['true', 'true', 'false'],
  );
  win.webContents.destroyed = true;
  win.webContents.emit('dom-ready');
  assert.equal(win.webContents.styles.length, 1);
});

test('bounds saves use normal bounds, debounce moves and preserve full screen when switching or quitting', { skip }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved: CompanionBounds[] = [];
  let switching = false;
  let quitting = false;
  const win = await create({ officeUrl: () => office, isSwitching: () => switching, isQuitting: () => quitting, onBoundsChange: (bounds) => saved.push(bounds) });
  win.emit('close');
  assert.equal(saved.length, 0, 'do not overwrite saved bounds before the restored window shows');
  win.emit('ready-to-show');
  win.normal.width = 860;
  win.emit('resize');
  t.mock.timers.tick(200);
  win.normal.x = 160;
  win.emit('move');
  t.mock.timers.tick(249);
  assert.equal(saved.length, 0);
  t.mock.timers.tick(1);
  const normal = { x: 160, y: 62, width: 860, height: 800, maximized: false, fullScreen: false };
  assert.deepEqual(saved, [normal]);
  win.maximize();
  assert.deepEqual(saved.at(-1), { ...normal, maximized: true });
  win.maximized = false;
  win.emit('unmaximize');
  assert.deepEqual(saved.at(-1), normal);
  win.setFullScreen(true);
  assert.deepEqual(saved.at(-1), { ...normal, fullScreen: true });
  win.setFullScreen(false);
  assert.deepEqual(saved.at(-1), normal);
  for (const end of ['switch', 'quit']) {
    win.setFullScreen(true);
    switching = end === 'switch';
    quitting = end === 'quit';
    win.setFullScreen(false);
    assert.deepEqual(saved.at(-1), { ...normal, fullScreen: true });
    switching = quitting = false;
    win.emit('resize');
    win.emit('close');
    assert.deepEqual(saved.at(-1), { ...normal, fullScreen: true });
  }
  win.emit('move');
  win.emit('closed');
  const before = saved.length;
  t.mock.timers.tick(250);
  assert.equal(saved.length, before);
});

test('browser popups and context actions work without expanding in-window navigation', { skip }, async () => {
  const win = await create();
  const page = win.webContents;
  const external = 'https://example.com/';
  for (const url of [dashboard, external, 'javascript:void(0)']) assert.deepEqual(page.open?.({ url }), { action: 'deny' });
  assert.deepEqual(opened, [dashboard, external]);
  let prevented = false;
  const event = { preventDefault: () => (prevented = true) };
  page.emit('will-navigate', event, `${dashboard}#worker=lead`);
  assert.equal(prevented, false);
  page.emit('will-navigate', event, `${dashboard}?token=abc`);
  assert.equal(prevented, true);
  assert.deepEqual(opened, [dashboard, external]);
  page.emit('context-menu', {}, { isEditable: false, selectionText: '', linkURL: '', editFlags: {} });
  assert.equal(menus.length, 0);
  page.emit(
    'context-menu',
    {},
    {
      x: 20,
      y: 40,
      isEditable: true,
      selectionText: '',
      linkURL: dashboard,
      misspelledWord: 'ofice',
      dictionarySuggestions: ['office', 'orifice', 'offices', 'officiate', 'officer', 'offset'],
      editFlags: { canCopy: true, canCut: true, canPaste: true, canSelectAll: true },
    },
  );
  assert.deepEqual(menus[0]?.options, { window: win, x: 20, y: 40 });
  const items = menus[0]!.items;
  assert.deepEqual(
    items.slice(0, 10).map((item) => item.label ?? item.type),
    ['office', 'orifice', 'offices', 'officiate', 'officer', 'Add to Dictionary', 'separator', 'Open Link in Browser', 'Copy Link Address', 'separator'],
  );
  for (const label of ['office', 'Add to Dictionary', 'Open Link in Browser', 'Copy Link Address', 'Cut', 'Copy', 'Paste', 'Select All']) {
    const click = items.find((item) => item.label === label)?.click;
    assert.ok(click, label);
    Reflect.apply(click, undefined, []);
  }
  assert.deepEqual(page.edits, ['replace:office', 'add:ofice', 'cut', 'copy', 'paste', 'selectAll']);
  assert.deepEqual(opened, [dashboard, external, dashboard]);
  assert.deepEqual(copied, [dashboard]);
});

function failLoad(win: BrowserWindow, code = -102, url = dashboard, main = true) {
  win.webContents.emit('did-fail-load', {}, code, 'ERR_CONNECTION_REFUSED', url, main);
}

test('only main dashboard load failures get three spaced retries and a retryable error', { skip }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warn = t.mock.method(console, 'warn', () => {});
  const win = await create();
  const page = win.webContents;
  failLoad(win, -3);
  failLoad(win, -102, 'data:text/html,splash');
  failLoad(win, -102, dashboard, false);
  t.mock.timers.tick(6000);
  assert.deepEqual(page.loads, []);
  for (const [i, delay] of [500, 1500, 3000].entries()) {
    failLoad(win);
    failLoad(win); // A second event while one retry is pending does not consume another attempt.
    page.emit('did-finish-load'); // Chromium finishes painting its error document and still reports /dashboard.
    t.mock.timers.tick(delay - 1);
    assert.equal(page.loads.length, i);
    t.mock.timers.tick(1);
    assert.equal(page.loads.length, i + 1);
    assert.equal(page.loads.at(-1), dashboard);
  }
  failLoad(win);
  assert.match(decodeURIComponent(page.loads[3]!), /href="http:\/\/localhost:4677\/dashboard">Retry/);
  assert.deepEqual(warn.mock.calls[0]?.arguments, ['droid-office: companion failed to load after 3 retries (error -102)']);
  page.emit('did-navigate');
  page.emit('did-finish-load');
  failLoad(win);
  t.mock.timers.tick(500);
  assert.equal(page.loads.at(-1), dashboard);
  assert.equal(page.loads.length, 5);
  failLoad(win);
  page.emit('did-navigate');
  page.emit('did-finish-load');
  t.mock.timers.tick(6000);
  assert.equal(page.loads.length, 5);
  failLoad(win);
  win.emit('closed');
  t.mock.timers.tick(6000);
  assert.equal(page.loads.length, 5);
});

test('renderer crashes reload once, then prompt once, and Reload restarts the crash budget', { skip }, async () => {
  let quitting = false;
  const win = await create({ officeUrl: () => office, isQuitting: () => quitting });
  const page = win.webContents;
  const gone = (reason = 'crashed') => page.emit('render-process-gone', {}, { reason });
  const start = pending.length;
  quitting = true;
  gone('killed');
  quitting = false;
  gone('clean-exit');
  assert.deepEqual(page.loads, []);
  page.url = 'about:blank';
  gone();
  assert.deepEqual(page.loads, [dashboard]);
  page.url = dashboard;
  gone();
  gone();
  assert.equal(pending.length, start + 1);
  assert.equal(pending.at(-1)?.window, win);
  assert.deepEqual(pending.at(-1)?.options.buttons, ['Reload', 'Quit']);
  pending.at(-1)?.respond(0);
  await Promise.resolve();
  assert.equal(page.reloads, 1);
  gone();
  assert.equal(page.reloads, 2);
  gone();
  pending.at(-1)?.respond(1);
  await Promise.resolve();
  assert.equal(quitCount, 1);
});

test('hung renderers can wait or force recovery, with stale dialogs dismissed on recovery or close', { skip }, async () => {
  const win = await create();
  const page = win.webContents;
  const start = pending.length;
  page.emit('unresponsive');
  page.emit('unresponsive');
  assert.equal(pending.length, start + 1);
  assert.deepEqual(pending.at(-1)?.options.buttons, ['Wait', 'Reload']);
  pending.at(-1)?.respond(0);
  await Promise.resolve();
  assert.equal(page.crashes, 0);
  page.emit('unresponsive');
  page.emit('responsive');
  assert.equal(pending.at(-1)?.options.signal?.aborted, true);
  pending.at(-1)?.respond(1);
  await Promise.resolve();
  assert.equal(page.crashes, 0);
  page.emit('unresponsive');
  pending.at(-1)?.respond(1);
  await Promise.resolve();
  assert.equal(page.crashes, 1);
  page.emit('render-process-gone', {}, { reason: 'killed' });
  assert.equal(page.reloads, 1);
  page.emit('unresponsive');
  const hang = pending.at(-1);
  page.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(hang?.options.signal?.aborted, true);
  assert.deepEqual(pending.at(-1)?.options.buttons, ['Reload', 'Quit']);
  win.emit('closed');
  assert.equal(pending.at(-1)?.options.signal?.aborted, true);
});
