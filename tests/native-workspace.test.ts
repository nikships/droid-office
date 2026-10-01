// Native physical actions stay in the world; shared office windows and terminals remain available
// on the headset's compositor workspace. Graphics settings are owned by the APK, not these windows.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modalOpen, openModal, refusedModals, setModalGate } from '../src/client/ui/dom.js';
import { openBar } from '../src/client/ui/bar.js';
import { confirmDialog, openPrompt } from '../src/client/ui/prompt.js';
import { INTERACT_KINDS, nativeUse, type NativeUse, type NativeUseContext } from '../src/client/native/world-use.js';

/** Callable, and every member is itself: stands in for whatever a window's code reaches for. */
const anything: unknown = new Proxy(() => {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : anything), apply: () => anything, set: () => true });

/** A page whose elements accept anything, and which records every lookup by id (the modal root among them). */
function page(t: TestContext) {
  class FakeNode {}
  const lookups: string[] = [];
  const element = () => new Proxy(new FakeNode(), { get: (target, key) => Reflect.get(target, key) ?? anything, set: () => true });
  const doc = { createElement: element, getElementById: (id: string) => (lookups.push(id), element()), body: element(), documentElement: element(), addEventListener() {}, querySelector: () => null };
  for (const [name, value] of [
    ['document', doc],
    ['Node', FakeNode],
    ['window', Object.assign(new EventTarget(), { devicePixelRatio: 1 })],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
  }
  t.after(() => setModalGate(null));
  return lookups;
}

test('an explicit modal gate still refuses a window without blocking the world', (t) => {
  const lookups = page(t);
  setModalGate(() => false);
  const before = refusedModals();
  let closed = 0;
  const modal = openModal(document.createElement('div'), { onClose: () => closed++ });
  assert.equal(modalOpen(), false, 'nothing is open, so nothing holds the world still');
  assert.equal(refusedModals(), before + 1);
  assert.deepEqual(lookups, [], 'the modal root is never touched');
  assert.equal(closed, 0, 'a refused window does not close on its own: its caller decides');
  modal.close();
  modal.close();
  assert.equal(closed, 1, 'closing it runs its close once, as for a real one');
});

test('real windows honor an explicit modal gate without confirming actions', (t) => {
  const lookups = page(t);
  setModalGate(() => false);
  const before = refusedModals();
  openPrompt({ title: '✨ Hire a worker at Desk 7', allowEmpty: true, onSubmit() {} });
  confirmDialog('Send Pixel home?', 'Pixel leaves the meeting room.', 'Send home', () => assert.fail('nothing is confirmed by itself'));
  openBar({ cutOff: false, order: () => assert.fail('nothing is ordered by itself') });
  assert.equal(modalOpen(), false);
  assert.equal(refusedModals(), before + 3);
  assert.ok(!lookups.includes('modal-root'));
});

test('without a modal gate, shared office windows open and close normally', (t) => {
  page(t);
  setModalGate(null);
  const before = refusedModals();
  const modal = openModal(document.createElement('div'));
  assert.equal(modalOpen(), true);
  modal.close();
  assert.equal(modalOpen(), false);
  assert.equal(refusedModals(), before);
});

// ---- Every in-world trigger ----

const ALLOWED = new Set<NativeUse['do']>(['none', 'hire-menu', 'terminal', 'workspace', 'talk', 'card', 'note', 'tab', 'sit', 'stand', 'smoke', 'horn', 'proxy']);

function* contexts(): Generator<NativeUseContext> {
  const workers: NativeUseContext['worker'][] = [null, { asleep: false, lost: false, downed: false }, { asleep: true, lost: false, downed: false }, { asleep: false, lost: true, downed: false }, { asleep: false, lost: false, downed: true }];
  for (const carrying of [false, true])
    for (const worker of workers)
      for (const room of [false, true]) for (const note of [false, true]) for (const spot of [null, 'tab', 'ticket'] as const) for (const seated of [false, true]) yield { carrying, worker, room, note, spot, seated };
}

test('the list of things in the world is complete', () => {
  const office = readFileSync(new URL('../src/client/world/office.ts', import.meta.url), 'utf8');
  const union = office.slice(office.indexOf('export type InteractKind ='), office.indexOf(';', office.indexOf('export type InteractKind =')));
  const kinds = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...INTERACT_KINDS].sort(), kinds.sort());
});

