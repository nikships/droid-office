import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { HotReloadState } from '../src/shared/hot-reload.js';
import { hotReloadSettings } from '../src/client/ui/hot-reload.js';

const script = readFileSync(new URL('../src/client/public/office-reload.js', import.meta.url), 'utf8');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const status = (overrides: Partial<HotReloadState> = {}) => ({ available: true, enabled: true, phase: 'idle', revision: 'one', restartRequired: false, ...overrides });

class Element {
  children: (Element | string)[] = [];
  parent?: Element;
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  listeners = new Map<string, (() => void)[]>();
  disabled = false;
  hidden = false;
  id = '';
  content = '';
  className = '';
  private text = '';
  constructor(readonly tag: string) {}
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  setAttribute(key: string, value: string) {
    this.attrs.set(key, value);
    if (key === 'disabled') this.disabled = true;
    if (key === 'hidden') this.hidden = true;
  }
  append(...children: (Element | string)[]) {
    for (const child of children) {
      this.children.push(child);
      if (child instanceof Element) child.parent = this;
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  click() {
    if (!this.disabled) for (const listener of this.listeners.get('click') || []) listener();
  }
}

function browser(revision = 'one') {
  const body = new Element('body');
  const meta = new Element('meta');
  meta.content = revision;
  const document = { body, createElement: (tag: string) => new Element(tag), querySelector: (selector: string) => (selector === 'meta[name="office-revision"]' ? meta : null) };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const listeners = new Map<string, ((event: any) => void)[]>();
  const calls: { url: string; options: RequestInit }[] = [];
  let sequence = 0;
  let reloads = 0;
  let beforeReload = 0;
  let current = status();
  let handler: ((options: RequestInit) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>) | undefined;
  const response = (value: unknown, code = 200) => ({ status: code, ok: code >= 200 && code < 300, json: async () => value });
  const fetch = async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return handler ? handler(options) : response(current);
  };
  const setTimeout = (fn: () => void, ms: number) => {
    const id = ++sequence;
    timers.set(id, { fn, ms });
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const window = {
    location: { reload: () => reloads++ },
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, [...(listeners.get(type) || []), listener]),
    dispatchEvent: (event: { type: string }) => {
      if (event.type === 'office:before-reload') beforeReload++;
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
  };
  class CustomEvent {
    constructor(readonly type: string) {}
  }
  return {
    body,
    calls,
    timers,
    globals: { document, Node: Element, fetch, setTimeout, clearTimeout },
    response,
    get reloads() {
      return reloads;
    },
    get beforeReload() {
      return beforeReload;
    },
    setState: (overrides: Parameters<typeof status>[0]) => {
      current = status(overrides);
    },
    setHandler: (fn: typeof handler) => {
      handler = fn;
    },
    boot: () => runInNewContext(script, { document, window, fetch, setTimeout, clearTimeout, AbortController, CustomEvent }, { filename: 'office-reload.js' }),
    emit: (type: string, event: unknown) => {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    tick: async (ms = 2000) => {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `Expected a ${ms}ms timer`);
      timers.delete(entry[0]);
      entry[1].fn();
      await flush();
    },
    banner: () => body.children.find((child): child is Element => child instanceof Element && child.id === 'office-source-reload'),
  };
}

const buttons = (element: Element): Element[] => element.children.flatMap((c) => (c instanceof Element ? (c.tag === 'button' ? [c] : buttons(c)) : []));

test('HTML bootstraps a classic independent script before the game module', () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="office-revision" content=""\s*\/>/);
  assert.match(html, /<script src="\/api\/hot-reload\/client\.js" defer><\/script>/);
  assert.ok(html.indexOf('/api/hot-reload/client.js') < html.indexOf('src="./main.ts"'));
});

test('a main parse failure does not prevent polling, recovery reloads exactly once', async () => {
  const b = browser();
  b.boot();
  b.emit('error', { message: 'Unexpected token in /assets/main.js' });
  await flush();
  assert.match(b.banner()!.textContent, /office client hit an error/);
  assert.match(b.banner()!.textContent, /Unexpected token/);
  b.setState({ revision: 'two' });
  await b.tick();
  assert.equal(b.reloads, 1);
  assert.equal(b.beforeReload, 1);
  assert.equal(b.timers.size, 0);
  assert.equal(b.calls[0].url, '/api/hot-reload');
  assert.equal(b.calls[0].options.cache, 'no-store');
  assert.equal(b.calls[0].options.credentials, 'same-origin');
});

test('an unchanged broken published client never reload-loops', async () => {
  const b = browser();
  b.boot();
  await flush();
  b.emit('unhandledrejection', { reason: new Error('Scene failed') });
  for (let i = 0; i < 3; i++) await b.tick();
  assert.equal(b.reloads, 0);
  assert.match(b.banner()!.textContent, /Scene failed/);
  assert.equal(b.timers.size, 1);
});

test('a failed build at the loaded revision does not reload and renders errors as text', async () => {
  const b = browser();
  const error = '<img src=x onerror=alert(1)>\nTypeScript failed';
  b.setState({ phase: 'error', error });
  b.boot();
  await flush();
  assert.equal(b.reloads, 0);
  const detail = b.banner()!.children[1] as Element;
  assert.equal(detail.textContent, error);
  assert.deepEqual(detail.children, []);
});

test('a previously published new revision reloads even when a later build errored', async () => {
  const b = browser();
  b.setState({ phase: 'error', revision: 'two', error: 'Later build failed' });
  b.boot();
  await flush();
  assert.equal(b.reloads, 1);
  assert.equal(b.timers.size, 0);
});

