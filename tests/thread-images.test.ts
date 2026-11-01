import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { imageAddress, imageRef, imageSize, isImage } from '../src/server/thread-images.js';

const repo = (file: string) => readFile(new URL(`../${file}`, import.meta.url));

test('reads a picture size from PNG, JPEG, WebP and GIF headers', async () => {
  assert.deepEqual(imageSize(await repo('src/client/public/icons/icon-192.png'), 'image/png'), { width: 192, height: 192 });
  assert.deepEqual(imageSize(await repo('android/docs/unpaired.jpg'), 'image/jpeg'), { width: 540, height: 1200 });
  assert.deepEqual(imageSize(await repo('docs/assets/readme/whiteboard-collab.webp'), 'image/webp'), { width: 960, height: 540 });
  const gif = Buffer.from([...Buffer.from('GIF89a'), 0x40, 0x01, 0xf0, 0x00, 0, 0, 0, 0, 0]);
  assert.equal(isImage(gif, 'image/gif'), true);
  assert.deepEqual(imageSize(gif, 'image/gif'), { width: 320, height: 240 });
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'), undefined);
});

/** A JPEG header 400 wide and 300 high whose Exif says `orientation`, in either byte order. */
function exifJpeg(orientation: number, little = false): Buffer {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (little ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const tiff = [...Buffer.from(little ? 'II' : 'MM'), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const app1 = [...Buffer.from('Exif\0\0'), ...tiff];
  const sof = [0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, app1.length + 2, ...app1, 0xff, 0xc0, 0, sof.length + 2, ...sof, 0xff, 0xd9]);
}

test("a phone photo's size is the way round it is shown: its Exif orientation applied", () => {
  assert.equal(isImage(exifJpeg(1), 'image/jpeg'), true);
  assert.deepEqual(imageSize(exifJpeg(1), 'image/jpeg'), { width: 400, height: 300 });
  assert.deepEqual(imageSize(exifJpeg(3), 'image/jpeg'), { width: 400, height: 300 }, 'upside down is still the same way round');
  for (const turn of [5, 6, 7, 8]) assert.deepEqual(imageSize(exifJpeg(turn), 'image/jpeg'), { width: 300, height: 400 }, `orientation ${turn}`);
  assert.deepEqual(imageSize(exifJpeg(6, true), 'image/jpeg'), { width: 300, height: 400 }, 'little-endian Exif');
  const cut = exifJpeg(6).subarray(0, 24);
  assert.equal(imageSize(cut, 'image/jpeg'), undefined, 'a header cut short inside the Exif block has no size');
});

test('a PNG needs its whole signature', async () => {
  const png = await repo('src/client/public/icons/icon-192.png');
  assert.equal(isImage(png, 'image/png'), true);
  const broken = Buffer.from(png);
  broken[4] = 0;
  assert.equal(isImage(broken, 'image/png'), false);
});

test('a picture is only offered for a browser type whose bytes match it', async () => {
  const png = await repo('src/client/public/icons/icon-192.png');
  const part = (data: string, media_type: string, type = 'base64') => ({ type: 'image', source: { type, data, media_type } });
  assert.match(imageRef(part(png.toString('base64'), 'image/png'), '10.2.0')?.id ?? '', /^10\.2\.0\.[0-9a-f]{8}$/);
  assert.equal(imageRef(part(png.toString('base64'), 'image/jpeg'), '10.2.0'), undefined);
  assert.equal(imageRef(part(png.toString('base64'), 'image/svg+xml'), '10.2.0'), undefined);
  assert.equal(imageRef(part('PRIVATE_IMAGE', 'image/png'), '10.2.0'), undefined);
  assert.equal(imageRef(part('https://example.com/a.png', 'image/png', 'url'), '10.2.0'), undefined);
  assert.equal(imageRef({ type: 'text', text: 'hi' }, '10.2.0'), undefined);
});

test('picture ids parse only in their own shape', () => {
  assert.deepEqual(imageAddress('120.3.1.0a1b2c3d'), { offset: 120, part: 3, sub: 1, hash: '0a1b2c3d' });
  assert.deepEqual(imageAddress('120.3.x.0a1b2c3d'), { offset: 120, part: 3, hash: '0a1b2c3d' });
  for (const id of ['', '120.3.1', '-1.3.1.0a1b2c3d', '120.3.1.0A1B2C3D', '120.3.1.0a1b2c3d.', '../../etc/passwd']) assert.equal(imageAddress(id), undefined, id);
});