test('native triggers retain physical actions and open shared office windows where appropriate', () => {
  for (const kind of INTERACT_KINDS) {
    for (const c of contexts()) {
      const use = nativeUse(kind, c);
      assert.ok(ALLOWED.has(use.do), `${kind} ${JSON.stringify(c)} -> ${use.do}`);
      // The one menu a trigger opens: the hire menu, at an empty desk, with empty hands.
      if (use.do === 'hire-menu') assert.ok(kind === 'desk' && !c.worker && !c.room && !c.carrying, `${kind} ${JSON.stringify(c)}`);
      if (c.worker?.downed && (kind === 'desk' || kind === 'station')) assert.equal(use.do, 'none', 'a shot worker’s desk is dealt with at the body');
    }
  }
  const empty: NativeUseContext = { carrying: false, worker: null, room: false, note: false, spot: null, seated: false };
  const busy = { asleep: false, lost: false, downed: false };
  assert.equal(nativeUse('desk', empty).do, 'hire-menu');
  assert.equal(nativeUse('desk', { ...empty, worker: busy }).do, 'terminal', 'an occupied desk opens its real shared terminal');
  assert.equal(nativeUse('desk', { ...empty, worker: { ...busy, asleep: true } }).do, 'terminal', 'opening the shared terminal wakes the worker');
  assert.equal(nativeUse('desk', { ...empty, worker: { ...busy, lost: true } }).do, 'terminal', 'the shared terminal action includes worktree recovery');
  assert.equal(nativeUse('desk', { ...empty, room: true }).do, 'workspace', 'the meeting form is available');
  assert.equal(nativeUse('desk', { ...empty, carrying: true }).do, 'card', 'a card in hand hires for it, with no form');
  assert.equal(nativeUse('station', empty).do, 'talk', 'no ask form: the agent looks up and its screen takes your typing');
  for (const kind of ['elevator', 'pulls', 'queue', 'services', 'meeting', 'bar', 'tv', 'jukebox', 'bookshelf', 'decor'] as const) {
    assert.equal(nativeUse(kind, empty).do, 'workspace', `${kind} retains its office window`);
  }
  for (const kind of ['cabinet', 'golf', 'ball'] as const) assert.equal(nativeUse(kind, empty).do, 'none', `${kind} still needs headset-specific game controls`);
  assert.equal(nativeUse('issues', empty).do, 'workspace', 'the issues kanban is available');
  assert.equal(nativeUse('issues', { ...empty, spot: 'ticket' }).do, 'workspace', 'Jira tickets use the shared reader');
  assert.equal(nativeUse('issues', { ...empty, spot: 'tab' }).do, 'tab');
  assert.equal(nativeUse('issues', { ...empty, note: true }).do, 'note');
  assert.equal(nativeUse('seat', { ...empty, seated: true }).do, 'stand', 'no bar menu or TV viewer from your seat');
});

// ---- Shared terminal/window dispatch and keyboard ownership ----

const main = readFileSync(new URL('../src/client/main.ts', import.meta.url), 'utf8');

/** The body of `function name(` in main.ts, up to its closing brace. */
function body(name: string): string {
  const at = main.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  let depth = 0;
  for (let i = main.indexOf('{', main.indexOf(')', at)); i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) return main.slice(at, i + 1);
  }
  return assert.fail(`unterminated ${name}`);
}

test('native desks open the shared terminal and office windows use the shared dispatch', () => {
  const use = body('nativeUseE');
  assert.match(use, /case 'terminal':[\s\S]*openWorkerTerminal\(w\.id\)/);
  assert.match(use, /case 'workspace':[\s\S]*use\(it, 'E', note, spot\)/);
  assert.match(use, /nativeMenus\?\.openHire\(it\.deskId\)/, 'its one menu is the hire menu at the desk');
  const vr = body('vrUseE');
  assert.ok(vr.indexOf('if (nativeMode) return nativeUseE(it, note, spot);') < vr.indexOf('if (vrUi) {'), 'native is answered before the WebXR panels');
  assert.ok(vr.indexOf('if (nativeMode) return nativeUseE(it, note, spot);') < vr.indexOf("use(it, 'E', note, spot);"), 'and before the desktop use()');
});

test('visible workspace terminals and fields get their keys instead of the world laptop', () => {
  assert.match(main, /captureVrKeys\(window, \{ active: \(\) => nativeControls\?\.active === true && !nativeUi\?\.blocked\(\)/);
  assert.match(main, /panelOpen: \(\) => nativeUi\?\.blocked\(\) === true/);
  assert.match(main, /back: \(\) => nativeUi\?\.back\(\)/);
});