test('disabled source reload never reloads a newer revision or shows runtime warnings', async () => {
  const b = browser();
  b.setState({ enabled: false, revision: 'two', restartRequired: true });
  b.boot();
  b.emit('error', { message: 'Broken game' });
  await flush();
  assert.equal(b.reloads, 0);
  assert.equal(b.banner(), undefined);
});

test('offline requests retry and recover when the local server returns', async () => {
  const b = browser();
  b.setHandler(async () => {
    throw new Error('offline');
  });
  b.boot();
  await flush();
  assert.equal(b.timers.size, 1);
  b.setHandler(undefined);
  b.setState({ revision: 'two' });
  await b.tick();
  assert.equal(b.reloads, 1);
});

test('requests do not overlap and timed-out polls retry', async () => {
  const b = browser();
  b.setHandler((options) => new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })));
  b.boot();
  await flush();
  assert.equal(b.calls.length, 1);
  assert.deepEqual(
    [...b.timers.values()].map((timer) => timer.ms),
    [8000],
  );
  await b.tick(8000);
  assert.deepEqual(
    [...b.timers.values()].map((timer) => timer.ms),
    [2000],
  );
  b.setHandler(undefined);
  await b.tick();
  assert.equal(b.calls.length, 2);
});

test('401 stops polling', async () => {
  const b = browser();
  b.setHandler(async () => b.response({ error: 'Unauthorized' }, 401));
  b.boot();
  await flush();
  assert.equal(b.calls.length, 1);
  assert.equal(b.timers.size, 0);
});

test('retry and disable work from the broken page without game code', async () => {
  const b = browser();
  b.setState({ phase: 'error', error: 'Build failed' });
  b.boot();
  b.emit('error', { message: 'Broken game' });
  await flush();
  const [retry, disable] = buttons(b.banner()!);
  retry.click();
  await flush();
  assert.equal(b.calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(b.calls[1].options.body as string), { rebuild: true });
  assert.deepEqual(Object.fromEntries(Object.entries(b.calls[1].options.headers!)), { 'Content-Type': 'application/json' });
  b.setState({ enabled: false });
  disable.click();
  await flush();
  assert.deepEqual(JSON.parse(b.calls[2].options.body as string), { enabled: false });
  assert.equal(b.banner(), undefined);
});

test('a restart warning shows with working buttons', async () => {
  const b = browser();
  b.setState({ restartRequired: true });
  b.boot();
  await flush();
  assert.match(b.banner()!.textContent, /Restart the local office/);
  for (const button of buttons(b.banner()!)) assert.equal(button.disabled, false);
});

test('disable stays available during a build, retry does not', async () => {
  const b = browser();
  b.setState({ phase: 'building' });
  b.boot();
  await flush();
  const [retry, disable] = buttons(b.banner()!);
  assert.equal(retry.disabled, true);
  assert.equal(disable.disabled, false);
});

test('empty development revision leaves polling and reloads to Vite', async () => {
  const b = browser('');
  b.boot();
  b.emit('error', { message: 'Dev parse error' });
  await flush();
  assert.equal(b.calls.length, 0);
  assert.equal(b.timers.size, 0);
  assert.equal(b.reloads, 0);
  assert.equal(b.banner(), undefined);
});

function settingsBrowser(t: TestContext, revision = 'one') {
  const b = browser(revision);
  for (const [key, value] of Object.entries(b.globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return b;
}

test('settings poll independently and the controls enable, retry and disable', async (t) => {
  const b = settingsBrowser(t);
  b.setState({ enabled: false });
  const card = hotReloadSettings();
  t.after(card.dispose);
  await flush();
  const root = card.element as unknown as Element;
  assert.match(root.textContent, /npm run build && npm run start/);
  const [toggle, rebuild] = buttons(root);
  assert.equal(toggle.textContent, 'Enable');
  assert.equal(toggle.disabled, false);
  assert.equal(rebuild.disabled, true);
  b.setState({ phase: 'error', error: 'Invalid source', restartRequired: true });
  toggle.click();
  await flush();
  assert.deepEqual(JSON.parse(b.calls[1].options.body as string), { enabled: true });
  assert.equal(toggle.textContent, 'Disable');
  assert.match(rebuild.textContent, /retry/);
  assert.match(root.textContent, /Restart the local office/);
  assert.match(root.textContent, /Invalid source/);
  rebuild.click();
  await flush();
  assert.deepEqual(JSON.parse(b.calls[2].options.body as string), { rebuild: true });
  b.setState({ enabled: false });
  toggle.click();
  await flush();
  assert.deepEqual(JSON.parse(b.calls[3].options.body as string), { enabled: false });
  card.dispose();
  assert.equal(b.timers.size, 0);
});

test('settings show unavailable reasons and disable the controls', async (t) => {
  const b = settingsBrowser(t);
  b.setState({ available: false, reason: 'Local source checkout missing', enabled: false });
  const card = hotReloadSettings();
  t.after(card.dispose);
  await flush();
  const root = card.element as unknown as Element;
  assert.match(root.textContent, /Local source checkout missing/);
  assert.ok(buttons(root).every((button) => button.disabled));
});

test('settings dispose aborts in-flight fetch and prevents later polls', async (t) => {
  const b = settingsBrowser(t);
  b.setHandler((options) => new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })));
  const card = hotReloadSettings();
  await flush();
  card.dispose();
  await flush();
  assert.equal(b.calls[0].options.signal!.aborted, true);
  assert.equal(b.timers.size, 0);
  assert.equal(b.calls.length, 1);
});

test('settings explain Vite development without polling the production API', (t) => {
  const b = settingsBrowser(t, '');
  const card = hotReloadSettings();
  assert.match(card.element.textContent!, /Vite development/);
  assert.match(card.element.textContent!, /:4600/);
  assert.equal(b.calls.length, 0);
  card.dispose();
});
