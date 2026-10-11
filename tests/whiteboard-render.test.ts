import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { OWNER_AUTHOR, STICKY_COLORS, type Op } from '../src/shared/whiteboard.js';
import type { WhiteboardRendererStatus } from '../src/shared/protocol.js';
import { WhiteboardStore, renderInfo, type PinnedCard } from '../src/server/whiteboard.js';
import { readBoard } from '../src/server/whiteboard-agent.js';
import { BrowserError, browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { CANVAS_MARGIN, RenderEngine, THUMB_WIDTH, canvasPlan, type Capture, type CaptureOptions, type FloorRenderer, type RenderEngineOptions } from '../src/server/whiteboard-render.js';

const AGENT = { kind: 'worker', id: 'w1', name: 'Pixel', color: '#ff8800' } as const;
const FLOOR = { id: 'f1', name: 'Main' };
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function waitFor<T>(read: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(20);
  }
}

/** A store on a fresh folder with a floor of `engine`, recording what the floor hears. */
function rig(t: { after(fn: () => unknown): void }, opts: RenderEngineOptions) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-wb-render-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statuses: WhiteboardRendererStatus[] = [];
  const engine = new RenderEngine({ ...opts, onStatus: (s) => statuses.push(s) });
  const rendered: string[] = [];
  let store: WhiteboardStore | undefined;
  const floor = engine.floor('f1', { onRendered: (id) => rendered.push(id), resolveMarks: (id, key, marks) => store?.resolveMarks(id, key, marks) });
  store = new WhiteboardStore(root, { renderer: floor });
  const s = store;
  t.after(async () => {
    s.stop();
    await engine.close();
  });
  const epoch = s.issueEpoch();
  let seq = 0;
  const apply = (actor: 'owner' | 'agent', ...ops: Op[]) => {
    const r = s.apply({ epoch, seq: ++seq, ops }, actor === 'owner' ? OWNER_AUTHOR : AGENT, actor === 'owner' ? 'window' : 'agent');
    assert.equal(r.kind, 'ack', JSON.stringify(r));
  };
  // Every pin the store hands out, to check each one is released.
  const pins: { pin: PinnedCard; released: boolean }[] = [];
  const pin = s.pin.bind(s);
  s.pin = (id, board) => {
    const p = pin(id, board);
    if (!p) return p;
    const entry = { pin: p, released: false };
    const release = p.release;
    (p as { release: () => void }).release = () => {
      entry.released = true;
      release();
    };
    pins.push(entry);
    return p;
  };
  return { root, store: s, engine, floor: floor as FloorRenderer, statuses, rendered, apply, pins };
}

const page = (card: string, html: string): Op => ({ op: 'card.create', card, kind: 'html', title: card, content: { load: { html } } }) as unknown as Op;

/** A capture that takes as long as the test says, per card revision, and records what it was asked. */
function fakeCapture() {
  const calls: { card: string; rev: number; signal: AbortSignal }[] = [];
  const gates = new Map<number, Promise<void>>();
  let running = 0;
  let most = 0;
  const capture = async (pin: PinnedCard, o: CaptureOptions): Promise<Capture> => {
    calls.push({ card: pin.card.id, rev: pin.rev, signal: o.signal });
    running++;
    most = Math.max(most, running);
    try {
      await (gates.get(pin.rev) ?? Promise.resolve());
      return { width: 1280, height: 100, tiles: [PNG1], tileHeight: 2048, thumb: PNG1, marks: [], verdicts: [] };
    } finally {
      running--;
    }
  };
  return { capture, calls, gates, most: () => most };
}

// ---- The queue, the cache and their order (no browser needed) ----

