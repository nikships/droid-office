import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countCtrlEnterInputs,
  decodeBase64,
  decodePlaceholderCell,
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
} from '../src/shared/kitty.js';

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

test('worker accounting ignores only Caps Lock and Num Lock in Kitty modifiers', () => {
  for (const lock of [64, 128, 192]) {
    assert.equal(countCtrlEnterInputs(`\x1b[13;${5 + lock}u\x1b[57414;${5 + lock}:2u`), 2);
    assert.ok(isClearQueueInput(`\x1b[120;${5 + lock}u`));
    assert.ok(isCancelInput(`\x1b[27;${1 + lock}u`));
    assert.ok(isCancelInput(`\x1b[99;${5 + lock}u`));
    for (const mod of [2, 5, 6, 9, 257]) assert.equal(isCancelInput(`\x1b[27;${lock + mod}u`), false);
    for (const suffix of [`${5 + lock}:3`, `${7 + lock}`, `${261 + lock}`]) {
      assert.equal(countCtrlEnterInputs(`\x1b[13;${suffix}u`), 0);
      assert.equal(isClearQueueInput(`\x1b[120;${suffix}u`), false);
      assert.equal(isCancelInput(`\x1b[99;${suffix}u`), false);
    }
  }
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
