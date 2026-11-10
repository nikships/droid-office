import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {
  children: (FakeNode | string)[] = [];
  attrs: Record<string, string> = {};
  className = '';
  constructor(readonly tag: string) {}
  append(...nodes: (FakeNode | string)[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeNode | string | null)[]) {
    this.children = nodes.filter((n): n is FakeNode | string => n !== null);
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener() {}
}

function marks(node: FakeNode | string): string[] {
  if (typeof node === 'string') return [];
  const own = node.tag === 'img' && node.attrs.src?.startsWith('/icons/models/') ? [node.attrs.src] : [];
  return [...own, ...node.children.flatMap(marks)];
}

const g = globalThis as unknown as Record<string, unknown>;
g.Node = FakeNode;
g.document = { createElement: (tag: string) => new FakeNode(tag) };
g.localStorage = { getItem: () => null, setItem() {} };

// The owner's Droid catalogue lists the model with its provider (trimmed from /api/agents/droid/models).
const catalogue = { models: [{ id: 'custom:droidproxy:opaque-5-2', displayName: 'DroidProxy: Opaque 5.2', custom: true, provider: 'anthropic' }] };
let requests = 0;
let release: () => void = () => undefined;
const loaded = new Promise<void>((resolve) => {
  release = resolve;
});
g.fetch = async () => {
  requests++;
  await loaded;
  return { ok: true, json: async () => catalogue };
};

test('a badge built before the catalogue loads shows the provider mark once it arrives', async () => {
  const { modelBadgeNode } = await import('../src/client/ui/models.js');
  const badge = modelBadgeNode('custom:droidproxy:opaque-5-2', undefined) as unknown as FakeNode;
  assert.deepEqual(marks(badge), [], 'no family in the id and no provider yet: the placeholder, not a mark');
  assert.equal(requests, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(marks(badge), ['/icons/models/claude-color.svg']);
});
