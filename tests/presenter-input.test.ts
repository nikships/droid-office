import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextMenu, type EditTarget, editMenu } from '../src/desktop/edit-menu.ts';
import { BINDING_NAME } from '../src/desktop/input-bridge.ts';
import { nativeCursor } from '../src/desktop/input-cursor.ts';
import { BUTTON, MOD, type NativeEvent } from '../src/desktop/input-events.ts';
import { type InputNative, type InputPage, PresenterInput } from '../src/desktop/presenter-input.ts';

const ORIGIN = 'http://localhost:4600';

function setup(opts: { rawMouse?: boolean; focused?: boolean } = {}) {
  const sent: unknown[] = [];
  const commands: { method: string; params: any }[] = [];
  const native: string[] = [];
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  const debuggerListeners = new Map<string, ((...args: any[]) => void)[]>();
  let attached = false;
  const page: InputPage = {
    sendInputEvent: (e) => void sent.push(e),
    focus: () => void native.push('page.focus'),
    getURL: () => `${ORIGIN}/`,
    debugger: {
      attach: () => void (attached = true),
      detach: () => void (attached = false),
      isAttached: () => attached,
      sendCommand: async (method: string, params?: object) => {
        commands.push({ method, params });
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN' } } };
        return {};
      },
      on: (event: string, l: (...args: any[]) => void) => void debuggerListeners.set(event, [...(debuggerListeners.get(event) ?? []), l]),
    } as InputPage['debugger'],
    on: (event, l) => void listeners.set(event, [...(listeners.get(event) ?? []), l]),
    once: (event, l) => void listeners.set(event, [...(listeners.get(event) ?? []), l]),
  };
  const nativeApi: InputNative = {
    inputCapture: (on, raw) => (native.push(`capture ${on} ${raw ?? false}`), !!raw),
    inputCapabilities: () => ({ rawMouse: opts.rawMouse ?? true }),
    inputSetCursor: (name) => void native.push(`cursor ${name}`),
    inputSetCursorImage: () => void native.push('cursorImage'),
    inputSetTextInput: (on) => void native.push(`text ${on}`),
    inputSetImeRect: (x, y, w, h) => void native.push(`ime ${x},${y},${w},${h}`),
    inputFocus: () => void native.push('focus'),
  };
  const input = new PresenterInput({ page, native: nativeApi, shimSource: '/*shim*/', officeOrigin: () => ORIGIN, focused: () => opts.focused ?? true });
  const emitPage = (event: string, ...args: any[]) => (listeners.get(event) ?? []).forEach((l) => l(...args));
  const emitDebugger = (...args: any[]) => (debuggerListeners.get('message') ?? []).forEach((l) => l(...args));
  const flush = () => new Promise((r) => setImmediate(r));
  const host = (message: object, contextId = 7) => emitDebugger({}, 'Runtime.bindingCalled', { name: BINDING_NAME, payload: JSON.stringify(message), executionContextId: contextId });
  const trust = () => {
    emitDebugger({}, 'Page.frameNavigated', { frame: { id: 'MAIN' } });
    emitDebugger({}, 'Runtime.executionContextCreated', { context: { id: 7, origin: ORIGIN, auxData: { frameId: 'MAIN', isDefault: true } } });
  };
  const evaluated = () => commands.filter((c) => c.method === 'Runtime.evaluate').map((c) => c.params.expression as string);
  return { input, sent, commands, native, emitPage, emitDebugger, flush, host, trust, evaluated };
}

const mouse = (kind: 'down' | 'up' | 'move' | 'enter' | 'leave', x: number, y: number, extra: Partial<Extract<NativeEvent, { type: 'mouse' }>> = {}): NativeEvent => ({
  type: 'mouse',
  kind,
  button: 0,
  buttons: 0,
  x,
  y,
  clickCount: kind === 'down' || kind === 'up' ? 1 : 0,
  mods: 0,
  ...extra,
});

test('attaching installs the channel and the script, in that order, once the page has loaded', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  assert.deepEqual(
    t.commands.map((c) => c.method),
    ['Runtime.enable', 'Page.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument', 'Page.getFrameTree', 'Emulation.setFocusEmulationEnabled'],
  );
  assert.deepEqual(t.commands[2]!.params, { name: BINDING_NAME });
  assert.equal(t.commands[3]!.params.source, '/*shim*/');
  assert.equal(t.commands[3]!.params.runImmediately, true);
  assert.deepEqual(t.commands[5]!.params, { enabled: true });
  // A second load does not attach twice.
  t.emitPage('did-finish-load');
  await t.flush();
  assert.equal(t.commands.length, 6);
});

