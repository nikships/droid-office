import assert from 'node:assert/strict';
import test from 'node:test';
import type { Net } from '../src/client/net.js';
import type { ClientMsg } from '../src/shared/protocol.js';
import { emptySetupState } from '../src/shared/setup.js';

class Element {
  children: (Element | string)[] = [];
  attrs: Record<string, string> = {};
  events = new Map<string, (e?: unknown) => void>();
  classes = new Set<string>();
  className = '';
  textContent = '';
  checked = false;
  title = '';
  classList = { toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)) };
  constructor(readonly tag: string) {}
  append(...children: (Element | string)[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: (Element | string)[]) {
    this.children = children;
  }
  setAttribute(key: string, value: string) {
    this.attrs[key] = value;
  }
  addEventListener(key: string, fn: (e?: unknown) => void) {
    this.events.set(key, fn);
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((c) => (typeof c === 'string' ? [] : c.all()))];
  }
  text(): string {
    return this.textContent + this.children.map((c) => (typeof c === 'string' ? c : c.text())).join(' ');
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.Node = Element;
globals.document = { createElement: (tag: string) => new Element(tag) };

test('Droid settings sends both mode changes, replaces account facts, and preserves normal sign-in', async () => {
  const { store } = await import('../src/client/state.js');
  const { droidSettings } = await import('../src/client/ui/droid-settings.js');
  const sent: ClientMsg[] = [];
  const net = { send: (msg: ClientMsg) => sent.push(msg) } as unknown as Net;
  const state = emptySetupState();
  state.droid = { ...state.droid, path: '/opt/droid', version: '1.7.1', busy: null, signedIn: false };
  store.apply({ t: 'setup', state });
  const settings = droidSettings(net);
  const nodes = [settings.parts.desc, settings.parts.control, ...settings.parts.below] as unknown as Element[];
  const all = () => nodes.flatMap((n) => n.all());
  const mode = all().find((n) => n.tag === 'input' && n.attrs.type === 'checkbox')!;
  assert.ok(mode);
  assert.ok(all().some((n) => n.tag === 'button' && n.text() === 'Sign in'));
  mode.checked = true;
  mode.events.get('change')!();
  assert.deepEqual(sent.pop(), { t: 'setup.airgapped', on: true });
  store.apply({ t: 'setup', state: { ...state, airgapped: true, droid: { ...state.droid, signedIn: true, account: 'o***@example.com' } } });
  assert.equal(mode.checked, true);
  assert.match(nodes[0].text(), /airgapped · no Factory account/);
  assert.doesNotMatch(nodes[0].text(), /o\*\*\*/);
  assert.ok(!all().some((n) => n.tag === 'button' && n.text() === 'Sign in'));
  assert.match(nodes.map((n) => n.text()).join(' '), /not no outbound traffic/);
  mode.checked = false;
  mode.events.get('change')!();
  assert.deepEqual(sent.pop(), { t: 'setup.airgapped', on: false });
  store.apply({ t: 'setup', state });
  assert.ok(all().some((n) => n.tag === 'button' && n.text() === 'Sign in'));
  settings.dispose();
});
