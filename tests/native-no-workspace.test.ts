// No workspace in VR (the owner's decision): in the headset app no in-world trigger, event or server
// message opens a window or the workspace panel. The trigger does its job in the world or nothing
// (native/world-use.ts), and the page refuses every window at the root (ui/dom.ts setModalGate), so
// even code that still asks for one leaves the world untouched. Desktop and WebXR keep their windows.
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

test('behind the headset gate, a window never opens: nothing is added to the page and the world is not blocked', (t) => {
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

test('real window code behind the gate shows nothing: the hire form, a confirmation, the bar menu', (t) => {
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

test('without the gate (the desktop and WebXR), windows open as before', (t) => {
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

const ALLOWED = new Set<NativeUse['do']>(['none', 'hire-menu', 'laptop', 'wake', 'talk', 'card', 'note', 'tab', 'sit', 'stand', 'smoke', 'horn', 'proxy']);

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

test('every trigger on every thing in the world does its job in the world, or nothing', () => {
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
  assert.equal(nativeUse('desk', { ...empty, worker: busy }).do, 'laptop', 'the laptop takes your keyboard, no terminal window');
  assert.equal(nativeUse('desk', { ...empty, worker: { ...busy, asleep: true } }).do, 'wake');
  assert.equal(nativeUse('desk', { ...empty, worker: { ...busy, lost: true } }).do, 'none', 'no lost-worktree dialog');
  assert.equal(nativeUse('desk', { ...empty, room: true }).do, 'none', 'no meeting form');
  assert.equal(nativeUse('desk', { ...empty, carrying: true }).do, 'card', 'a card in hand hires for it, with no form');
  assert.equal(nativeUse('station', empty).do, 'talk', 'no ask form: the agent looks up and its screen takes your typing');
  for (const kind of ['elevator', 'pulls', 'queue', 'services', 'meeting', 'bar', 'tv', 'jukebox', 'bookshelf', 'decor', 'cabinet', 'golf', 'ball'] as const) {
    assert.equal(nativeUse(kind, empty).do, 'none', `${kind} opens no window`);
  }
  assert.equal(nativeUse('issues', empty).do, 'none', 'no issues kanban');
  assert.equal(nativeUse('issues', { ...empty, spot: 'ticket' }).do, 'none', 'no Jira ticket window');
  assert.equal(nativeUse('issues', { ...empty, spot: 'tab' }).do, 'tab');
  assert.equal(nativeUse('issues', { ...empty, note: true }).do, 'note');
  assert.equal(nativeUse('seat', { ...empty, seated: true }).do, 'stand', 'no bar menu or TV viewer from your seat');
});

// ---- main.ts runs them without the desktop dispatch ----

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

test('the headset app’s trigger never reaches the desktop dispatch or a window', () => {
  const use = body('nativeUseE');
  const calls = [...use.matchAll(/(?<![\w$.])([a-zA-Z]\w*)\(/g)].map((m) => m[1]);
  const windows = calls.filter((c) => /^(interact|use|open\w*|show\w*|ask\w*|watchShare|hireAtDesk|promptAtDesk|killWorker|fixLostWorktree|useSeat)$|Dialog$|Prompt$/.test(c));
  assert.deepEqual(windows, []);
  assert.match(use, /nativeMenus\?\.openHire\(it\.deskId\)/, 'its one menu is the hire menu at the desk');
  const vr = body('vrUseE');
  assert.ok(vr.indexOf('if (nativeMode) return nativeUseE(it, note, spot);') < vr.indexOf('if (vrUi) {'), 'native is answered before the WebXR panels');
  assert.ok(vr.indexOf('if (nativeMode) return nativeUseE(it, note, spot);') < vr.indexOf("use(it, 'E', note, spot);"), 'and before the desktop use()');
});

test('the headset app installs the paired-keyboard boundary, so no shortcut sees its keys', () => {
  assert.match(main, /captureVrKeys\(window, \{ active: \(\) => nativeControls\?\.active === true, onBytes: \(bytes, key\) => void typing\.key\(bytes, key\) \}\);/);
});
