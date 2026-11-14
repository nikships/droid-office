import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { emptyFactoryState, type FactoryState } from '../src/shared/factory.js';
import { emptyLimits, type FactoryLimitsState } from '../src/shared/factory-limits.js';
import { emptySubscriptionsState } from '../src/shared/subscriptions.js';
import { factoryBalance, factoryLimitsNote, factoryLimitsSummary, factoryLimitsView, factoryReset } from '../src/client/ui/factory-limits-view.js';
import { factoryHeaderRings, factoryQuotaRings, subscriptionsView } from '../src/client/ui/subscriptions-rings.js';
import { availabilityOf, canPick, withAvailability } from '../src/client/ui/model-search.js';
import { QuotaWallTexture, quotaView } from '../src/client/world/droidproxy-wall.js';
import { FactoryTvTexture } from '../src/client/world/factory-tv.js';

const NOW = Date.parse('2026-11-14T05:45:39.724Z');

/** The verified Factory /limits capture in DOFF-930, without account identifiers. */
function limits(): FactoryLimitsState {
  return {
    ...emptyLimits(),
    usesTokenRateLimitsBilling: true,
    hasActiveSubscription: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 61, windowEnd: '2026-11-14T06:06:30.724Z', secondsRemaining: 1251 },
        weekly: { usedPercent: 86, windowEnd: '2026-11-14T19:35:51.947Z', secondsRemaining: 49812 },
        monthly: { usedPercent: 56, windowEnd: '2026-12-01T05:59:57.602Z', secondsRemaining: 1469657 },
      },
      core: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: { usedPercent: 20, windowEnd: '2026-11-17T03:30:49.318Z', secondsRemaining: 251109 },
        monthly: { usedPercent: 15, windowEnd: '2026-12-10T03:30:49.318Z', secondsRemaining: 2238309 },
      },
    },
    overagePreference: 'droidCore',
    canManageOverage: true,
    extraUsageBalanceCents: 0,
    extraUsageAllowed: true,
    fetchedAt: NOW,
    error: null,
  };
}

function factory(s = limits()): FactoryState {
  return { ...emptyFactoryState(), connection: { connected: true, capabilities: [] }, limits: s };
}

