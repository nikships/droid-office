import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { emptySubscriptionsState, type SubscriptionAccount, type SubscriptionProvider, type SubscriptionsState } from '../src/shared/subscriptions.js';
import { proxyLine, resetLine, ringGroups, ringLabel, RingTips, subscriptionsView, windowLine } from '../src/client/ui/subscriptions-rings.js';

const NOW = Date.parse('2026-11-03T20:30:00Z');
const date = (ms: number) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(ms);

const account = (id: string, label: string, overrides: Partial<SubscriptionAccount> = {}): SubscriptionAccount => ({ id, label, expired: false, disabled: false, windows: [], ...overrides });
const provider = (key: SubscriptionProvider['key'], enabled: boolean, accounts: SubscriptionAccount[]): SubscriptionProvider => ({ key, name: key, enabled, connect: 'browser', accounts });

/** The owner's office as DroidProxy 1.8.192 reported it, with the account labels replaced. */
function ownerState(): SubscriptionsState {
  return {
    ...emptySubscriptionsState(),
    proxy: { phase: 'running', version: '1.8.192', latest: null, path: '/Applications/DroidProxy.app', error: null },
    models: { installed: 15, available: 15, stale: false },
    providers: [
      provider('claude', false, []),
      provider('codex', true, [
        account('codex-owner.json', 'owner@example.com', {
          windows: [
            { name: '5-hour', usedPercent: 19, resetsAt: NOW + 15_960_000 },
            { name: 'Weekly', usedPercent: 61, resetsAt: NOW + 343_380_000 },
          ],
        }),
      ]),
      provider('antigravity', true, [account('antigravity-owner.json', 'owner@example.com'), account('antigravity-second.json', 'second@example.com')]),
      provider('kimi', false, []),
      provider('junie', false, [account('junie.json', 'junie-user')]),
      provider('grok', true, [account('grok.json', 'Owner@example.com', { windows: [{ name: 'Weekly', usedPercent: 6, resetsAt: NOW + 565_500_000 }] })]),
      provider('copilot', false, []),
      provider('meta', false, [account('meta.json', 'Meta account 423f1867')]),
    ],
  };
}

class FakeElement {
  tagName: string;
  className = '';
  attrs = new Map<string, string>();
  children: (FakeElement | string)[] = [];
  listeners = new Map<string, ((e: unknown) => void)[]>();
  props = new Map<string, string>();
  style = { setProperty: (k: string, v: string) => this.props.set(k, v) };
  popoverOpen = false;
  focused = false;
  classList = {
    add: (c: string) => {
      if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim();
    },
    remove: (c: string) => {
      this.className = this.className
        .split(' ')
        .filter((x) => x && x !== c)
        .join(' ');
    },
    contains: (c: string) => this.className.split(' ').includes(c),
  };
  constructor(tag: string) {
    this.tagName = tag;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, e: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  append(c: FakeElement | string) {
    this.children.push(c);
  }
  focus() {
    this.focused = true;
    this.fire('focus');
  }
  showPopover() {
    this.popoverOpen = true;
  }
  hidePopover() {
    this.popoverOpen = false;
  }
  getBoundingClientRect() {
    return { left: 100, top: 100, right: 156, bottom: 156, width: 56, height: 56 };
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  all(cls: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (c.classList.contains(cls)) out.push(c);
      out.push(...c.all(cls));
    }
    return out;
  }
}

function fakeDom(t: TestContext) {
  const saved = ['Node', 'document', 'innerWidth', 'innerHeight'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new FakeElement(tag) } });
  Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 900 });
  t.after(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  });
}

const root = (nodes: HTMLElement[]) => {
  const r = new FakeElement('div');
  for (const n of nodes) r.append(n as unknown as FakeElement);
  return r;
};

test('the window splits plans into rings, switched off and not connected, in the companion order', () => {
  const groups = ringGroups([...ownerState().providers, provider('kimi', true, [])]);
  assert.deepEqual(
    groups.active.map((p) => p.key),
    ['codex', 'grok', 'antigravity'],
  );
  assert.deepEqual(
    groups.off.map((p) => p.key),
    ['claude', 'kimi', 'junie', 'copilot', 'meta'],
  );
  assert.deepEqual(
    groups.unconnected.map((p) => p.key),
    ['kimi'],
  );
});

