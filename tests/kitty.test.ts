import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countCtrlEnterInputs,
  decodeBase64,
  decodePlaceholderCell,
  encodeKittyKey,
  isCancelInput,
  isClearQueueInput,
  isKittyPlaceholderCell,
  KITTY_DIACRITICS,
  KITTY_KB_ALL_FLAGS,
  KITTY_KB_DISAMBIGUATE,
  KITTY_KB_REPORT_EVENTS,
  KITTY_PLACEHOLDER_CHAR,
  KittyApcSplitter,
  KittyGraphicsStore,
  kittyImageSignature,
  KittyKeyboardState,
  stripKittyPlaceholders,
  type KittyKeyEvent,
} from '../src/shared/kitty.js';

function key(k: string, mods: Partial<KittyKeyEvent> = {}): KittyKeyEvent {
  return {
    type: 'keydown',
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  };
}

test('KittyKeyboardState maintains independent main and alternate buffer stacks and serializes cleanly', () => {
  const kb = new KittyKeyboardState();
  assert.equal(kb.flags, 0);
  assert.equal(kb.queryReply(), '\x1b[?0u');
  assert.equal(kb.serialize(), '');

  kb.push(KITTY_KB_DISAMBIGUATE);
  assert.equal(kb.flags, 1);
  assert.equal(kb.queryReply(), '\x1b[?1u');
  kb.set(KITTY_KB_REPORT_EVENTS, 2); // OR
  assert.equal(kb.flags, 3);
  kb.set(KITTY_KB_REPORT_EVENTS, 3); // AND-NOT
  assert.equal(kb.flags, 1);

  kb.push(KITTY_KB_ALL_FLAGS);
  assert.equal(kb.flags, 31);
  assert.equal(kb.serialize(), '\x1b[>1u\x1b[>31u');

  // Alternate screen starts with its own clean stack.
  kb.setAlternate(true);
  assert.equal(kb.flags, 0);
  kb.push(9);
  assert.equal(kb.flags, 9);

  kb.setAlternate(false);
  assert.equal(kb.flags, 31);
  kb.pop(1);
  assert.equal(kb.flags, 1);
  kb.pop(5);
  assert.equal(kb.flags, 0);

  // Replay serialized state into a fresh instance.
  const a = new KittyKeyboardState();
  a.set(3, 1);
  a.push(1);
  const replayed = new KittyKeyboardState();
  assert.equal(a.serialize(), '\x1b[=3;1u\x1b[>1u');
  replayed.set(3, 1);
  replayed.push(1);
  assert.equal(replayed.flags, 1);
  replayed.pop(1);
  assert.equal(replayed.flags, 3);

  a.reset();
  assert.equal(a.flags, 0);
  assert.equal(a.serialize(), '');
});

