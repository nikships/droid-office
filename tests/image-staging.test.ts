import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageStaging } from '../src/client/image-staging.js';

/** Uploads that finish when the test says, so remounts can happen while one is still going up. */
function rig() {
  const uploads: { floor: string; file: string; resolve(id: string): void; reject(err: Error): void }[] = [];
  const forgotten: string[] = [];
  const staging = new ImageStaging<string>({
    upload: (floor, file) => new Promise((resolve, reject) => uploads.push({ floor, file, resolve, reject })),
    forget: (floor, id) => forgotten.push(`${floor}:${id}`),
  });
  return { staging, uploads, forgotten };
}

test('a picture still uploading survives its box going away and is sendable once a remounted box adopts it', async () => {
  const { staging, uploads, forgotten } = rig();
  const staged = staging.stage('floor-a', 'shot.png');
  assert.equal(staged.id, undefined);
  // Pane, view or floor switch: the box detaches and the draft keeps the handle.
  staging.keep(staged.handle);
  uploads[0].resolve('server-1');
  await staged.settled;
  assert.deepEqual(forgotten, [], 'a kept upload is not thrown away when it lands');
  const adopted = staging.adopt(staged.handle);
  assert.equal(adopted?.id, 'server-1');
  assert.equal(adopted?.file, 'shot.png');
  assert.equal(staging.take(staged.handle), 'server-1');
  assert.equal(staging.size, 0, 'sent pictures belong to the prompt now');
});

test('a box remounted before the upload lands waits on the same upload, without uploading again', async () => {
  const { staging, uploads } = rig();
  const staged = staging.stage('floor-a', 'shot.png');
  staging.keep(staged.handle);
  const again = staging.adopt(staged.handle);
  assert.equal(again?.settled, staged.settled);
  uploads[0].resolve('server-1');
  await again?.settled;
  assert.equal(staging.get(staged.handle)?.id, 'server-1');
  assert.equal(uploads.length, 1);
});

test('connection loss discards every kept picture, pending or uploaded, on every floor, but not mounted ones', async () => {
  const { staging, uploads, forgotten } = rig();
  const up = staging.stage('floor-a', 'a.png');
  const pending = staging.stage('floor-b', 'b.png');
  const mounted = staging.stage('floor-a', 'c.png');
  uploads[0].resolve('server-a');
  await up.settled;
  staging.keep(up.handle);
  staging.keep(pending.handle);
  staging.removeKept();
  assert.deepEqual(forgotten, ['floor-a:server-a']);
  assert.equal(staging.get(up.handle), undefined);
  assert.equal(staging.get(pending.handle), undefined);
  assert.equal(staging.adopt(pending.handle), undefined, 'a cleared draft cannot bring it back');
  uploads[1].resolve('server-b');
  await pending.settled;
  assert.deepEqual(forgotten, ['floor-a:server-a', 'floor-b:server-b'], 'an upload landing after the loss is taken out on its own floor');
  assert.ok(staging.get(mounted.handle), 'a mounted box clears its own pictures');
});

test('removing a picture before its id arrives takes it out once it does, and a late failure stays silent', async () => {
  const { staging, uploads, forgotten } = rig();
  const failures: string[] = [];
  const a = staging.stage('f', 'a.png', (e) => failures.push(e.message));
  const b = staging.stage('f', 'b.png', (e) => failures.push(e.message));
  staging.remove(a.handle);
  staging.remove(b.handle);
  uploads[0].resolve('server-a');
  uploads[1].reject(new Error('too big'));
  await Promise.all([a.settled, b.settled]);
  assert.deepEqual(forgotten, ['f:server-a']);
  assert.deepEqual(failures, []);
  assert.equal(staging.take(a.handle), undefined, 'a removed picture is never sent');
});

test('a failed upload leaves the staging, so a remounted box drops it instead of waiting forever', async () => {
  const { staging, uploads } = rig();
  const failures: string[] = [];
  const staged = staging.stage('f', 'a.png', (e) => failures.push(e.message));
  staging.keep(staged.handle);
  uploads[0].reject(new Error('That picture could not be attached'));
  await staged.settled;
  assert.deepEqual(failures, ['That picture could not be attached']);
  assert.equal(staging.adopt(staged.handle), undefined);
});

test('handles are opaque and unique per page', () => {
  const { staging } = rig();
  const handles = new Set(Array.from({ length: 5 }, () => staging.stage('f', 'x').handle));
  assert.equal(handles.size, 5);
});