test('DroidProxy is one line in every phase', () => {
  const s = ownerState();
  const line = (phase: SubscriptionsState['proxy']['phase'], models = s.models) => proxyLine({ ...s, proxy: { ...s.proxy, phase }, models });
  assert.equal(line('running'), 'DroidProxy 1.8.192 · 15 models in Droid');
  assert.equal(line('running', { installed: 14, available: 15, stale: true }), 'DroidProxy 1.8.192 · 14 of 15 models in Droid · update them on the Mac');
  assert.equal(line('running', null), 'DroidProxy 1.8.192');
  assert.equal(line('stopped'), 'DroidProxy 1.8.192 is stopped · starts when a worker needs it');
  assert.equal(line('outdated'), 'DroidProxy 1.8.192 needs an update');
  assert.equal(line('unsupported'), 'Needs a Mac with Apple silicon');
  assert.equal(line('missing'), 'DroidProxy isn’t installed');
  assert.equal(line('installing'), 'Installing DroidProxy…');
  assert.equal(line('starting'), 'Starting DroidProxy…');
});

test('a ring names its provider, account and every window, and its tooltip says when each resets', () => {
  const s = ownerState();
  const codex = s.providers[1];
  assert.equal(ringLabel(codex, codex.accounts[0]), 'ChatGPT, owner@example.com: 5-hour 81% left, Weekly 39% left');
  assert.equal(ringLabel(s.providers[2], s.providers[2].accounts[0]), 'Antigravity, owner@example.com: no usage reported');
  assert.equal(ringLabel(codex, account('x', 'old@example.com', { expired: true, usageError: '429' })), 'ChatGPT, old@example.com: Sign-in expired, usage unavailable');
  assert.equal(ringLabel(codex, account('x', 'off@example.com', { disabled: true, windows: codex.accounts[0].windows })), 'ChatGPT, off@example.com: Off in DroidProxy, 5-hour 81% left, Weekly 39% left');
  const w = codex.accounts[0].windows[0];
  assert.equal(windowLine(w), '5-hour: 81% left');
  assert.equal(resetLine(w, NOW, date), 'Resets in 4 h 26 min (Nov 4, 2026, 12:56 AM)');
  assert.equal(resetLine({ ...w, resetsAt: null }, NOW, date), null);
  assert.equal(resetLine({ ...w, resetsAt: NOW - 1 }, NOW, date), null);
  assert.match(resetLine(w, NOW) ?? '', /^Resets in 4 h 26 min \(.+\)$/);
});

test('the window draws one arc per window, a muted ring without usage, and one muted line for plans that are off', (t) => {
  fakeDom(t);
  const view = subscriptionsView(ownerState(), NOW, date);
  const body = root(view.nodes);
  assert.deepEqual(
    body.all('subs-group-name').map((n) => n.textContent),
    ['ChatGPT', 'Grok', 'Antigravity'],
  );
  assert.deepEqual(
    view.rings.map((r) => r.key),
    ['codex/codex-owner.json', 'grok/grok.json', 'antigravity/antigravity-owner.json', 'antigravity/antigravity-second.json'],
  );
  const [codex, grok, anti] = view.rings.map((r) => r.ring as unknown as FakeElement);
  assert.equal(codex.getAttribute('aria-label'), 'ChatGPT, owner@example.com: 5-hour 81% left, Weekly 39% left');
  assert.deepEqual(
    codex.all('subs-arc').map((a) => [a.className, a.props.get('--left')]),
    [
      ['subs-arc layer-0 good', '81'],
      ['subs-arc layer-1 good', '39'],
    ],
  );
  assert.equal(grok.all('subs-arc').length, 1);
  assert.ok(anti.classList.contains('muted'));
  assert.deepEqual(
    anti.all('subs-arc').map((a) => a.className),
    ['subs-arc empty'],
  );
  const tip = view.rings[0].tip as unknown as FakeElement;
  assert.equal(codex.getAttribute('aria-describedby'), tip.getAttribute('id'));
  assert.equal(tip.getAttribute('role'), 'tooltip');
  assert.equal(tip.getAttribute('popover'), 'manual');
  assert.equal(tip.textContent, 'owner@example.com5-hour: 81% leftResets in 4 h 26 min (Nov 4, 2026, 12:56 AM)Weekly: 39% leftResets in 3 d 23 h (Nov 7, 2026, 7:53 PM)');
  assert.equal((view.rings[2].tip as unknown as FakeElement).textContent, 'owner@example.comNo usage reported');
  assert.deepEqual(
    body.all('subs-off').map((n) => n.textContent),
    ['OffClaudeKimiJunieGitHub CopilotMeta'],
  );
  assert.equal(body.all('subs-provider').length, 0, 'no provider cards');
});