test('changes are debounced per card, run a few at a time, and the queue gives way when full', async (t) => {
  const fake = fakeCapture();
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const { apply, floor, pins } = rig(t, { capture: fake.capture, debounceMs: 30, concurrency: 1, maxQueue: 2 });
  apply('agent', page('a', '<p>a</p>'));
  // Revision 6 is the last of the five changes below.
  fake.gates.set(6, gate);
  for (let i = 0; i < 5; i++) apply('owner', { op: 'state.set', card: 'a', path: ['n'], value: i });
  await waitFor(() => fake.calls.length === 1 || undefined, 'the first render');
  assert.equal(fake.calls[0].rev, 6, 'five quick changes made one render, of the last of them');

  // While it runs, three more cards change: one runs at a time, the queue holds two.
  apply('agent', page('b', '<p>b</p>'));
  apply('agent', page('c', '<p>c</p>'));
  apply('agent', page('d', '<p>d</p>'));
  await delay(120);
  assert.match(floor.latest('b').error?.message ?? '', /more than 2 cards waiting/, 'the oldest waiting card gave way');
  open();
  await waitFor(() => floor.latest('d').image && floor.latest('c').image, 'the queued cards');
  assert.equal(fake.most(), 1, 'one at a time');
  assert.equal(floor.latest('b').image, undefined);
  await waitFor(() => pins.every((p) => p.released) || undefined, 'every pin released');
});

test('a slow old render never overwrites a newer image, and a read gets its own snapshot', async (t) => {
  const fake = fakeCapture();
  const { store, apply, floor, rendered } = rig(t, { capture: fake.capture, debounceMs: 10_000 });
  apply('agent', page('a', '<p>a</p>'));
  let slowDone!: () => void;
  fake.gates.set(
    1,
    new Promise<void>((r) => {
      slowDone = r;
    }),
  );
  const old = store.pin('a')!;
  const slow = floor.render(old, { timeoutMs: 10_000 });
  apply('owner', { op: 'state.set', card: 'a', path: ['x'], value: 1 });
  const fresh = store.pin('a')!;
  const quick = await floor.render(fresh, { timeoutMs: 10_000 });
  assert.equal(quick.ok && quick.image.rev, 2);
  slowDone();
  const late = await slow;
  assert.equal(late.ok && late.image.rev, 1, 'the read still gets the image of its own snapshot');
  assert.equal(floor.latest('a').image?.rev, 2, 'the newer image stays the latest');
  old.release();
  fresh.release();

  // An exact key match is answered from the cache, with no render.
  const again = store.pin('a')!;
  const calls = fake.calls.length;
  const cached = await floor.render(again, { timeoutMs: 1000 });
  again.release();
  assert.equal(cached.ok && cached.image.rev, 2);
  assert.equal(fake.calls.length, calls);
  assert.deepEqual(renderInfo(floor, store.board.cards[0], 'a'), { rev: 2, at: floor.latest('a').image!.at, current: true });
  assert.ok(rendered.includes('a'));
});