test('encodeKittyKey handles progressive flags 0, 1, 2, 4, 8 and 16 while preserving host shortcuts', () => {
  // Flag 0 falls back to Droid CSI u Enter only when csiEnter is true.
  assert.deepEqual(encodeKittyKey(key('Enter', { ctrlKey: true }), 0, { csiEnter: true }), { do: 'send', data: '\x1b[13;5u' });
  assert.deepEqual(encodeKittyKey(key('Enter', { ctrlKey: true }), 0, { csiEnter: false }), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key('Escape'), 0, { csiEnter: true }), { do: 'default' });

  // Host / clipboard / IME shortcuts stay with browser/xterm even under full flags.
  assert.deepEqual(encodeKittyKey(key('c', { metaKey: true }), KITTY_KB_ALL_FLAGS), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key('C', { ctrlKey: true, shiftKey: true }), KITTY_KB_ALL_FLAGS), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key('Insert', { shiftKey: true }), KITTY_KB_ALL_FLAGS), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key('a', { isComposing: true }), KITTY_KB_ALL_FLAGS), { do: 'default' });

  // Flag 1 (DISAMBIGUATE): what Droid negotiates via `\x1b[>1u`.
  const f1 = KITTY_KB_DISAMBIGUATE;
  assert.deepEqual(encodeKittyKey(key('Escape'), f1), { do: 'send', data: '\x1b[27u' });
  assert.deepEqual(encodeKittyKey(key('Enter'), f1), { do: 'send', data: '\r' });
  assert.deepEqual(encodeKittyKey(key('Enter', { shiftKey: true }), f1), { do: 'send', data: '\x1b[13;2u' });
  assert.deepEqual(encodeKittyKey(key('Enter', { ctrlKey: true }), f1), { do: 'send', data: '\x1b[13;5u' });
  assert.deepEqual(encodeKittyKey(key('Tab'), f1), { do: 'send', data: '\t' });
  assert.deepEqual(encodeKittyKey(key('Tab', { shiftKey: true }), f1), { do: 'send', data: '\x1b[9;2u' });
  assert.deepEqual(encodeKittyKey(key('Backspace'), f1), { do: 'send', data: '\x7f' });
  assert.deepEqual(encodeKittyKey(key('Backspace', { altKey: true }), f1), { do: 'send', data: '\x1b[127;3u' });
  assert.deepEqual(encodeKittyKey(key('a'), f1), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key('A', { shiftKey: true, code: 'KeyA' }), f1), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key('a', { ctrlKey: true, code: 'KeyA' }), f1), { do: 'send', data: '\x1b[97;5u' });
  assert.deepEqual(encodeKittyKey(key('A', { ctrlKey: true, shiftKey: true, code: 'KeyA' }), f1), { do: 'send', data: '\x1b[97;6u' });
  assert.deepEqual(encodeKittyKey(key(' ', { shiftKey: true, code: 'Space' }), f1), { do: 'send', data: '\x1b[32;2u' });
  assert.deepEqual(encodeKittyKey(key('ArrowUp'), f1), { do: 'send', data: '\x1b[A' });
  assert.deepEqual(encodeKittyKey(key('ArrowUp'), f1, { appCursor: true }), { do: 'send', data: '\x1bOA' });
  assert.deepEqual(encodeKittyKey(key('ArrowUp', { altKey: true }), f1), { do: 'send', data: '\x1b[1;3A' });
  assert.deepEqual(encodeKittyKey(key('Delete', { ctrlKey: true }), f1), { do: 'send', data: '\x1b[3;5~' });
  assert.deepEqual(encodeKittyKey(key('Shift', { code: 'ShiftLeft', shiftKey: true }), f1), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key('Escape', { type: 'keyup' }), f1), { do: 'default' });
  // xterm types Space and Shift+A..Z on keypress, so a keypress whose keydown sent nothing must reach xterm.
  assert.deepEqual(encodeKittyKey(key(' ', { type: 'keypress', code: 'Space', keyCode: 32 }), f1), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key('A', { type: 'keypress', shiftKey: true, code: 'KeyA', keyCode: 65 }), f1), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key(' ', { type: 'keypress', shiftKey: true, code: 'Space', keyCode: 32 }), f1), { do: 'swallow' });
  assert.deepEqual(encodeKittyKey(key('Enter', { type: 'keypress', code: 'Enter', keyCode: 13 }), f1), { do: 'swallow' });
  assert.deepEqual(encodeKittyKey(key(' ', { type: 'keypress', code: 'Space', keyCode: 32 }), KITTY_KB_DISAMBIGUATE | KITTY_KB_REPORT_EVENTS), { do: 'default' });
  assert.deepEqual(encodeKittyKey(key(' ', { type: 'keypress', code: 'Space', keyCode: 32 }), KITTY_KB_ALL_FLAGS), { do: 'swallow' });

  // Flags 1 | 2 | 4 | 8 | 16 (full progressive enhancement; C0 control keys omit associated text per Kitty spec).
  const full = KITTY_KB_ALL_FLAGS;
  assert.deepEqual(encodeKittyKey(key('Enter'), full), { do: 'send', data: '\x1b[13u' });
  assert.deepEqual(encodeKittyKey(key('A', { shiftKey: true, code: 'KeyA' }), full), { do: 'send', data: '\x1b[97:65;2;65u' });
  assert.deepEqual(encodeKittyKey(key('a', { repeat: true, code: 'KeyA' }), full), { do: 'send', data: '\x1b[97;1:2;97u' });
  assert.deepEqual(encodeKittyKey(key('a', { type: 'keyup', code: 'KeyA' }), full), { do: 'send', data: '\x1b[97;1:3u' });
  assert.deepEqual(encodeKittyKey(key('Shift', { code: 'ShiftLeft', shiftKey: true }), full), { do: 'send', data: '\x1b[57441;2u' });
});

