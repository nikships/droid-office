import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkPictureSource, sanitizePlacement, uploadName } from '../src/shared/decor.js';
import { Decor, magickConverter, PictureStore, sipsConverter } from '../src/server/decor.js';

const DESK = path.join(import.meta.dirname, '..', 'docs', 'desk.jpg');
// The smallest PNG: one transparent pixel.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');

function tmp(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'decor-pictures-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const spot = { wall: 'north', u: 0, y: 2, w: 1, h: 1, frame: 0 };

test('a picture the office keeps hangs like a link; anything that only looks like one does not', () => {
  const ref = `upload:${'a'.repeat(64)}.jpg`;
  assert.equal(uploadName(ref), `${'a'.repeat(64)}.jpg`);
  assert.deepEqual(checkPictureSource(ref), { url: ref });
  assert.equal((sanitizePlacement({ ...spot, url: ref }) as { url: string }).url, ref);
  for (const bad of ['upload:../../etc/passwd', `upload:${'a'.repeat(63)}.jpg`, `upload:${'a'.repeat(64)}.svg`, `upload:${'A'.repeat(64)}.png`]) {
    assert.equal(uploadName(bad), undefined, bad);
    assert.equal(typeof sanitizePlacement({ ...spot, url: bad }), 'string', bad);
  }
  assert.deepEqual(checkPictureSource('https://example.com/a.png'), { url: 'https://example.com/a.png' });
});

test('a picture browsers draw is kept as it is, under the hash of its bytes, once', async (t) => {
  const dir = tmp(t);
  const store = new PictureStore(dir, []);
  const saved = await store.save(PNG, 'dot.png');
  assert.ok('url' in saved);
  assert.match(saved.url, /^upload:[0-9a-f]{64}\.png$/);
  assert.deepEqual(await store.save(PNG, 'again.png'), saved);
  assert.equal(readdirSync(path.join(dir, 'pictures')).length, 1);
  const read = await store.read(uploadName(saved.url)!);
  assert.equal(read?.type, 'image/png');
  assert.ok(read?.body.equals(PNG));
  assert.equal(await store.read('../decor.json'), undefined);
});

test('a file nothing can read gets a plain answer, and an empty one too', async (t) => {
  const dir = tmp(t);
  const store = new PictureStore(dir, [sipsConverter(fakeSips(dir, 'nil').bin)]);
  assert.deepEqual(await store.save(Buffer.from('not a picture'), 'notes.txt'), { status: 415, error: "“notes.txt” isn't a picture this computer can open. Try a PNG, JPEG, HEIC, GIF, WebP or TIFF." });
  assert.deepEqual(await store.save(Buffer.alloc(0), 'empty.png'), { status: 400, error: 'That file is empty' });
});

/** A sips that answers `-g` the way the real one does (output copied from macOS 26) and writes `jpeg` as the desk photo. */
function fakeSips(dir: string, size: string): { bin: string; calls: string } {
  const bin = path.join(dir, 'sips');
  const calls = path.join(dir, 'calls');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${calls}"
case "$1" in
  -g)
    for last; do :; done
    echo "$last"
    if [ "${size}" = nil ]; then echo "  pixelWidth: <nil>"; else echo "  pixelWidth: ${size}"; echo "  pixelHeight: 1024"; echo "  hasAlpha: no"; fi ;;
  *)
    for last; do :; done
    cp "${DESK}" "$last" ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls };
}

test('sips converts what browsers cannot draw, shrinking only what is bigger than a wall texture', async (t) => {
  const dir = tmp(t);
  const small = fakeSips(dir, '1536');
  const store = new PictureStore(dir, [sipsConverter(small.bin)]);
  const saved = await store.save(Buffer.from('ftypheic fake'), 'IMG_0001.HEIC');
  assert.ok('url' in saved);
  assert.match(saved.url, /\.jpg$/);
  const [info, convert] = readFileSync(small.calls, 'utf8').trim().split('\n');
  assert.match(info, /^-g pixelWidth -g pixelHeight -g hasAlpha .*in\.heic$/);
  assert.match(convert, /^-s format jpeg -s formatOptions 90 .*in\.heic --out .*out\.jpg$/);

  const bigDir = tmp(t);
  const big = fakeSips(bigDir, '8000');
  await new PictureStore(bigDir, [sipsConverter(big.bin)]).save(Buffer.from('raw'), 'photo.dng');
  assert.match(readFileSync(big.calls, 'utf8'), /-Z 4096/);

  const nilDir = tmp(t);
  const nil = fakeSips(nilDir, 'nil');
  const refused = await new PictureStore(nilDir, [sipsConverter(nil.bin)]).save(Buffer.from('hello'), 'notes.txt');
  assert.equal('status' in refused && refused.status, 415);
});

test('a real HEIC from this Mac becomes a JPEG on the wall', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sips') }, async (t) => {
  const dir = tmp(t);
  const heic = path.join(dir, 'desk.heic');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', DESK, '--out', heic], { stdio: 'ignore' });
  const store = new PictureStore(dir, [sipsConverter()]);
  const saved = await store.save(readFileSync(heic), 'desk.heic');
  assert.ok('url' in saved, JSON.stringify(saved));
  assert.match(saved.url, /\.jpg$/);
  const body = (await store.read(uploadName(saved.url)!))!.body;
  assert.deepEqual([...body.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

test('pictures no wall shows go once they have been off the walls a day', async (t) => {
  const dir = tmp(t);
  const decor = new Decor(dir, []);
  const saved = await decor.pictures.save(PNG, 'dot.png');
  assert.ok('url' in saved);
  const file = path.join(dir, 'pictures', uploadName(saved.url)!);
  const d = decor.add({ ...spot, url: saved.url }, 'Nik');
  assert.equal(typeof d, 'object');
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  utimesSync(file, old, old);
  // Still on a wall: kept however old.
  decor.pictures.prune(new Set([uploadName(saved.url)!]));
  assert.ok(existsSync(file));
  // An upload that's not hung yet is kept while it's fresh.
  const fresh = await decor.pictures.save(Buffer.concat([PNG, Buffer.from([0])]), 'fresh.png');
  assert.ok('url' in fresh);
  decor.remove((d as { id: string }).id);
  assert.ok(existsSync(file), 'just taken down: its day off the walls starts now');
  assert.ok(existsSync(path.join(dir, 'pictures', uploadName(fresh.url)!)), 'fresh upload kept');
  decor.pictures.prune(new Set(), Date.now() + 25 * 60 * 60_000);
  assert.deepEqual(readdirSync(path.join(dir, 'pictures')), [], 'a day later both are gone');
  // A picture this floor no longer keeps can't go back up.
  assert.equal(decor.add({ ...spot, url: saved.url }, 'Nik'), 'That picture is no longer kept on this floor. Choose it from your computer again.');
});

test('with no converter installed the owner is told so, and ImageMagick never reads a format that can run scripts', async (t) => {
  const dir = tmp(t);
  const none = new PictureStore(dir, [magickConverter(path.join(dir, 'no-such-magick'))]);
  const missing = await none.save(Buffer.from('ftypheic'), 'IMG_0001.HEIC');
  assert.ok('error' in missing);
  assert.match(missing.error, /nothing to convert “IMG_0001\.HEIC” with/);
  // An SVG (or MVG, MSL, PostScript) is never handed to it, so it isn't even started.
  const svg = await none.save(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg');
  assert.ok('error' in svg);
  assert.match(svg.error, /isn't a picture this computer can open/);
});
