import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { claimEscape, closeAllModals, modalOpen, openModal } from '../src/client/ui/dom.js';
import { promptExtras } from '../src/client/ui/prompt-box.js';

// The least DOM that dom.ts and prompt-box.ts touch, with the one rule that matters here: a
// listener on the same target runs even after another called stopPropagation.
type Handler = (e: FakeEvent) => void;

interface FakeEvent {
  key: string;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

class FakeTarget {
  listeners: { type: string; fn: Handler; capture: boolean }[] = [];
  addEventListener(type: string, fn: Handler, capture: boolean | { capture?: boolean } = false) {
    this.listeners.push({ type, fn, capture: typeof capture === 'object' ? !!capture.capture : capture });
  }
  removeEventListener(type: string, fn: Handler, capture: boolean | { capture?: boolean } = false) {
    const cap = typeof capture === 'object' ? !!capture.capture : capture;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === cap));
  }
  /** Capture listeners in registration order, the way the browser runs them on `window`. */
  press(key: string, target: unknown = this): FakeEvent {
    let immediate = false;
    const e: FakeEvent = {
      key,
      target,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {
        immediate = true;
      },
    };
    for (const l of [...this.listeners]) {
      if (l.type !== 'keydown' || !l.capture) continue;
      l.fn(e);
      if (immediate) break;
    }
    return e;
  }
}