test('a render that times out keeps the last good image, records the error and stops its capture', async (t) => {
  const fake = fakeCapture();
  const { store, apply, floor } = rig(t, { capture: fake.capture, debounceMs: 10_000 });
  apply('agent', page('a', '<p>a</p>'));
  const one = store.pin('a')!;
  assert.equal((await floor.render(one, { timeoutMs: 5000 })).ok, true);
  one.release();
  apply('owner', { op: 'state.set', card: 'a', path: ['x'], value: 1 });
  fake.gates.set(2, new Promise(() => {}));
  const two = store.pin('a')!;
  const out = await floor.render(two, { timeoutMs: 1000 });
  two.release();
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : '', /didn't finish rendering within 1 s.*last good image is kept/);
  assert.equal(fake.calls.at(-1)?.signal.aborted, true, 'the capture was told to stop');
  const latest = floor.latest('a');
  assert.equal(latest.image?.rev, 1);
  assert.equal(latest.error?.rev, 2);
  assert.equal(renderInfo(floor, store.board.cards[0], 'a')?.current, false);
  assert.match(renderInfo(floor, store.board.cards[0], 'a')?.error ?? '', /didn't finish/);
});

test("a render's verdict on detached marks goes to the board, only while the card still looks like it", async (t) => {
  let verdict = true;
  const capture = async (pin: PinnedCard): Promise<Capture> => ({
    width: 1280,
    height: 100,
    tiles: [PNG1],
    tileHeight: 2048,
    marks: [],
    verdicts: pin.card.stickies.map((s) => ({ id: s.id, detached: verdict })),
  });
  const { store, apply, floor } = rig(t, { capture, debounceMs: 10_000 });
  apply('agent', page('a', '<p id="x">a</p>'), { op: 'sticky.add', card: 'a', id: 's1', anchor: { kind: 'element', selector: '#gone', offset: { x: 0, y: 0 }, point: { x: 5, y: 5 } }, text: 'hi' });
  const rev = store.board.rev;
  const p = store.pin('a')!;
  await floor.render(p, { timeoutMs: 5000 });
  assert.equal(store.board.cards[0].stickies[0].detached, true);
  assert.equal(store.board.rev, rev + 1, 'one marks.resolve batch');
  // The same verdict again changes nothing.
  const p2 = store.pin('a')!;
  await floor.render(p2, { timeoutMs: 5000 });
  assert.equal(store.board.rev, rev + 1);
  // A verdict on an older snapshot of a card that changed since is dropped.
  verdict = false;
  apply('owner', { op: 'state.set', card: 'a', path: ['x'], value: 1 });
  await floor.render(p, { timeoutMs: 5000 });
  assert.equal(store.board.cards[0].stickies[0].detached, true);
  p.release();
  p2.release();
  assert.equal(store.resolveMarks('nope', p.key, [{ id: 's1', detached: false }]), undefined);
});

test('forget drops a deleted card, and a stopped floor renders nothing more', async (t) => {
  const fake = fakeCapture();
  const { store, apply, floor } = rig(t, { capture: fake.capture, debounceMs: 20 });
  apply('agent', page('a', '<p>a</p>'));
  await waitFor(() => floor.latest('a').image, 'the first image');
  apply('owner', { op: 'card.rm', card: 'a' });
  assert.deepEqual(floor.latest('a'), {});
  apply('agent', page('b', '<p>b</p>'));
  store.stop();
  await delay(80);
  assert.equal(
    fake.calls.some((c) => c.card === 'b'),
    false,
  );
  const p = store.pin('b')!;
  assert.deepEqual(await floor.render(p, { timeoutMs: 1000 }), { ok: false, error: 'This floor is closing' });
  p.release();
});

// ---- Status: a missing browser, its download, a launch that fails ----

test('without the browser and with downloads off, renders say how to install it and never throw', async (t) => {
  const { store, apply, engine, floor } = rig(t, { download: false, browserStatus: () => ({ installed: false, path: '/x', revision: '1' }), debounceMs: 10 });
  const s = engine.status();
  assert.equal(s.available, false);
  assert.match(s.reason ?? '', /droid-office browser install/);
  apply('agent', page('a', '<p>a</p>'));
  const read = await readBoard(store, 'w2', FLOOR, { png: true, timeoutMs: 2000 });
  assert.equal(read.cards[0].png?.ok, false);
  assert.match(read.cards[0].png && !read.cards[0].png.ok ? read.cards[0].png.error : '', /droid-office browser install/);
  const p = store.pin('a')!;
  const out = await floor.render(p, { timeoutMs: 2000 });
  p.release();
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error : '', /not downloaded|isn't downloaded/);
  await waitFor(() => floor.latest('a').error, 'the background render to record the failure');
});

test('the first render downloads the browser with progress in the status, and a failed download is reported, not retried at once', async (t) => {
  let installed = false;
  let ensures = 0;
  let fail = false;
  const launched = { version: () => '1' };
  const { store, apply, engine, statuses, floor } = rig(t, {
    browserStatus: () => ({ installed, path: '/x', revision: '1' }),
    ensure: async ({ onProgress } = {}) => {
      ensures++;
      onProgress?.({ phase: 'downloading', percent: 10, message: 'Downloading Chromium: 10% of 100 MiB' });
      await delay(30);
      onProgress?.({ phase: 'downloading', percent: 60, message: 'Downloading Chromium: 60% of 100 MiB' });
      await delay(30);
      if (fail) throw new BrowserError({ kind: 'download-failed', summary: "Chromium couldn't be downloaded.", fix: 'Check your network, then try again with: droid-office browser install', detail: 'ENOTFOUND' });
      installed = true;
    },
    launch: async () => launched as never,
    capture: async () => ({ width: 1280, height: 10, tiles: [PNG1], tileHeight: 2048, marks: [], verdicts: [] }),
    debounceMs: 10,
  });
  assert.equal(engine.status().available, true, 'a stand-in capture needs no browser');
  apply('agent', page('a', '<p>a</p>'));
  await waitFor(() => floor.latest('a').image, 'the render after the download');
  assert.equal(ensures, 1);
  const progress = statuses.filter((s) => s.installing).map((s) => s.installing?.percent);
  assert.deepEqual(progress, [undefined, 10, 60]);
  assert.equal(statuses.at(-1)?.available, true);

  // A download that fails: the status says why and how to fix it, and the next render doesn't start another.
  installed = false;
  fail = true;
  apply('owner', { op: 'state.set', card: 'a', path: ['x'], value: 1 });
  await waitFor(() => statuses.at(-1)?.reason?.includes("couldn't be downloaded") || undefined, 'the failed download in the status');
  assert.match(engine.status().reason ?? '', /droid-office browser install/);
  assert.match(floor.latest('a').error?.message ?? '', /couldn't be downloaded/);
  apply('owner', { op: 'state.set', card: 'a', path: ['x'], value: 2 });
  const p = store.pin('a')!;
  const out = await floor.render(p, { timeoutMs: 2000 });
  p.release();
  assert.equal(out.ok, false);
  assert.equal(ensures, 2, 'no new download within the retry window');
});

test("a browser that can't start is reported with its fix, and the status recovers once it starts", async (t) => {
  let broken = true;
  const { store, apply, engine, floor, statuses } = rig(t, {
    browserStatus: () => ({ installed: true, path: '/x', revision: '1' }),
    launch: async () => {
      if (broken) throw new BrowserError({ kind: 'missing-libraries', summary: 'Chromium needs system libraries this machine does not have.', fix: 'With admin rights, install them.', detail: 'libnss3.so' });
      // Started, but not a browser a capture can use.
      return {} as never;
    },
    debounceMs: 10,
  });
  assert.equal(engine.status().available, true);
  apply('agent', page('a', '<p>a</p>'));
  await waitFor(() => statuses.find((s) => !s.available && /system libraries/.test(s.reason ?? '')), 'the launch failure in the status');
  assert.match(engine.status().reason ?? '', /install them/);
  await waitFor(() => floor.latest('a').error?.message.includes('system libraries') || undefined, "the card's error");
  broken = false;
  const p = store.pin('a')!;
  const out = await floor.render(p, { timeoutMs: 2000 });
  p.release();
  assert.equal(out.ok, false, 'the capture itself failed, as an outcome');
  assert.match(!out.ok ? out.error : '', /couldn't be rendered/);
  assert.equal(engine.status().available, true, 'the launch worked, so renders are available again');
  assert.equal(statuses.at(-1)?.available, true);
});

// ---- The real thing ----

const real = browserStatus();
const skip = real.installed ? false : `Chromium isn't downloaded in ${real.path}; run "node bin/droid-office.js browser install" to run this test`;
after(closeBrowser);

/** The colors at points of a PNG, read back by the browser itself. */
async function pixels(png: Buffer, points: [number, number][]): Promise<number[][]> {
  const browser = await launchBrowser();
  const context = await newIsolatedContext(browser);
  try {
    const p = await context.newPage();
    return await p.evaluate(
      async ([b64, pts]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d') as CanvasRenderingContext2D;
        g.drawImage(img, 0, 0);
        return (pts as [number, number][]).map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3));
      },
      [png.toString('base64'), points] as const,
    );
  } finally {
    await context.close();
  }
}

const size = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });
const near = (got: number[], want: number[], tol = 12) => got.every((v, i) => Math.abs(v - want[i]) <= tol);
const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));

