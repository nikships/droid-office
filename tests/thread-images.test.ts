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