test('the window says so when no plan is in use, and stays empty off a Mac with Apple silicon', (t) => {
  fakeDom(t);
  const s = ownerState();
  const off = { ...s, providers: s.providers.map((p) => ({ ...p, enabled: false })) };
  const body = root(subscriptionsView(off, NOW, date).nodes);
  assert.equal(body.all('subs-empty')[0]?.textContent, 'No plans in use. Connect one on the office’s Mac.');
  assert.equal(body.all('subs-groups').length, 0);
  const broken = root(subscriptionsView({ ...s, proxy: { ...s.proxy, error: 'DroidProxy didn’t answer' } }, NOW, date).nodes);
  assert.equal(broken.all('note')[0]?.textContent, 'DroidProxy didn’t answer');
  assert.equal(root(subscriptionsView(emptySubscriptionsState(), NOW, date).nodes).children.length, 0);
});

test('tooltips open on mouse hover and keyboard focus, pin on click or tap, and close on blur or Esc', (t) => {
  fakeDom(t);
  const view = subscriptionsView(ownerState(), NOW, date);
  const tips = new RingTips();
  tips.attach(view.rings);
  const [a, b] = view.rings;
  const ring = (r: typeof a) => r.ring as unknown as FakeElement;
  const tip = (r: typeof a) => r.tip as unknown as FakeElement;

  ring(a).fire('pointerenter', { pointerType: 'touch' });
  assert.equal(tips.current, null, 'a touch only opens it with its tap');
  ring(a).fire('pointerenter', { pointerType: 'mouse' });
  assert.deepEqual(tips.current, { key: a.key, pinned: false });
  assert.ok(tip(a).popoverOpen);
  assert.ok(ring(a).classList.contains('on'));
  assert.equal(tip(a).props.get('--tip-x'), '100px');
  assert.equal(tip(a).props.get('--tip-y'), '164px');
  ring(a).fire('pointerleave', { pointerType: 'mouse' });
  assert.equal(tips.current, null);
  assert.ok(!tip(a).popoverOpen);

  ring(a).fire('click');
  ring(a).fire('pointerleave', { pointerType: 'mouse' });
  assert.deepEqual(tips.current, { key: a.key, pinned: true }, 'a click pins it past the pointer leaving');
  ring(b).fire('focus');
  assert.deepEqual(tips.current, { key: b.key, pinned: false }, 'one tooltip at a time');
  assert.ok(!tip(a).popoverOpen);
  ring(b).fire('blur');
  assert.equal(tips.current, null);

  ring(b).fire('click');
  ring(b).fire('click');
  assert.equal(tips.current, null, 'a second click closes it');

  ring(a).fire('click');
  const again = subscriptionsView(ownerState(), NOW + 60_000, date);
  tips.attach(again.rings);
  assert.deepEqual(tips.current, { key: a.key, pinned: true }, 'a repaint keeps the same account open');
  assert.ok((again.rings[0].tip as unknown as FakeElement).popoverOpen);
  assert.ok(!tip(a).popoverOpen);
  assert.equal(tips.dismiss(), true);
  assert.equal(tips.dismiss(), false);

  const focusedAgain = subscriptionsView(ownerState(), NOW + 120_000, date);
  tips.attach(focusedAgain.rings, null, b.key);
  const bAgain = focusedAgain.rings[1].ring as unknown as FakeElement;
  assert.ok(bAgain.focused, 'a repaint gives the focused ring its focus back');
  assert.deepEqual(tips.current, { key: b.key, pinned: false });
  bAgain.fire('blur');
  assert.equal(tips.current, null, 'so leaving it still closes its tooltip');
});