test('mouse moves and clicks reach the page where the cursor is, with its buttons', async () => {
  const t = setup();
  t.input.handle(mouse('move', 120, 80));
  t.input.handle(mouse('down', 120, 80, { buttons: BUTTON.left, mods: MOD.shift }));
  t.input.handle(mouse('up', 120, 80, { button: 1, buttons: BUTTON.right }));
  assert.deepEqual(
    t.sent.map((e: any) => [e.type, e.x, e.y, e.button, e.clickCount]),
    [
      ['mouseMove', 120, 80, undefined, undefined],
      ['mouseDown', 120, 80, 'left', 1],
      ['mouseUp', 120, 80, 'right', 1],
    ],
  );
  assert.deepEqual((t.sent[1] as any).modifiers, ['shift', 'leftbuttondown']);
  assert.deepEqual((t.sent[2] as any).modifiers, []);
});

test('the wheel goes to the page at the pointer', () => {
  const t = setup();
  t.input.handle({ type: 'scroll', x: 30, y: 40, dx: 0, dy: -1, precise: false, mods: 0 });
  const e = t.sent[0] as any;
  assert.deepEqual([e.type, e.x, e.y, e.deltaY], ['mouseWheel', 30, 40, -40]);
});

test('a click on the scene captures the mouse: the request is granted, the cursor stays, and deltas move the virtual screen position', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  t.trust();
  t.input.handle(mouse('move', 300, 200));
  t.host({ t: 'lock', id: 5, raw: true, activation: true });
  assert.ok(t.native.includes('capture true true'));
  await t.flush();
  assert.ok(t.evaluated().some((e) => e.includes('granted(5, true)')));
  assert.equal(t.input.captured, true);
  t.sent.length = 0;
  t.input.handle({ type: 'delta', dx: 10, dy: -5, raw: true, buttons: 0, mods: 0 });
  t.input.handle({ type: 'delta', dx: -300, dy: 40, raw: true, buttons: 0, mods: 0 });
  assert.deepEqual(
    t.sent.map((e: any) => [e.x, e.y, e.globalX, e.globalY]),
    [
      [300, 200, 310, 195],
      [300, 200, 10, 235],
    ],
  );
  // A click while captured lands where the cursor froze, not where the page-space position drifted to.
  t.input.handle(mouse('down', 999, 999, { buttons: BUTTON.left }));
  assert.deepEqual([(t.sent[2] as any).x, (t.sent[2] as any).y], [300, 200]);
});

test('input from an iframe or another origin cannot take the mouse', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  t.emitDebugger({}, 'Page.frameNavigated', { frame: { id: 'MAIN' } });
  t.emitDebugger({}, 'Runtime.executionContextCreated', { context: { id: 9, origin: 'https://evil.example', auxData: { frameId: 'MAIN', isDefault: true } } });
  t.emitDebugger({}, 'Runtime.executionContextCreated', { context: { id: 10, origin: ORIGIN, auxData: { frameId: 'CHILD', isDefault: true } } });
  t.host({ t: 'lock', id: 1, raw: false, activation: true }, 9);
  t.host({ t: 'lock', id: 2, raw: false, activation: true }, 10);
  t.host({ t: 'lock', id: 3, raw: false, activation: true }, 404);
  await t.flush();
  assert.equal(t.input.captured, false);
  assert.ok(!t.native.some((n) => n.startsWith('capture true')));
  assert.deepEqual(t.evaluated(), []);
});

test('a request without a click behind it is refused, and where raw input is not there it is refused as unsupported', async () => {
  const t = setup({ rawMouse: false });
  t.emitPage('did-finish-load');
  await t.flush();
  t.trust();
  t.host({ t: 'lock', id: 1, raw: false, activation: false });
  t.host({ t: 'lock', id: 2, raw: true, activation: true });
  await t.flush();
  assert.ok(t.evaluated()[0]!.includes('denied(1, "NotAllowedError")'));
  assert.ok(t.evaluated()[1]!.includes('denied(2, "NotSupportedError")'));
  assert.equal(t.input.captured, false);
});