/** A solid-color PNG, for pictures and page images. */
function solidPng(w: number, h: number, [r, g, b]: number[]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A local server whose `/slow?ms=` answers late, for pages that take a while to settle. */
async function slowServer(t: { after(fn: () => unknown): void }) {
  const server = http.createServer((req, res) => {
    const ms = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('ms')) || 0;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
      res.end(solidPng(4, 4, [0, 0, 0]));
    }, ms);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('a tall page renders in tiles up to the cap, with a half-size thumbnail of its top', { skip, timeout: 90_000 }, async (t) => {
  const { store, apply, floor } = rig(t, { download: false, debounceMs: 60_000, tileHeight: 1024, maxTiles: 3 });
  apply('agent', page('tall', '<!doctype html><body style="margin:0"><div style="height:5000px;background:linear-gradient(#f00,#00f)"></div></body>'));
  apply('agent', page('short', '<!doctype html><body style="margin:0;background:rgb(0,160,0)"><p>short</p></body>'));
  const p = store.pin('tall')!;
  const out = await floor.render(p, { timeoutMs: 60_000 });
  p.release();
  assert.equal(out.ok, true, !out.ok ? out.error : '');
  if (!out.ok) return;
  const img = out.image;
  assert.equal(img.width, 1280);
  assert.ok(img.height >= 5000, `height ${img.height}`);
  assert.equal(img.tiles.length, 3);
  assert.equal(img.tileHeight, 1024);
  assert.deepEqual(img.capped, { capPx: 3072 });
  for (const tile of img.tiles) assert.deepEqual(size(tile), { w: 1280, h: 1024 });
  assert.deepEqual(size(img.thumb!), { w: THUMB_WIDTH, h: 400 });
  // Each tile is the next slice of the page: the gradient gets bluer down the tiles.
  const [top] = await pixels(img.tiles[0], [[10, 10]]);
  const [low] = await pixels(img.tiles[2], [[10, 1000]]);
  assert.ok(top[0] > 230 && top[2] < 25, `top ${top}`);
  assert.ok(low[2] > top[2] + 100, `tile 3 ${low}`);

  // A short page is one frame-tall tile.
  const s = store.pin('short')!;
  const short = await floor.render(s, { timeoutMs: 60_000 });
  s.release();
  assert.equal(short.ok && short.image.tiles.length, 1);
  assert.deepEqual(short.ok && size(short.image.tiles[0]), { w: 1280, h: 800 });
  assert.equal(short.ok && short.image.capped, undefined);
});

test('marks are drawn where the SDK locates their anchors, plus their box offsets', { skip, timeout: 90_000 }, async (t) => {
  const { store, apply, floor } = rig(t, { download: false, debounceMs: 60_000 });
  const html = `<!doctype html><body style="margin:0;background:#fff">
    <div data-wb-id="box" style="position:absolute;left:200px;top:300px;width:400px;height:300px;background:rgb(0,0,0)"></div>
    <p id="moved" style="position:absolute;left:900px;top:1200px">Pricing table</p>
    <div style="height:1600px"></div></body>`;
  const picture = solidPng(60, 40, [0, 200, 200]);
  const ref = store.stage(picture, 'image/png');
  apply(
    'agent',
    page('a', html),
    { op: 'sticky.add', card: 'a', id: 's1', anchor: { kind: 'element', wbId: 'box', offset: { x: 10, y: 20 }, point: { x: 210, y: 320 } }, box: { x: 30, y: 40, w: 120, h: 80 }, text: 'Too dark', color: 'green' },
    { op: 'picture.add', card: 'a', id: 'p1', file: ref, anchor: { kind: 'point', point: { x: 700, y: 100 } }, box: { x: 0, y: 0, w: 60, h: 40 } },
    { op: 'comment.add', card: 'a', thread: 't1', message: 'm1', anchor: { kind: 'element', selector: 'p:nth-of-type(9)', quote: 'Pricing table', offset: { x: 5, y: 5 }, point: { x: 10, y: 10 } }, text: 'here' },
    { op: 'comment.add', card: 'a', thread: 't2', message: 'm2', anchor: { kind: 'element', wbId: 'nowhere', offset: { x: 0, y: 0 }, point: { x: 1000, y: 700 } }, text: 'lost' },
  );
  const p = store.pin('a')!;
  const out = await floor.render(p, { timeoutMs: 60_000 });
  p.release();
  assert.equal(out.ok, true, !out.ok ? out.error : '');
  if (!out.ok) return;
  const byId = Object.fromEntries((out.image.marks ?? []).map((m) => [m.id, m]));
  // The element's top-left (200, 300) + the anchor's offset (10, 20) + the box's offset (30, 40).
  assert.deepEqual(byId.s1, { id: 's1', kind: 'sticky', x: 240, y: 360, w: 120, h: 80, detached: false });
  assert.deepEqual(byId.p1, { id: 'p1', kind: 'picture', x: 700, y: 100, w: 60, h: 40, detached: false });
  // Found again by its text quote: the paragraph's top-left plus the offset.
  assert.equal(byId.t1.detached, false);
  assert.equal(byId.t1.x, 905);
  assert.ok(byId.t1.y > 1200 && byId.t1.y < 1240, `t1 at ${byId.t1.y}`);
  // Not found: drawn at its own point, and the board learns it is detached.
  assert.deepEqual(byId.t2, { id: 't2', kind: 'thread', x: 1000, y: 700, detached: true });
  await waitFor(() => store.board.cards[0].threads.find((x) => x.id === 't2')?.detached, 'marks.resolve');

  const tile = out.image.tiles[0];
  const [sticky, box, pic, pin, lost] = await pixels(tile, [
    [300, 420],
    [220, 330],
    [730, 120],
    // Beside the pin's number, which is white.
    [byId.t1.x - 9, byId.t1.y],
    [991, 700],
  ]);
  assert.ok(near(sticky, hex(STICKY_COLORS.green)), `sticky ${sticky}`);
  assert.ok(near(box, [0, 0, 0]), `box ${box}`);
  assert.ok(near(pic, [0, 200, 200]), `picture ${pic}`);
  assert.ok(near(pin, [0xef, 0x6f, 0x2e], 20), `pin ${pin}`);
  assert.ok(!near(lost, [255, 255, 255], 5), `detached pin ${lost}`);
});

test('a canvas card renders at the bounds of its marks plus a margin', { skip, timeout: 90_000 }, async (t) => {
  const { store, apply, floor } = rig(t, { download: false, debounceMs: 60_000 });
  apply(
    'owner',
    { op: 'card.create', card: 'c', kind: 'canvas', title: 'Sketch' },
    { op: 'sticky.add', card: 'c', id: 's1', anchor: { kind: 'point', point: { x: 100, y: 100 } }, box: { w: 200, h: 160 }, color: 'pink', text: 'one' },
    { op: 'sticky.add', card: 'c', id: 's2', anchor: { kind: 'point', point: { x: 600, y: 400 } }, box: { w: 200, h: 160 }, color: 'blue', text: 'two' },
  );
  const plan = canvasPlan(store.board.cards[0]);
  assert.deepEqual({ x: plan.x, y: plan.y, w: plan.w, h: plan.h }, { x: 100 - CANVAS_MARGIN, y: 100 - CANVAS_MARGIN, w: 700 + 2 * CANVAS_MARGIN, h: 460 + 2 * CANVAS_MARGIN });
  const p = store.pin('c')!;
  const out = await floor.render(p, { timeoutMs: 60_000 });
  p.release();
  assert.equal(out.ok, true, !out.ok ? out.error : '');
  if (!out.ok) return;
  assert.deepEqual({ w: out.image.width, h: out.image.height, origin: out.image.origin }, { w: plan.w, h: plan.h, origin: { x: 52, y: 52 } });
  assert.deepEqual(size(out.image.tiles[0]), { w: plan.w, h: plan.h });
  const [one, two, gap] = await pixels(out.image.tiles[0], [
    [CANVAS_MARGIN + 100, CANVAS_MARGIN + 120],
    [CANVAS_MARGIN + 600, CANVAS_MARGIN + 400],
    [CANVAS_MARGIN + 350, CANVAS_MARGIN + 20],
  ]);
  assert.ok(near(one, hex(STICKY_COLORS.pink)), `one ${one}`);
  assert.ok(near(two, hex(STICKY_COLORS.blue)), `two ${two}`);
  assert.ok(near(gap, [0xf7, 0xf6, 0xf2], 30), `gap ${gap}`);
  // An empty canvas is one blank frame.
  assert.deepEqual(canvasPlan({ ...store.board.cards[0], stickies: [] }), { x: 0, y: 0, w: 1280, h: 800, scale: 1, marks: [] });
});

test('a page that never settles is captured at the settle limit; one that hangs times out and keeps the last good image', { skip, timeout: 90_000 }, async (t) => {
  const { store, apply, floor } = rig(t, { download: false, debounceMs: 60_000, settleMs: 1500 });
  apply(
    'agent',
    page(
      'clock',
      `<!doctype html><body style="margin:0"><div id="b" style="height:900px;background:rgb(200,0,0)"></div><span id="t"></span>
      <script>setInterval(function () { document.getElementById('t').textContent = Date.now(); }, 40);
      whiteboard.on('state', function (s) { if (s.spin) { var end = Date.now() + 600000; while (Date.now() < end) {} } });</script></body>`,
    ),
  );
  const one = store.pin('clock')!;
  const started = Date.now();
  const first = await floor.render(one, { timeoutMs: 30_000 });
  one.release();
  assert.equal(first.ok, true, !first.ok ? first.error : '');
  assert.ok(Date.now() - started < 15_000);
  apply('owner', { op: 'state.set', card: 'clock', path: ['spin'], value: true });
  const two = store.pin('clock')!;
  const hung = await floor.render(two, { timeoutMs: 4000 });
  two.release();
  assert.equal(hung.ok, false);
  assert.match(!hung.ok ? hung.error : '', /didn't finish rendering/);
  assert.equal(floor.latest('clock').image?.rev, first.ok ? first.image.rev : -1);
  assert.equal(floor.latest('clock').error?.rev, store.board.rev);
});

test('a --png read is of its own snapshot while the card keeps changing, even through an update and a deletion', { skip, timeout: 90_000 }, async (t) => {
  const { root, store, apply, pins } = rig(t, { download: false, debounceMs: 60_000 });
  const slow = await slowServer(t);
  const colorPage = '<!doctype html><body style="margin:0"><div id="b" style="height:800px"></div><script>whiteboard.on("state", function (s) { document.getElementById("b").style.background = s.color || "#000"; });</script></body>';
  apply('agent', page('a', colorPage), { op: 'state.set', card: 'a', path: ['color'], value: 'rgb(255,0,0)' });
  let n = 0;
  const colors = ['rgb(0,0,255)', 'rgb(0,255,0)'];
  const timer = setInterval(() => apply('owner', { op: 'state.set', card: 'a', path: ['color'], value: colors[n++ % 2] }), 40);
  const read = await readBoard(store, 'w2', FLOOR, { cards: ['a'], png: true, timeoutMs: 30_000 });
  clearInterval(timer);
  const png = read.cards[0].png;
  assert.equal(png?.ok, true, png && !png.ok ? png.error : '');
  if (!png?.ok) return;
  assert.equal(png.rev, read.rev, 'the image is of the read snapshot');
  assert.equal(png.current, false, 'and the card has changed since');
  const [px] = await pixels(Buffer.from(png.tiles[0], 'base64'), [[50, 50]]);
  assert.ok(near(px, [255, 0, 0]), `snapshot color ${px}`);

  // A package whose stylesheet is only fetched late, while a slow image holds the page up.
  const dir = (name: string, color: string) => {
    const d = path.join(root, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'style.css'), `#b { background: ${color}; }`);
    writeFileSync(
      path.join(d, 'index.html'),
      `<!doctype html><body style="margin:0"><div id="b" style="height:800px"></div><img src="${slow}/slow?ms=1500" width="4" height="4">
      <script>setTimeout(function () { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'style.css'; document.head.appendChild(l); }, 700);</script></body>`,
    );
    return d;
  };
  apply('agent', { op: 'card.create', card: 'pkg', kind: 'html', title: 'pkg', content: { load: { dir: dir('v1', 'rgb(0,128,0)') } } } as unknown as Op);
  const reading = readBoard(store, 'w2', FLOOR, { cards: ['pkg'], png: true, timeoutMs: 30_000 });
  await delay(250);
  apply('agent', { op: 'card.content', card: 'pkg', content: { load: { dir: dir('v2', 'rgb(255,0,255)') } } } as unknown as Op);
  apply('owner', { op: 'card.rm', card: 'pkg' });
  const late = (await reading).cards[0].png;
  assert.equal(late?.ok, true, late && !late.ok ? late.error : '');
  if (!late?.ok) return;
  const [green] = await pixels(Buffer.from(late.tiles[0], 'base64'), [[50, 50]]);
  assert.ok(near(green, [0, 128, 0]), `the deleted card's snapshot ${green}`);
  assert.ok(
    pins.every((p) => p.released),
    'every pin was released',
  );
});

test('a linked page with relative images and CSS, and a --dir package with a module import and a fetch, render as they look', { skip, timeout: 90_000 }, async (t) => {
  const { root, store, apply, floor } = rig(t, { download: false, debounceMs: 60_000 });
  const site = path.join(root, 'site');
  mkdirSync(path.join(site, 'css'), { recursive: true });
  mkdirSync(path.join(site, 'img'), { recursive: true });
  writeFileSync(path.join(site, 'css', 'site.css'), 'body { margin: 0; background: rgb(0, 0, 200); } .pic { position: absolute; left: 400px; top: 100px; }');
  writeFileSync(path.join(site, 'img', 'dot.png'), solidPng(100, 100, [250, 200, 0]));
  writeFileSync(path.join(site, 'page.html'), '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><img class="pic" src="img/dot.png" width="100" height="100"></body></html>');
  apply('agent', { op: 'card.create', card: 'linked', kind: 'html', title: 'Linked', content: { load: { link: path.join(site, 'page.html') } } } as unknown as Op);

  const pkg = path.join(root, 'pkg');
  mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  writeFileSync(path.join(pkg, 'index.html'), '<!doctype html><body style="margin:0"><div id="a" style="height:300px"></div><div id="b" style="height:300px"></div><script type="module" src="./main.js"></script></body>');
  writeFileSync(
    path.join(pkg, 'main.js'),
    "import { color } from './lib/color.js';\ndocument.getElementById('a').style.background = color;\nconst data = await (await fetch('./data.json')).json();\ndocument.getElementById('b').style.background = data.color;\n",
  );
  writeFileSync(path.join(pkg, 'lib', 'color.js'), "export const color = 'rgb(0, 180, 90)';\n");
  writeFileSync(path.join(pkg, 'data.json'), '{"color": "rgb(150, 0, 150)"}');
  apply('agent', { op: 'card.create', card: 'pkg', kind: 'html', title: 'Package', content: { load: { dir: pkg } } } as unknown as Op);

  for (const [id, points, want] of [
    [
      'linked',
      [
        [10, 10],
        [450, 150],
      ],
      [
        [0, 0, 200],
        [250, 200, 0],
      ],
    ],
    [
      'pkg',
      [
        [10, 10],
        [10, 400],
      ],
      [
        [0, 180, 90],
        [150, 0, 150],
      ],
    ],
  ] as const) {
    const p = store.pin(id)!;
    const out = await floor.render(p, { timeoutMs: 60_000 });
    p.release();
    assert.equal(out.ok, true, !out.ok ? out.error : '');
    if (!out.ok) continue;
    const got = await pixels(out.image.tiles[0], points as unknown as [number, number][]);
    got.forEach((px, i) => assert.ok(near(px, want[i] as unknown as number[]), `${id} at ${points[i]}: ${px}, want ${want[i]}`));
  }
});