test('worker input counters recognize both legacy and Kitty CSI u queue, clear and cancel keys', () => {
  assert.equal(countCtrlEnterInputs('\x1b[13;5u'), 1);
  assert.equal(countCtrlEnterInputs('\x1b[13;5:2;13u\x1b[57414;5u'), 2);
  assert.equal(countCtrlEnterInputs('\x1b[13;5:3u'), 0, 'keyup does not count as another queued turn');
  assert.equal(isClearQueueInput('\x18'), true);
  assert.equal(isClearQueueInput('\x1b[120;5u'), true);
  assert.equal(isClearQueueInput('\x1b[120;5:3u'), false);
  assert.equal(isCancelInput('\x1b'), true);
  assert.equal(isCancelInput('\x03'), true);
  assert.equal(isCancelInput('\x1b[27u'), true);
  assert.equal(isCancelInput('\x1b[99;5u'), true);
  assert.equal(isCancelInput('\x1b[27;1:3u'), false);
});

test('KittyApcSplitter reassembles APC G across arbitrary byte splits and terminators', () => {
  const full = 'hello\x1b_Ga=T,f=32,s=1,v=1,i=7;//8A\x1b\\mid\x1b_Ga=q,i=32,U=1\x07end';
  for (const step of [1, 2, 3, 5, 13, full.length]) {
    const splitter = new KittyApcSplitter();
    const out = [];
    for (let i = 0; i < full.length; i += step) {
      out.push(...splitter.feed(full.slice(i, i + step)));
    }
    const text = out
      .filter((s) => s.type === 'text')
      .map((s) => s.data)
      .join('');
    const apcs = out.filter((s) => s.type === 'apc').map((s) => s.body);
    assert.equal(text, 'hellomidend');
    assert.deepEqual(apcs, ['a=T,f=32,s=1,v=1,i=7;//8A', 'a=q,i=32,U=1']);
  }
});