class Element {
  className = '';
  attrs: Record<string, string> = {};
  children: (Element | string)[] = [];
  props = new Map<string, string>();
  style = { setProperty: (name: string, value: string) => this.props.set(name, value) };
  value = '';
  id = '';
  disabled = false;
  listeners = new Map<string, (() => void)[]>();
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, on: boolean) => {
      const names = this.className.split(' ').filter((n) => n && n !== name);
      if (on) names.push(name);
      this.className = names.join(' ');
    },
  };
  constructor(readonly tag: string) {}
  append(...children: (Element | string)[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: (Element | string)[]) {
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener(name: string, callback: () => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  fire(name: string) {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
  get textContent(): string {
    return this.children.map((n) => (typeof n === 'string' ? n : n.textContent)).join('');
  }
  set textContent(value: string) {
    this.children = [value];
  }
  all(predicate: (el: Element) => boolean): Element[] {
    return this.children.flatMap((n) => (typeof n === 'string' ? [] : [...(predicate(n) ? [n] : []), ...n.all(predicate)]));
  }
  cls(name: string): Element[] {
    return this.all((n) => n.classList.contains(name));
  }
}

function dom(t: TestContext) {
  const values = { Node: Element, HTMLInputElement: Element, HTMLSelectElement: Element, HTMLTextAreaElement: Element, HTMLButtonElement: Element, document: { createElement: (tag: string) => new Element(tag) }, confirm: () => false };
  const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
}

function root(nodes: HTMLElement[]): Element {
  const el = new Element('div');
  el.append(...(nodes as unknown as Element[]));
  return el;
}

test('Factory windows render all six meters, remaining quota, reset countdowns, balance and overage', (t) => {
  dom(t);
  const view = root(factoryLimitsView(factory(), NOW));
  assert.equal(view.all((e) => e.attrs.role === 'meter').length, 6);
  assert.match(view.textContent, /Factory Standard/);
  assert.match(view.textContent, /Factory Droid Core/);
  assert.match(view.textContent, /39% left/);
  assert.match(view.textContent, /14% left/);
  assert.match(view.textContent, /44% left/);
  assert.match(view.textContent, /Resets in 21 min/);
  assert.match(view.textContent, /Window not started/);
  assert.match(view.textContent, /Extra Usage \$0\.00/);
  assert.match(factoryLimitsSummary(limits()), /Droid Core/i);
  assert.equal(factoryBalance({ ...limits(), extraUsageBalanceCents: 1250 }), '$12.50');
  assert.equal(factoryReset({ name: 'Weekly', usedPercent: 100, resetsAt: NOW - 1 }, NOW), 'Reset due · awaiting update');
  assert.equal(factoryReset({ name: 'Weekly', usedPercent: 20, resetsAt: null }, NOW), 'Reset time not reported');
});

test('connected unreadable, Enterprise, inactive and airgapped states stay informative, never show false zeros', (t) => {
  dom(t);
  assert.match(factoryLimitsNote(factory(emptyLimits())) ?? '', /Reading Factory limits/);
  const failed = factory({ ...emptyLimits(), error: 'HTTP 403' });
  assert.match(root(factoryLimitsView(failed, NOW)).textContent, /Couldn’t read Factory limits: HTTP 403/);
  assert.equal(root(factoryLimitsView(failed, NOW)).all((e) => e.attrs.role === 'meter').length, 0);
  assert.match(factoryLimitsNote(factory({ ...emptyLimits(), usesTokenRateLimitsBilling: false, fetchedAt: NOW })) ?? '', /do not apply/);
  assert.match(factoryLimitsNote(factory({ ...emptyLimits(), usesTokenRateLimitsBilling: true, fetchedAt: NOW })) ?? '', /did not report Standard/);
  assert.match(factoryLimitsNote(factory({ ...emptyLimits(), hasActiveSubscription: false })) ?? '', /No active Factory subscription/);
  assert.match(factoryLimitsNote(emptyFactoryState()) ?? '', /Connect a Factory API key/);
  assert.match(factoryLimitsNote(factory(), true) ?? '', /airgapped/i);
  assert.equal(root(factoryLimitsView(factory(), NOW, true)).all((e) => e.attrs.role === 'meter').length, 0);
});

test('Factory rings remain visible without DroidProxy, show three arcs each, and never remove other accounts', (t) => {
  dom(t);
  const s = emptySubscriptionsState();
  const rings = factoryQuotaRings(limits(), NOW);
  assert.deepEqual(
    rings.map((r) => r.key),
    ['factory/standard', 'factory/core'],
  );
  for (const ring of rings) assert.equal((ring.ring as unknown as Element).cls('subs-arc').length, 3);
  assert.match((rings[0].tip as unknown as Element).textContent, /5-hour: 39% left/);
  assert.match((rings[1].tip as unknown as Element).textContent, /Window not started/);
  assert.match((rings[0].tip as unknown as Element).textContent, /Extra Usage \$0\.00/);
  assert.equal(subscriptionsView(s, NOW, undefined, limits()).rings.length, 2);
  const accounts = Array.from({ length: 8 }, (_, i) => ({ id: `account-${i}`, label: `account-${i}`, expired: false, disabled: false, windows: [] }));
  const combined = subscriptionsView({ ...s, proxy: { ...s.proxy, phase: 'missing' }, providers: [{ key: 'codex', name: 'ChatGPT', enabled: true, connect: 'browser', accounts }] }, NOW, undefined, limits());
  assert.equal(combined.rings.length, 10);
  assert.equal(combined.rings.at(-1)?.key, 'codex/account-7');
  const header = factoryHeaderRings(limits(), NOW) as unknown as Element;
  assert.equal(header.cls('subs-arc').length, 6);
  assert.match(header.cls('factory-header-quota')[0].attrs.title, /Standard.*Resets in/);
  assert.equal(factoryHeaderRings(emptyLimits(), NOW), null);
});

test('Factory exhaustion dims hosted pickers with reset and overage reason while Core and custom models stay runnable', () => {
  const s = limits();
  s.limits.standard!.fiveHour.usedPercent = 100;
  const models = [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', scope: 'Anthropic', group: 'Anthropic' },
    { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', scope: 'Other', group: 'Other' },
    { id: 'custom:droidproxy:gpt-6.1-sol', name: 'Sol', custom: true, scope: 'Yours', group: 'DroidProxy' },
  ];
  const [standard, core, custom] = withAvailability(models, emptySubscriptionsState(), NOW, factory(s));
  assert.equal(canPick(standard), false);
  assert.match(standard.reason ?? '', /5-hour/i);
  assert.match(standard.reason ?? '', /Recheck in 21m/);
  assert.equal((standard.reason?.match(/Droid Core fallback/g) ?? []).length, 1);
  assert.equal(canPick(core), true);
  assert.equal(canPick(custom), true);
  assert.equal(availabilityOf(models[0].id, emptySubscriptionsState(), NOW, factory(emptyLimits())).reason, undefined);
});

test('compute wall includes every Factory window, reset and billing mode even on unsupported DroidProxy hosts', () => {
  const view = quotaView(emptySubscriptionsState(), NOW, factory());
  assert.equal(view.accounts, 2);
  assert.equal(view.tiles.filter((t) => t.provider === 'Factory').length, 4);
  assert.deepEqual(
    view.tiles.flatMap((t) => t.windows.map((w) => w.name)),
    ['5-hour', 'Weekly', 'Monthly', '5-hour', 'Weekly', 'Monthly'],
  );
  assert.match(view.note, /Extra Usage \$0\.00/);
  assert.match(view.note, /Droid Core/i);
  assert.match(view.tiles[0].windows[0].reset, /Resets in/);
  assert.equal(view.tiles[2].windows[0].reset, 'Window not started');
});

test('world canvases show Factory limits using render time and keep the session credit history chart', (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const text: string[] = [];
  const rects: number[][] = [];
  const ctx = {
    font: '',
    fillText: (value: string) => text.push(value),
    measureText(value: string) {
      return { width: value.length * Number(this.font.match(/(\d+)px/)?.[1] ?? 20) * 0.6 };
    },
    fillRect: (...r: number[]) => rects.push(r),
    strokeRect() {},
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 0, height: 0, getContext: () => ctx };
        Object.assign(ctx, { canvas });
        return canvas;
      },
    },
  });
  t.mock.method(Date, 'now', () => NOW + 86_400_000);
  const tv = new FactoryTvTexture();
  t.after(() => tv.texture.dispose());
  tv.render(factory(), NOW);
  assert.ok(text.includes('CREDITS TODAY'));
  assert.ok(text.includes('7 DAYS'));
  assert.ok(
    rects.some(([x, y, w, h]) => x === 1270 && y === 550 && w === 572 && h === 2),
    'the original credit history chart remains',
  );
  assert.ok(text.includes('5-hour 39% left · in 21 min'), 'the supplied render clock, not Date.now, determines resets');
  assert.ok(!text.some((line) => /^READ .* AGO/.test(line)), 'never prints bogus epoch age when sessions have not fetched yet');
  assert.ok(text.includes('STANDARD'));
  assert.ok(text.includes('DROID CORE'));
  assert.equal(text.filter((line) => /^(?:5-hour|Weekly|Monthly) .*% left/.test(line)).length, 6);
  const version = tv.texture.version;
  tv.render(factory(), NOW + 1000);
  assert.equal(tv.texture.version, version, 'no per-frame texture upload');
  const wall = new QuotaWallTexture();
  t.after(() => wall.texture.dispose());
  wall.render(emptySubscriptionsState(), NOW, false, factory());
  assert.ok(text.includes('FACTORY + PLANS'), 'the full title fits the narrow compute screen');
  assert.ok(text.includes('CONNECTED'));
  assert.ok(rects.every((r) => r.every(Number.isFinite)));
});