test('Esc gives the mouse back, with the page told and the cursor resynced', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  t.trust();
  t.input.handle(mouse('move', 50, 60));
  t.host({ t: 'lock', id: 1, raw: false, activation: true });
  await t.flush();
  t.input.handle({ type: 'delta', dx: 100, dy: 0, raw: false, buttons: 0, mods: 0 });
  t.sent.length = 0;
  t.native.length = 0;
  t.input.handle({ type: 'key', kind: 'down', keyCode: 0x35, chars: '\u001b', base: '\u001b', mods: 0, repeat: false, handled: false, commands: [] });
  assert.equal(t.input.captured, false);
  assert.deepEqual(t.native, ['capture false false', 'cursor arrow']);
  await t.flush();
  assert.ok(t.evaluated().some((e) => e.includes('revoked()')));
  // One move puts the page's idea of the pointer back at the cursor, so the next real move is small.
  assert.deepEqual((t.sent[0] as any).type, 'mouseMove');
  assert.deepEqual([(t.sent[0] as any).x, (t.sent[0] as any).globalX, (t.sent[0] as any).globalY], [50, 50, 60]);
  // The key still reaches the page.
  assert.ok(t.commands.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'Escape'));
});

test('the page letting go, a reload and losing focus all end the capture', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  t.trust();
  const take = async () => {
    t.host({ t: 'lock', id: 1, raw: false, activation: true });
    await t.flush();
    assert.equal(t.input.captured, true);
  };
  await take();
  t.host({ t: 'exit' });
  assert.equal(t.input.captured, false);
  await take();
  t.emitPage('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(t.input.captured, false);
  await take();
  t.input.handle({ type: 'focus', focused: false });
  assert.equal(t.input.captured, false);
  assert.deepEqual(t.commands.at(-1)!.params, { enabled: false });
  // A navigation inside the page, or in a frame, leaves it alone.
  await take();
  t.emitPage('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  t.emitPage('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  assert.equal(t.input.captured, true);
});

test('keys, modifiers and text-input composition go to the page in order', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  t.commands.length = 0;
  t.input.handle({ type: 'flags', keyCode: 0x38, mods: MOD.shift });
  t.input.handle({ type: 'key', kind: 'down', keyCode: 0x00, chars: 'A', base: 'A', mods: MOD.shift, repeat: false, handled: false, commands: [] });
  t.input.handle({ type: 'compose', text: 'に', selStart: 1, selEnd: 1 });
  t.input.handle({ type: 'commit', text: '日本' });
  t.input.handle({ type: 'composeEnd' });
  await t.flush();
  assert.deepEqual(
    t.commands.map((c) => [c.method, c.params.type ?? c.params.text]),
    [
      ['Input.dispatchKeyEvent', 'rawKeyDown'],
      ['Input.dispatchKeyEvent', 'keyDown'],
      ['Input.imeSetComposition', 'に'],
      ['Input.insertText', '日本'],
      ['Input.imeSetComposition', ''],
    ],
  );
  assert.equal(t.commands[1]!.params.text, 'A');
  assert.equal(t.commands[1]!.params.modifiers, 8);
});

test('a text field taking focus turns the input method on and tells it where the caret is', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  t.trust();
  t.host({ t: 'editable', on: true, x: 10, y: 20, w: 200, h: 18 });
  t.host({ t: 'editable', on: false, x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(t.native, ['text true', 'ime 10,20,200,18', 'text false']);
});

test('the cursor follows the page, but not while the mouse is captured', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  t.trust();
  t.emitPage('cursor-changed', {}, 'hand', undefined, 1, {}, { x: 0, y: 0 });
  t.emitPage('cursor-changed', {}, 'text', undefined, 1, {}, { x: 0, y: 0 });
  assert.deepEqual(t.native, ['cursor pointingHand', 'cursor iBeam']);
  t.host({ t: 'lock', id: 1, raw: false, activation: true });
  await t.flush();
  t.native.length = 0;
  t.emitPage('cursor-changed', {}, 'help', undefined, 1, {}, { x: 0, y: 0 });
  assert.deepEqual(
    t.native.filter((n) => n.startsWith('cursor')),
    [],
  );
  t.host({ t: 'exit' });
  assert.ok(t.native.includes('cursor arrow'), 'the latest cursor comes back when the capture ends');
});

test('a custom cursor carries its image and hotspot', () => {
  const t = setup();
  const image = { toPNG: () => Buffer.from([1, 2, 3]), isEmpty: () => false };
  t.emitPage('cursor-changed', {}, 'custom', image, 2, {}, { x: 4, y: 5 });
  assert.deepEqual(t.native, ['cursorImage']);
});

