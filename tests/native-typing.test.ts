// A keyboard paired to the headset types into the world (native/typing.ts): the laptop you aim at or
// stand at takes the keys and shows them on its own screen, a kiosk you are talking to shows what you
// type on its screen until Enter hands it over, and no key ever reaches an office shortcut.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KioskDraft, NativeTyping, type TypingTarget, type TypingWorld } from '../src/client/native/typing.js';
import { captureVrKeys, type KeyLike } from '../src/client/vr/physical-keys.js';
import { LINKED_FRAME, TERM_THEME, paintScreen } from '../src/client/world/laptop.js';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const laptop = (workerId: string): TypingTarget => ({ kind: 'laptop', workerId });

function typing(world: Partial<TypingWorld> = {}) {
  const sent: string[] = [];
  const links: string[] = [];
  const name = (t: TypingTarget | null) => (!t ? '-' : t.kind === 'laptop' ? t.workerId : `kiosk:${t.deskId}`);
  const state = { aimed: null as TypingTarget | null, talking: null as string | null, nearest: null as TypingTarget | null, near: new Set<string>() };
  const w: TypingWorld = {
    aimed: () => state.aimed,
    talking: () => state.talking,
    nearest: () => state.nearest,
    near: (t) => state.near.has(name(t)),
    ...world,
  };
  const t = new NativeTyping(w, {
    terminal: (id, bytes) => sent.push(`${id}<${JSON.stringify(bytes)}`),
    kiosk: (desk, _bytes, k) => sent.push(`kiosk:${desk}<${k.key}`),
    linked: (next, prev) => links.push(`${name(prev)}>${name(next)}`),
  });
  return { t, sent, links, state };
}

test('keys go to the laptop under the ray, then the kiosk you talk to, then the laptop you used, then the one you stand at', () => {
  const { t, sent, state } = typing();
  assert.equal(t.key('x', key('x')), false, 'nothing in the world to type into: the key is dropped');
  state.nearest = laptop('w-near');
  t.key('a', key('a'));
  state.near.add('w-near');
  state.nearest = laptop('w-other');
  t.key('b', key('b'));
  state.talking = 'kiosk-issues';
  t.key('c', key('c'));
  state.aimed = laptop('w-aimed');
  t.key('\r', key('Enter'));
  assert.deepEqual(sent, ['w-near<"a"', 'w-near<"b"', 'kiosk:kiosk-issues<c', 'w-aimed<"\\r"']);
});

test('the laptop that takes keys lights up until you walk away from it', () => {
  const { t, links, state } = typing();
  t.use(laptop('w1'));
  assert.deepEqual(links, ['->w1']);
  state.near.add('w1');
  t.update();
  assert.deepEqual(links, ['->w1'], 'still near it');
  state.near.clear();
  t.update();
  assert.deepEqual(links, ['->w1', 'w1>-']);
  state.aimed = laptop('w2');
  t.key('q', key('q'));
  state.aimed = laptop('w3');
  t.key('q', key('q'));
  t.clear();
  assert.deepEqual(links.slice(2), ['->w2', 'w2>w3', 'w3>-']);
});

test('a kiosk draft takes plain text, edits it, and hands it over on Enter', () => {
  const draft = new KioskDraft();
  const sent: string[] = [];
  const type = (k: KeyLike) => draft.key(k, (text) => sent.push(text));
  for (const c of 'file a bug') type(key(c));
  assert.equal(draft.value, 'file a bug');
  type(key('Backspace'));
  assert.equal(draft.value, 'file a bu');
  type(key('Backspace', { ctrlKey: true }));
  assert.equal(draft.value, 'file a ');
  assert.equal(type(key('c', { ctrlKey: true })), false, 'a chord types nothing');
  assert.equal(type(key('ArrowLeft')), false, 'nor does a named key');
  assert.equal(type(key('e', { metaKey: true })), false);
  type(key('@', { ctrlKey: true, altKey: true, altGraph: true }));
  assert.equal(draft.value, 'file a @', 'AltGr types its character');
  type(key('Escape'));
  assert.equal(draft.value, '');
  assert.equal(type(key('Enter')), false, 'an empty draft sends nothing');
  for (const c of '  queue the bugs  ') type(key(c));
  type(key('Enter'));
  assert.deepEqual(sent, ['queue the bugs']);
  assert.equal(draft.value, '');
});

test('while the headset app is active, no key event reaches the office shortcuts', () => {
  const target = new EventTarget();
  let active = true;
  const bytes: string[] = [];
  const shortcuts: string[] = [];
  captureVrKeys(target, { active: () => active, onBytes: (b) => bytes.push(b) });
  target.addEventListener('keydown', (e) => shortcuts.push((e as KeyboardEvent).key));
  const press = (k: string) => {
    const e = new Event('keydown', { cancelable: true }) as Event & KeyLike & { getModifierState: () => boolean };
    Object.assign(e, { ...key(k), getModifierState: () => false });
    target.dispatchEvent(e);
  };
  for (const k of ['t', 'Tab', '/', 'h', 'e']) press(k);
  assert.deepEqual(shortcuts, [], 'T, Tab, /, H and E open nothing');
  assert.deepEqual(bytes, ['t', '\t', '/', 'h', 'e']);
  active = false;
  press('t');
  assert.deepEqual(shortcuts, ['t'], 'the desktop keeps its shortcuts');
});

test('a linked laptop screen lights its frame and shows the cursor', () => {
  const calls: { op: string; style?: unknown }[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, k) => {
      if (k in target) return target[k as string];
      if (k === 'measureText') return (s: string) => ({ width: s.length * 10 });
      return (..._args: unknown[]) => calls.push({ op: String(k), style: k === 'strokeRect' ? target.strokeStyle : k === 'fillRect' ? target.fillStyle : undefined });
    },
    set: (target, k, v) => {
      target[k as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const screen = { cols: 20, rows: 4, lines: [[['$ ls', -1, -1, 0]], [], [], []] as never, cursor: [4, 0] as [number, number], version: 1 };
  paintScreen(ctx, 400, 200, screen, undefined, 0, false);
  assert.ok(!calls.some((c) => c.op === 'strokeRect'), 'the desktop and unlinked laptops paint as before');
  calls.length = 0;
  paintScreen(ctx, 400, 200, screen, undefined, 0, true);
  assert.ok(
    calls.some((c) => c.op === 'strokeRect' && c.style === LINKED_FRAME),
    'the frame lights',
  );
  assert.ok(
    calls.some((c) => c.op === 'fillRect' && c.style === TERM_THEME.cursor),
    'the cursor shows where keys land',
  );
});
