import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DropStore, dropName, pictureExt } from '../src/server/drops.js';
import { droppedPaths, withImages } from '../src/shared/drops.js';

function dataDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-drops-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a dropped file keeps a name that is safe to type into a terminal', () => {
  assert.equal(dropName('Screenshot 2026-09-29 at 10.02.03\u202fAM.png', 'image/png'), 'Screenshot-2026-09-29-at-10.02.03-AM.png');
  assert.equal(dropName('résumé (final).PDF', 'application/pdf'), 'resume-final.pdf');
  assert.equal(dropName('../../etc/passwd', ''), 'passwd');
  assert.equal(dropName('C:\\Users\\sam\\shot.jpeg', 'image/jpeg'), 'shot.jpeg');
  assert.equal(dropName('$(rm -rf ~);.png', 'image/png'), 'rm--rf.png');
});

test('a picture dropped without a name ending gets one, so the agent sees a picture', () => {
  assert.equal(dropName('image', 'image/png'), 'image.png');
  assert.equal(dropName('', 'image/jpeg'), 'file.jpg');
  assert.equal(dropName('.env', 'text/plain'), 'env');
  assert.equal(dropName('notes', 'text/plain'), 'notes');
});

test('dropped paths are typed the way a terminal types a dragged file', () => {
  assert.equal(droppedPaths(['/home/sam/proj/.droid-office/drops/w1/ab-shot.png']), '/home/sam/proj/.droid-office/drops/w1/ab-shot.png');
  assert.equal(droppedPaths(['/Users/sam/my proj/a.png', '/tmp/b.png']), '/Users/sam/my\\ proj/a.png /tmp/b.png');
  assert.equal(droppedPaths(["/Users/sam/it's (new)/café.png"]), "/Users/sam/it\\'s\\ \\(new\\)/café.png");
  assert.equal(droppedPaths(['C:\\Users\\sam\\proj\\a.png']), 'C:\\Users\\sam\\proj\\a.png');
  assert.equal(droppedPaths(['C:\\Users\\sam\\my proj\\a.png']), '"C:\\Users\\sam\\my proj\\a.png"');
});

test("each worker's drops are kept apart and go when the worker does", (t) => {
  const store = new DropStore(dataDir(t));
  const a = store.save('w1', 'shot.png', 'image/png', Buffer.from('one'));
  const b = store.save('w1', 'shot.png', 'image/png', Buffer.from('two'));
  const c = store.save('w2', 'image', 'image/png', Buffer.from('three'));
  assert.ok(a && b && c);
  assert.notEqual(a, b);
  assert.equal(readFileSync(a, 'utf8'), 'one');
  assert.equal(readFileSync(b, 'utf8'), 'two');
  assert.match(path.basename(c), /^[0-9a-f]{8}-image\.png$/);
  assert.equal(store.save('../w1', 'x.png', 'image/png', Buffer.from('x')), undefined);

  store.remove('w1');
  assert.ok(!existsSync(a) && !existsSync(b) && existsSync(c));
  store.prune(new Set(['w3']));
  assert.ok(!existsSync(c));
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

test('a picture is known by its first bytes, not by what the browser called it', () => {
  assert.equal(pictureExt(PNG), '.png');
  assert.equal(pictureExt(JPEG), '.jpg');
  assert.equal(pictureExt(Buffer.from('GIF89a......')), '.gif');
  assert.equal(pictureExt(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')])), '.webp');
  assert.equal(pictureExt(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
  assert.equal(pictureExt(Buffer.from('#!/bin/sh\nrm -rf ~\n')), undefined);
  assert.equal(pictureExt(Buffer.alloc(0)), undefined);
});

test('a prompt lists its pictures after the text, numbered in the order they were added', () => {
  assert.equal(withImages('Fix this', ['/d/a.png', '/d/b.png']), 'Fix this\n\nImage 1: /d/a.png\nImage 2: /d/b.png');
  assert.equal(withImages('  ', ['/d/a.png']), 'Image 1: /d/a.png');
  assert.equal(withImages(' Fix this ', []), 'Fix this');
});

test('staged pictures wait for a prompt, are copied to a worker when it is sent, and can be taken out', (t) => {
  const store = new DropStore(dataDir(t));
  const a = store.stage('Screenshot 1.png', PNG);
  const b = store.stage('photo.PNG', JPEG);
  assert.ok(a && b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(store.stage('notes.png', Buffer.from('not a picture')), undefined);

  // The kind of picture is what its bytes say: the JPEG named .PNG is kept as a .jpg.
  const paths = store.adopt('w1', [a, b, 'ffffffffffffffff', '../etc']);
  assert.equal(paths.length, 2);
  assert.match(path.basename(paths[0]), /^[0-9a-f]{8}-Screenshot-1\.png$/);
  assert.match(path.basename(paths[1]), /^[0-9a-f]{8}-photo\.jpg$/);
  assert.deepEqual(readFileSync(paths[0]), PNG);
  assert.ok(paths[0].includes(`${path.sep}w1${path.sep}`));

  // A second worker adopts the same pictures: they stay staged until the prompt's done with them.
  assert.equal(store.adopt('w2', [a]).length, 1);
  store.unstage([a, b, '../etc']);
  assert.deepEqual(store.adopt('w3', [a, b]), []);
  assert.ok(existsSync(paths[0]), 'what a worker adopted stays with it');
});

test('pruning leaves staged pictures alone and still clears the workers that left', (t) => {
  const store = new DropStore(dataDir(t));
  const id = store.stage('shot.png', PNG)!;
  const kept = store.save('gone', 'x.png', 'image/png', PNG)!;
  store.prune(new Set());
  assert.ok(!existsSync(kept));
  assert.equal(store.adopt('w1', [id]).length, 1);
});
