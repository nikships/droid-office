import assert from 'node:assert/strict';
import test from 'node:test';
import { toast } from '../src/client/ui/dom.js';

test('companion notifications replace each other without old timers removing the latest', (t) => {
  class Element {
    className = '';
    title = '';
    style = { transition: '', opacity: '' };
    children: (Element | string)[] = [];
    parent?: Element;
    append(child: Element | string) {
      this.children.push(child);
      if (child instanceof Element) child.parent = this;
    }
    replaceChildren(child: Element) {
      for (const old of this.children) if (old instanceof Element) old.parent = undefined;
      this.children = [];
      this.append(child);
    }
    hasAttribute(name: string) {
      return name === 'data-single';
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    }
  }
  const root = new Element();
  const timers: (() => void)[] = [];
  t.mock.method(globalThis, 'setTimeout', ((fn: () => void) => {
    timers.push(fn);
    return 0;
  }) as typeof setTimeout);
  const node = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: Element });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element(), getElementById: () => root } });
  t.after(() => {
    if (node) Object.defineProperty(globalThis, 'Node', node);
    else Reflect.deleteProperty(globalThis, 'Node');
    if (document) Object.defineProperty(globalThis, 'document', document);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const first = toast('First') as unknown as Element;
  const second = toast('Second', 'warn') as unknown as Element;
  assert.deepEqual(root.children, [second]);
  assert.equal(second.title, 'Second');
  assert.match(second.className, /warn/);
  timers[0]();
  timers[2]();
  assert.deepEqual(root.children, [second]);
  timers[1]();
  assert.deepEqual(root.children, [second]);
  timers[3]();
  assert.deepEqual(root.children, []);
  assert.equal(first.style.opacity, '0');
});