test('overage controls require management access and confirmation, POST exact preference once and surface failures', async (t) => {
  dom(t);
  const { store } = await import('../src/client/state.js');
  const { factoryLimitsPanel } = await import('../src/client/ui/factory-limits.js');
  const saved = { factory: store.factory, setup: store.setup };
  store.factory = factory();
  store.setup = { ...store.setup, airgapped: false };
  t.after(() => {
    store.factory = saved.factory;
    store.setup = saved.setup;
  });
  const posts: { url: string; init: RequestInit }[] = [];
  let accept = false;
  t.mock.method(globalThis, 'confirm', () => accept);
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push({ url: String(url), init: init! });
    await pending;
    return new Response(JSON.stringify({ error: 'Factory denied this change' }), { status: 403 });
  });
  const panel = factoryLimitsPanel();
  t.after(panel.dispose);
  const element = panel.element as unknown as Element;
  const select = element.all((el) => el.tag === 'select')[0];
  select.value = 'extraUsage';
  select.fire('change');
  assert.equal(posts.length, 0, 'cancel does not change billing');
  assert.equal(select.value, 'droidCore');
  accept = true;
  select.value = 'extraUsage';
  select.fire('change');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/factory/limits/overage');
  assert.equal(posts[0].init.method, 'POST');
  assert.equal(posts[0].init.body, JSON.stringify({ overagePreference: 'extraUsage' }));
  assert.equal(select.disabled, true);
  select.value = 'extraUsage';
  select.fire('change');
  assert.equal(posts.length, 1, 'an overlapping change cannot submit twice');
  release!();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(element.textContent, /Factory denied this change/);
  assert.equal(select.disabled, false);
  store.factory.limits.canManageOverage = false;
  store.emit('factory');
  assert.equal(select.disabled, true);
  assert.equal(element.cls('field')[0].classList.contains('hidden'), true);
  assert.equal(store.factory.limits.overagePreference, 'droidCore', 'no optimistic paid preference change');
});