test('cursor names: the arrow, the hand and the rest', () => {
  assert.equal(nativeCursor('pointer'), 'arrow');
  assert.equal(nativeCursor('default'), 'arrow');
  assert.equal(nativeCursor('hand'), 'pointingHand');
  assert.equal(nativeCursor('text'), 'iBeam');
  assert.equal(nativeCursor('col-resize'), 'resizeLeftRight');
  assert.equal(nativeCursor('ns-resize'), 'resizeUpDown');
  assert.equal(nativeCursor('nwse-resize'), 'resizeNorthWest');
  assert.equal(nativeCursor('grabbing'), 'closedHand');
  assert.equal(nativeCursor('not-allowed'), 'notAllowed');
  assert.equal(nativeCursor('none'), 'hidden');
  assert.equal(nativeCursor('wait'), 'arrow');
  assert.equal(nativeCursor('something-new'), 'arrow');
});

function target(log: string[]): EditTarget {
  const t = {} as Record<string, () => void>;
  for (const name of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']) t[name] = () => void log.push(name);
  return t as unknown as EditTarget;
}

test('the Edit menu acts on the offscreen page, and does nothing before there is one', () => {
  const log: string[] = [];
  let page: EditTarget | undefined;
  const menu = editMenu(() => page);
  const items = menu.submenu as { label?: string; accelerator?: string; click?: () => void }[];
  const byLabel = (label: string) => items.find((i) => i.label === label)!;
  byLabel('Copy').click!();
  assert.deepEqual(log, []);
  page = target(log);
  for (const label of ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Delete', 'Select All']) byLabel(label).click!();
  assert.deepEqual(log, ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
  assert.equal(byLabel('Copy').accelerator, 'CmdOrCtrl+C');
  assert.equal(byLabel('Select All').accelerator, 'CmdOrCtrl+A');
  assert.equal(byLabel('Paste').accelerator, 'CmdOrCtrl+V');
});

test('the context menu offers links and edit commands that apply, and nothing otherwise', () => {
  const log: string[] = [];
  const flags = { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canDelete: true, canEditRichly: true };
  const opened: string[] = [];
  const copied: string[] = [];
  const base = { linkURL: '', isEditable: false, selectionText: '', editFlags: flags };
  assert.deepEqual(
    contextMenu(
      base,
      target(log),
      (u) => void opened.push(u),
      (c) => void copied.push(c),
    ),
    [],
  );
  const link = contextMenu(
    { ...base, linkURL: 'https://example.com/x' },
    target(log),
    (u) => void opened.push(u),
    (c) => void copied.push(c),
  );
  assert.deepEqual(
    link.map((i) => i.label),
    ['Open Link in Browser', 'Copy Link Address'],
  );
  link[0]!.click!(undefined as never, undefined, undefined as never);
  link[1]!.click!(undefined as never, undefined, undefined as never);
  assert.deepEqual([opened, copied], [['https://example.com/x'], ['https://example.com/x']]);
  const edit = contextMenu(
    { ...base, isEditable: true },
    target(log),
    () => {},
    () => {},
  );
  assert.deepEqual(
    edit.map((i) => i.label ?? '-'),
    ['Undo', 'Redo', '-', 'Cut', 'Copy', 'Paste', 'Select All'],
  );
  assert.equal(edit[0]!.enabled, false);
  assert.equal(edit[3]!.enabled, true);
  const selected = contextMenu(
    { ...base, selectionText: 'hi' },
    target(log),
    () => {},
    () => {},
  );
  assert.deepEqual(
    selected.map((i) => i.label),
    ['Copy'],
  );
});

test('the page is told when its window can no longer be seen, and again after it loads another document', async () => {
  const t = setup();
  t.emitPage('did-finish-load');
  await t.flush();
  assert.ok(!t.evaluated().some((e) => e.includes('visibility(')));
  t.input.setPageVisible(false);
  await t.flush();
  assert.equal(t.evaluated().filter((e) => e.includes('?.visibility(true)')).length, 1);
  t.emitPage('did-finish-load');
  await t.flush();
  assert.equal(t.evaluated().filter((e) => e.includes('?.visibility(true)')).length, 2);
  t.input.setPageVisible(true);
  await t.flush();
  assert.ok(t.evaluated().some((e) => e.includes('?.visibility(false)')));
  t.emitPage('did-finish-load');
  await t.flush();
  assert.equal(t.evaluated().filter((e) => e.includes('?.visibility(')).length, 3);
});