test('KittyGraphicsStore answers Droid v1.9.0 capability probes, rejects file transfers and replays chunked images', () => {
  const store = new KittyGraphicsStore();

  // Exact Droid v1.9.0 basic graphics probe.
  const q1 = store.processApc('i=31,s=1,v=1,a=q,t=d,f=24;AAAA');
  assert.equal(q1.reply, '\x1b_Gi=31;OK\x1b\\');
  assert.equal(store.size, 0, 'queries never persist test images');

  // Exact Droid v1.9.0 U=1 Unicode placeholder probe + Droid response regex check.
  const q2 = store.processApc('a=q,i=32,e=T,U=1');
  assert.equal(q2.reply, '\x1b_Gi=32,U=1;OK\x1b\\');
  const droidMatch = /\x1b_Gi=32((?:,[A-Za-z]=[^,;]*)*);OK\x1b\\/.exec(q2.reply!);
  assert.ok(droidMatch && /(?:^|,)U=1(?:,|$)/.test(droidMatch[1]));

  // Reject local-path t=f / t=s so remote web/Android clients always get inline t=d base64.
  const badFile = store.processApc('a=t,t=f,f=100,i=9;L3RtcC9hLnBuZw==');
  assert.match(badFile.reply ?? '', /^\x1b_Gi=9;EINVAL:/);

  // Multi-chunk U=1 upload + animation frame + serialize round-trip.
  const payload = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(200);
  assert.equal(store.processApc(`a=T,U=1,q=2,f=32,o=z,s=16,v=16,i=42,c=2,r=1,m=1;${payload.slice(0, 100)}`).effect.type, 'none');
  const done = store.processApc(`m=0,q=2;${payload.slice(100)}`);
  assert.equal(done.reply, undefined, 'q=2 suppresses OK');
  assert.equal(done.effect.type, 'image');
  store.processApc('a=f,i=42,q=2,f=32,o=z,s=16,v=16,z=80;AAAA');
  store.processApc('a=a,i=42,r=1,z=80,q=2');
  store.processApc('a=a,i=42,s=3,v=1,q=2');

  const serialized = store.serialize();
  const replayed = new KittyGraphicsStore();
  for (const seg of new KittyApcSplitter().feed(serialized)) {
    if (seg.type === 'apc') replayed.processApc(seg.body);
  }
  const restored = replayed.get(42);
  assert.ok(restored);
  assert.equal(restored.unicode, true);
  assert.equal(restored.data, payload);
  assert.equal(restored.frames.length, 1);
  assert.equal(restored.frames[0].delayMs, 80);
  assert.equal(restored.rootDelayMs, 80);
  assert.equal(restored.animState, 3);

  // Delete image 42.
  replayed.processApc('a=d,d=I,i=42,q=2');
  assert.equal(replayed.get(42), undefined);
});

test('decodePlaceholderCell and stripKittyPlaceholders handle diacritics, inheritance and 32-bit IDs', () => {
  assert.equal(KITTY_DIACRITICS.length, 297);
  const d = (idx: number) => String.fromCodePoint(KITTY_DIACRITICS[idx]);
  const cell0 = `${KITTY_PLACEHOLDER_CHAR}${d(3)}${d(7)}`;
  assert.equal(isKittyPlaceholderCell(cell0), true);
  const p0 = decodePlaceholderCell(cell0, 0x123456);
  assert.deepEqual(p0, { imageId: 0x123456, placementId: 0, row: 3, col: 7, msb: 0 });

  // Zero-diacritic continuation cell inherits row and advances col by 1.
  const p1 = decodePlaceholderCell(KITTY_PLACEHOLDER_CHAR, 0x123456, 0, p0);
  assert.deepEqual(p1, { imageId: 0x123456, placementId: 0, row: 3, col: 8, msb: 0 });

  // 3rd diacritic supplies bits 24..31 of a 32-bit image ID.
  const p32 = decodePlaceholderCell(`${KITTY_PLACEHOLDER_CHAR}${d(1)}${d(2)}${d(5)}`, 0xabcdef);
  assert.equal(p32?.imageId, 0x05abcdef);

  // Strip placeholders from plain text while keeping surrounding text intact.
  const mixed = `before ${cell0}${KITTY_PLACEHOLDER_CHAR} after`;
  assert.equal(stripKittyPlaceholders(mixed), 'before  after');
  assert.equal(stripKittyPlaceholders(mixed, '?'), 'before ?? after');

  // Base64 decode round-trip and content-addressed image signatures.
  assert.deepEqual([...decodeBase64('AAEC/w==')], [0, 1, 2, 255]);
  const sigA = kittyImageSignature({ format: 32, width: 2, height: 1, data: 'AAAAAAAA' });
  const sigB = kittyImageSignature({ format: 32, width: 2, height: 1, data: '////////' });
  const sigAnim = kittyImageSignature({ format: 32, width: 2, height: 1, data: 'AAAAAAAA', frames: [{ format: 32, delayMs: 80, data: '////////' }] });
  assert.notEqual(sigA, sigB, 'equal-length payloads with different pixels produce distinct signatures');
  assert.notEqual(sigA, sigAnim, 'animation frames invalidate signature');
});
