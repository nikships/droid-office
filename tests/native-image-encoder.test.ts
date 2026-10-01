import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { NativeImageEncoder, domImageEncoder } from '../src/client/native/image-encoder.js';

function global(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}

class Canvas {
  requests: string[] = [];
  toDataURL(type: string) {
    this.requests.push(type);
    return `data:${type};base64,AQID`;
  }
  toBlob() {
    assert.fail('the idle canvas callback must never hold up a menu update');
  }
}

function workerPage(t: TestContext) {
  const workers: FakeWorker[] = [];
  const bitmaps: { closed: boolean; close(): void }[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    messages: { id: number; bitmap: unknown; opaque: boolean }[] = [];
    transfers: unknown[][] = [];
    terminated = false;
    constructor(
      public url: URL,
      public options: unknown,
    ) {
      workers.push(this);
    }
    postMessage(message: (typeof this.messages)[number], transfer: unknown[]) {
      this.messages.push(message);
      this.transfers.push(transfer);
    }
    terminate() {
      this.terminated = true;
    }
  }
  global(t, 'HTMLCanvasElement', Canvas);
  global(t, 'OffscreenCanvas', class {});
  global(t, 'Worker', FakeWorker);
  global(t, 'createImageBitmap', async () => {
    const bitmap = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    bitmaps.push(bitmap);
    return bitmap;
  });
  return { workers, bitmaps };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

test('compressed fallback never waits for an idle canvas callback and preserves PNG/JPEG', async (t) => {
  global(t, 'HTMLCanvasElement', Canvas);
  const canvas = new Canvas();
  assert.deepEqual(await domImageEncoder(canvas, 4, 3, false), { fmt: 'png', bytes: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await domImageEncoder(canvas, 4, 3, true), { fmt: 'jpeg', bytes: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(canvas.requests, ['image/png', 'image/jpeg']);
});

test('worker snapshots and transfers UI images without using window canvas encoding', async (t) => {
  const { workers, bitmaps } = workerPage(t);
  const encoder = new NativeImageEncoder();
  const first = new Canvas();
  const second = new Canvas();
  const a = encoder.encode(first, 1104, 1027, false);
  const b = encoder.encode(second, 1200, 630, true);
  await flush();
  assert.equal(workers.length, 1, 'one lazy worker serves the scene');
  const worker = workers[0];
  assert.match(worker.url.pathname, /image-encoder\.worker\.ts$/);
  assert.deepEqual(worker.options, { type: 'module' });
  assert.deepEqual(
    worker.transfers,
    bitmaps.map((bitmap) => [bitmap]),
  );
  assert.deepEqual(
    worker.messages.map((m) => m.opaque),
    [false, true],
  );
  // Replies need not arrive in request order.
  worker.onmessage!({ data: { id: worker.messages[1].id, fmt: 'jpeg', buffer: new Uint8Array([2]).buffer } });
  worker.onmessage!({ data: { id: worker.messages[0].id, fmt: 'png', buffer: new Uint8Array([1]).buffer } });
  assert.deepEqual(await a, { fmt: 'png', bytes: new Uint8Array([1]) });
  assert.deepEqual(await b, { fmt: 'jpeg', bytes: new Uint8Array([2]) });
  assert.deepEqual(first.requests, []);
  assert.deepEqual(second.requests, []);
  encoder.dispose();
  assert.equal(worker.terminated, true);
});

test('worker failure releases pending encodes and future updates use the immediate fallback', async (t) => {
  const { workers } = workerPage(t);
  const encoder = new NativeImageEncoder();
  const pending = encoder.encode(new Canvas(), 4, 3, false);
  const rejected = assert.rejects(pending, /worker failed/);
  await flush();
  workers[0].onerror!();
  await rejected;
  assert.equal(workers[0].terminated, true);
  const next = new Canvas();
  assert.equal((await encoder.encode(next, 4, 3, false)).fmt, 'png');
  assert.deepEqual(next.requests, ['image/png']);
  assert.equal(workers.length, 1, 'a failed worker is not restarted on every canvas');
  encoder.dispose();
});

test('disposing the scene rejects pending jobs and closes snapshots that arrive afterward', async (t) => {
  const { workers, bitmaps } = workerPage(t);
  const encoder = new NativeImageEncoder();
  const pending = encoder.encode(new Canvas(), 4, 3, false);
  const rejected = assert.rejects(pending, /disposed/);
  encoder.dispose();
  await rejected;
  assert.equal(workers.length, 0);
  assert.equal(bitmaps[0].closed, true);
  await assert.rejects(encoder.encode(new Canvas(), 4, 3, false), /disposed/);
});
