import assert from 'node:assert/strict';
import test from 'node:test';

// wallpaper-store.ts runs on IndexedDB, Image decoding and a BroadcastChannel: a Map stands in for the
// database, each decode waits until the test settles it, and no channel opens (it would hold Node open).
const kept = new Map<string, unknown>();
const decodes: Array<{ src: string; settle: (ok: boolean) => void }> = [];

function request<T>(tx: { oncomplete?: () => void }, act: () => T) {
  const req: { result?: T } = {};
  queueMicrotask(() => {
    req.result = act();
    tx.oncomplete?.();
  });
  return req;
}

Object.assign(globalThis, {
  BroadcastChannel: undefined,
  indexedDB: {
    open() {
      const req: { result?: unknown; onsuccess?: () => void } = {};
      queueMicrotask(() => {
        req.result = {
          close() {},
          transaction() {
            const tx: { oncomplete?: () => void; objectStore?: () => unknown } = {};
            tx.objectStore = () => ({
              get: (key: string) => request(tx, () => kept.get(key)),
              put: (value: unknown, key: string) => request(tx, () => void kept.set(key, value)),
              delete: (key: string) => request(tx, () => void kept.delete(key)),
            });
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  },
  Image: class {
    src = '';
    naturalWidth = 1;
    naturalHeight = 1;
    decode() {
      return new Promise<void>((resolve, reject) => decodes.push({ src: this.src, settle: (ok) => (ok ? resolve() : reject(new Error('undecodable'))) }));
    }
  },
});

const { clearWallpaper, loadWallpaper, saveWallpaperFile, saveWallpaperUrl } = await import('../src/client/ui/wallpaper-store.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('removing the wallpaper outranks a link still being checked', async () => {
  kept.clear();
  decodes.length = 0;
  kept.set('custom', { kind: 'url', url: 'https://example.com/kept.jpg' });
  const slow = saveWallpaperUrl('https://example.com/slow.jpg');
  await tick();
  assert.equal(decodes[0]?.src, 'https://example.com/slow.jpg');
  await clearWallpaper();
  decodes[0].settle(true);
  await slow;
  assert.equal(await loadWallpaper(), null);
});

test('the newest choice wins over an older one that finishes later', async () => {
  kept.clear();
  decodes.length = 0;
  const slow = saveWallpaperUrl('https://example.com/slow.jpg');
  await tick();
  const file = new File([new Uint8Array([1, 2, 3])], 'mine.png', { type: 'image/png' });
  const fast = saveWallpaperFile(file);
  await tick();
  assert.equal(decodes.length, 2);
  decodes[1].settle(true);
  await fast;
  decodes[0].settle(true);
  await slow;
  const now = await loadWallpaper();
  assert.equal(now?.kind, 'file');
  assert.equal(now?.kind === 'file' && now.name, 'mine.png');
});

test('a link this browser cannot draw is refused and keeps the current wallpaper', async () => {
  kept.clear();
  decodes.length = 0;
  const first = saveWallpaperUrl('https://example.com/a.jpg');
  await tick();
  decodes.shift()?.settle(true);
  await first;
  const bad = saveWallpaperUrl('https://example.com/b.heic');
  await tick();
  decodes.shift()?.settle(false);
  await assert.rejects(bad, /didn’t load as a picture/);
  assert.deepEqual(await loadWallpaper(), { kind: 'url', url: 'https://example.com/a.jpg' });
});
