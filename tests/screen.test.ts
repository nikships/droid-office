import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import { KITTY_CELL_PX_H, KITTY_CELL_PX_W, KITTY_DIACRITICS, KITTY_PLACEHOLDER_CHAR } from '../src/shared/kitty.js';
import { getTerminalKitty, screenSnapshot, setTerminalResponder } from '../src/server/screen.js';

function terminal() {
  const term = new headless.Terminal({ cols: 80, rows: 10, scrollback: 100, allowProposedApi: true });
  const ser = new serialize.SerializeAddon();
  term.loadAddon(ser as any);
  term.loadAddon(new unicode11.Unicode11Addon() as any);
  term.unicode.activeVersion = '11';
  const snapshot = screenSnapshot(term, ser);
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  return { term, snapshot, write };
}

/** A fresh terminal fed a snapshot ends up with the mouse the way the snapshot left it. */
async function restored(snapshot: string) {
  const t = terminal();
  await t.write(snapshot);
  return t;
}

test('a snapshot keeps the SGR mouse encoding OpenCode switches on, so the wheel still reaches it', async () => {
  const { write, snapshot } = terminal();
  // What OpenCode prints on start: the alternate screen, every mouse tracking mode, then SGR reports.
  await write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006hhello');
  const snap = snapshot();
  assert.match(snap, /\x1b\[\?1003h/);
  assert.match(snap, /\x1b\[\?1006h/);

  const again = await restored(snap);
  assert.equal(again.term.modes.mouseTrackingMode, 'any');
  assert.match(again.snapshot(), /\x1b\[\?1006h/, 'the encoding survives a second hop (pty host, then office, then browser)');
});

test('switching the encoding off, or a full reset, leaves it out of the snapshot', async () => {
  const off = terminal();
  await off.write('\x1b[?1000h\x1b[?1006h\x1b[?1006l');
  assert.doesNotMatch(off.snapshot(), /\x1b\[\?1006h/);

  const reset = terminal();
  await reset.write('\x1b[?1000h\x1b[?1006h\x1bc');
  assert.doesNotMatch(reset.snapshot(), /\x1b\[\?1006h/);
});

test('a terminal without the mouse snapshots as before', async () => {
  const { write, snapshot } = terminal();
  await write('plain output\r\n');
  assert.doesNotMatch(snapshot(), /\x1b\[\?10(0[0-6]|1[56])h/);
});

test('answers Droid capability probes in exact stream order before DA1 and ignores restored preludes', async () => {
  const { term, write } = terminal();
  const replies: string[] = [];
  // Queries inside a saved scrollback prelude before setTerminalResponder must not fire replies.
  term.write('\x1b[?u\x1b[c');
  setTerminalResponder(term, (d) => replies.push(d));
  await write('\x1b[?u\x1b]11;?\x07\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b_Ga=q,i=32,e=T,U=1\x1b\\\x1b[16t\x1b[14t\x1b[>0q\x1b[c');

  assert.deepEqual(replies, ['\x1b[?0u', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b_Gi=31;OK\x1b\\', '\x1b_Gi=32,U=1;OK\x1b\\', '\x1b[6;36;18t', '\x1b[4;360;1440t', '\x1bP>|droid-office(1.0)\x1b\\', '\x1b[?1;2c']);
});

test('reports Retina device-pixel cells, so image CLIs send inline images at twice the old resolution', async () => {
  const { term, write } = terminal();
  const replies: string[] = [];
  setTerminalResponder(term, (d) => replies.push(d));
  await write('\x1b[16t');
  // Droid reads `CSI 6 ; height ; width t` and downsamples each image to cols × width by rows × height pixels
  // (12 rows at most): 9×18 cells capped a 2400×1640 screenshot at 315×215 in the expanded viewer.
  const [, h, w] = /^\x1b\[6;(\d+);(\d+)t$/.exec(replies[0] ?? '') ?? [];
  assert.deepEqual([Number(w), Number(h)], [18, 36]);
  assert.ok(12 * Number(h) >= 2 * 12 * 18, 'a 12-row image gets at least 2× the 1× cell height in pixels');
});

test('a direct placement without c/r takes its cells from the reported cell size, as every mirror does', async () => {
  const { term, write } = terminal();
  await write(`\x1b_Ga=T,f=32,s=${KITTY_CELL_PX_W * 3},v=${KITTY_CELL_PX_H * 2},i=5;AAAA\x1b\\`);
  const p = getTerminalKitty(term)?.directPlacements[0];
  assert.deepEqual([p?.cols, p?.rows], [3, 2]);
  assert.deepEqual([term.buffer.active.cursorX, term.buffer.active.cursorY], [3, 1], 'cursor lands just past the image on its last row');
});

test('a direct placement with explicit c/r keeps exactly those cells whatever its pixel size', async () => {
  const { term, write } = terminal();
  await write('\x1b_Ga=T,f=32,s=900,v=900,c=5,r=3,i=6;AAAA\x1b\\');
  const p = getTerminalKitty(term)?.directPlacements[0];
  assert.deepEqual([p?.cols, p?.rows], [5, 3]);
  assert.deepEqual([term.buffer.active.cursorX, term.buffer.active.cursorY], [5, 2]);
});

test('Kitty keyboard stack and U=1 inline graphics survive two snapshot hops and clear on RIS', async () => {
  const hop1 = terminal();
  const d0 = String.fromCodePoint(KITTY_DIACRITICS[0]);
  const d1 = String.fromCodePoint(KITTY_DIACRITICS[1]);
  await hop1.write(`\x1b[>1u\x1b_Ga=T,U=1,q=2,f=32,s=2,v=1,i=515,c=2,r=1;//8AAP//\x1b\\\x1b[38;2;0;2;3m${KITTY_PLACEHOLDER_CHAR}${d0}${d0}${KITTY_PLACEHOLDER_CHAR}${d0}${d1}\x1b[39m\r\n`);

  const snap1 = hop1.snapshot();
  const hop2 = await restored(snap1);
  assert.equal(getTerminalKitty(hop2.term)?.keyboard.flags, 1);
  assert.equal(getTerminalKitty(hop2.term)?.graphics.get(515)?.data, '//8AAP//');

  const hop3 = await restored(hop2.snapshot());
  assert.equal(getTerminalKitty(hop3.term)?.keyboard.flags, 1);
  assert.equal(getTerminalKitty(hop3.term)?.graphics.get(515)?.data, '//8AAP//');

  await hop3.write('\x1bc');
  assert.equal(getTerminalKitty(hop3.term)?.keyboard.flags, 0);
  assert.equal(getTerminalKitty(hop3.term)?.graphics.size, 0);
});