class FakeNode extends FakeTarget {
  className = '';
  parentNode: FakeNode | null = null;
  children: (FakeNode | string)[] = [];
  attrs = new Map<string, string>();
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  constructor(
    readonly tag: string,
    readonly doc?: FakeDocument,
  ) {
    super();
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c: string[]) => void (this.className = [...new Set([...names(), ...c])].join(' ')),
      remove: (...c: string[]) =>
        void (this.className = names()
          .filter((n) => !c.includes(n))
          .join(' ')),
      contains: (c: string) => names().includes(c),
      toggle(c: string, force?: boolean) {
        const on = force ?? !names().includes(c);
        if (on) this.add(c);
        else this.remove(c);
      },
    };
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n?.parentNode) n = n.parentNode;
    return n === fakeDocument.body;
  }
  append(...nodes: (FakeNode | string)[]) {
    for (const n of nodes) {
      if (typeof n !== 'string') {
        n.remove();
        n.parentNode = this;
      }
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: (FakeNode | string)[]) {
    for (const c of this.children) if (typeof c !== 'string') c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  contains(other: unknown): boolean {
    for (let n = other as FakeNode | null; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  querySelector(selector: string): FakeNode | null {
    if (!selector.startsWith('.')) return null;
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (c.classList.contains(selector.slice(1))) return c;
      const deep = c.querySelector(selector);
      if (deep) return deep;
    }
    return null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  toggleAttribute(k: string, on?: boolean) {
    if (on ?? !this.attrs.has(k)) this.attrs.set(k, '');
    else this.attrs.delete(k);
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  setSelectionRange(a: number, b: number) {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  click() {
    for (const l of this.listeners) if (l.type === 'click') l.fn({ target: this } as FakeEvent);
  }
}

class FakeDocument extends FakeTarget {
  body = new FakeNode('body', this);
  activeElement: FakeNode | null = null;
  createElement(tag: string) {
    return new FakeNode(tag, this);
  }
  getElementById(id: string) {
    return id === 'modal-root' ? modalRoot : null;
  }
}

const fakeDocument = new FakeDocument();
const fakeWindow = new FakeTarget();
const modalRoot = new FakeNode('div', fakeDocument);

function fakeBrowser(t: TestContext) {
  const storage = new Map<string, string>();
  // Hooks run in the order they were added, so this one still has the stubbed window to remove listeners from.
  t.after(() => {
    closeAllModals();
    fakeDocument.activeElement = null;
  });
  const stubs: Record<string, unknown> = {
    window: fakeWindow,
    document: fakeDocument,
    Node: FakeNode,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) },
  };
  for (const [key, value] of Object.entries(stubs)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  fakeDocument.body.children = [];
  fakeDocument.body.append(modalRoot);
  fakeDocument.listeners = [];
  fakeWindow.listeners = [];
  return { storage };
}

const keydownListeners = () => fakeWindow.listeners.filter((l) => l.type === 'keydown').length;
const clickable = (root: FakeNode, label: string) => {
  const find = (n: FakeNode): FakeNode | null => {
    if (n.getAttribute('aria-label') === label) return n;
    for (const c of n.children)
      if (typeof c !== 'string') {
        const hit = find(c);
        if (hit) return hit;
      }
    return null;
  };
  const hit = find(root);
  assert.ok(hit, label);
  return hit;
};

interface Box {
  ta: FakeNode;
  extras: ReturnType<typeof promptExtras>;
  form: FakeNode;
  history: FakeNode;
  panelHidden(): boolean;
}

/** A prompt dialog the way prompt.ts builds it: the box first, then the window around it, or the other way round. */
function openPrompt(order: 'box-first' | 'modal-first', onClose?: () => void): Box & { modal: ReturnType<typeof openModal> } {
  const ta = fakeDocument.createElement('textarea');
  ta.setAttribute('aria-label', 'Prompt');
  const form = fakeDocument.createElement('form');
  let extras!: ReturnType<typeof promptExtras>;
  let modal!: ReturnType<typeof openModal>;
  const open = () => {
    modal = openModal(form as unknown as HTMLElement, {
      onClose: () => {
        extras.dispose();
        onClose?.();
      },
    });
  };
  if (order === 'box-first') {
    extras = promptExtras(ta as unknown as HTMLTextAreaElement);
    form.append(extras.element as unknown as FakeNode);
    open();
  } else {
    // The window is already registered when the box's own handler would have been added.
    const placeholder = fakeDocument.createElement('div');
    form.append(placeholder);
    extras = { dispose() {} } as ReturnType<typeof promptExtras>;
    open();
    extras = promptExtras(ta as unknown as HTMLTextAreaElement);
    placeholder.remove();
    form.append(extras.element as unknown as FakeNode);
  }
  const history = clickable(form, 'Prompt history');
  const panel = (extras.element as unknown as FakeNode).children.find((c) => typeof c !== 'string' && c.classList.contains('prompt-history')) as FakeNode;
  return { ta, extras, form, history, modal, panelHidden: () => panel.classList.contains('hidden') };
}

for (const order of ['box-first', 'modal-first'] as const) {
  test(`Esc closes only the open History list and keeps the draft (${order})`, (t) => {
    fakeBrowser(t);
    const box = openPrompt(order);
    box.ta.value = 'UNSENT DRAFT';
    box.history.click();
    assert.equal(box.panelHidden(), false);
    assert.equal(box.history.getAttribute('aria-expanded'), 'true');

    const first = fakeWindow.press('Escape', box.history);
    assert.equal(first.defaultPrevented, true);
    assert.equal(box.panelHidden(), true);
    assert.equal(box.history.getAttribute('aria-expanded'), 'false');
    assert.equal(modalOpen(), true, 'the dialog stays open');
    assert.equal(box.form.isConnected, true);
    assert.equal(box.ta.value, 'UNSENT DRAFT');
    assert.equal(fakeDocument.activeElement, box.ta, 'focus goes back to the box');

    fakeWindow.press('Escape', box.ta);
    assert.equal(modalOpen(), false, 'the next Esc closes the dialog');
  });

  test(`Esc with the History list empty closes only the list (${order})`, (t) => {
    fakeBrowser(t);
    const box = openPrompt(order);
    box.history.click();
    assert.equal(box.panelHidden(), false);
    fakeWindow.press('Escape');
    assert.equal(box.panelHidden(), true);
    assert.equal(modalOpen(), true);
    fakeWindow.press('Escape');
    assert.equal(modalOpen(), false);
  });
}

test('Esc with no list open closes the dialog as before, and it still lets go of every listener', (t) => {
  fakeBrowser(t);
  let closed = 0;
  const box = openPrompt('box-first', () => closed++);
  box.ta.value = 'draft';
  const e = fakeWindow.press('Escape', box.ta);
  assert.equal(e.defaultPrevented, true);
  assert.equal(modalOpen(), false);
  assert.equal(closed, 1);
  assert.equal(keydownListeners(), 0);
  assert.equal(fakeDocument.listeners.length, 0);
  // Esc after the dialog went away is nobody's.
  assert.equal(fakeWindow.press('Escape').defaultPrevented, false);
});

test('picking a prompt from History closes the list and Esc then closes the dialog', (t) => {
  const { storage } = fakeBrowser(t);
  storage.set('droid-office.prompt-history', JSON.stringify(['earlier prompt']));
  const box = openPrompt('box-first');
  box.ta.value = 'draft';
  box.history.click();
  const panel = (box.extras.element as unknown as FakeNode).children.find((c) => typeof c !== 'string' && c.classList.contains('prompt-history')) as FakeNode;
  const row = (panel.children[0] as FakeNode).children[0] as FakeNode;
  assert.equal(row.getAttribute('role'), 'option');
  row.click();
  assert.equal(box.ta.value, 'earlier prompt');
  assert.equal(box.panelHidden(), true);
  fakeWindow.press('Escape');
  assert.equal(modalOpen(), false);
});

test('old saved presets do not add chips to the prompt box', (t) => {
  const { storage } = fakeBrowser(t);
  storage.set('droid-office.settings', JSON.stringify({ presets: [{ label: 'Review', text: 'Review this.' }] }));
  const box = openPrompt('box-first');
  assert.equal(box.form.querySelector('.prompt-presets'), null);
  assert.equal(box.form.querySelector('.chip'), null);
  box.history.click();
  assert.equal(box.panelHidden(), false, 'prompt history still opens');
});

test('a popup inside a lower window does not take the Esc meant for the one on top', (t) => {
  fakeBrowser(t);
  const lower = openPrompt('box-first');
  lower.history.click();
  const upper = fakeDocument.createElement('div');
  openModal(upper as unknown as HTMLElement);
  fakeWindow.press('Escape');
  assert.equal(lower.panelHidden(), false, 'the list under the top window is left alone');
  assert.equal(modalOpen(), true, 'only the top window closed');
  fakeWindow.press('Escape');
  assert.equal(lower.panelHidden(), true);
  assert.equal(modalOpen(), true);
});

test('the newest claim wins, a claim that declines passes Esc on, and a withdrawn claim is gone', (t) => {
  fakeBrowser(t);
  const content = fakeDocument.createElement('div');
  const owner = fakeDocument.createElement('span');
  content.append(owner);
  openModal(content as unknown as HTMLElement);
  const calls: string[] = [];
  const releaseOlder = claimEscape(owner as unknown as HTMLElement, () => (calls.push('older'), true));
  const releaseNewer = claimEscape(owner as unknown as HTMLElement, () => (calls.push('newer'), false));
  fakeWindow.press('Escape');
  assert.deepEqual(calls, ['newer', 'older']);
  assert.equal(modalOpen(), true);
  releaseOlder();
  releaseNewer();
  calls.length = 0;
  fakeWindow.press('Escape');
  assert.deepEqual(calls, []);
  assert.equal(modalOpen(), false);
});
