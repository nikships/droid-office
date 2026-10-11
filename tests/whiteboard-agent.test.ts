import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OWNER, OWNER_AUTHOR, type Op } from '../src/shared/whiteboard.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { WhiteboardStore, type CardRenders, type PinnedCard, type RenderImage, type RenderOutcome, type WhiteboardRenderer } from '../src/server/whiteboard.js';
import { boardReaders, handleAgent, readBoard, workerAuthor, type CardOut } from '../src/server/whiteboard-agent.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WORKER = { id: 'w1', kind: 'agent', deskId: 'desk-1', name: 'Pixel', color: '#ff8800', status: 'idle' } as unknown as WorkerInfo;
const OTHER = { kind: 'worker', id: 'w2', name: 'Nibble', color: '#00ff88' } as const;
const FLOOR = { id: 'f1', name: 'Main' };

/** A renderer that renders on request, and can fail, answer for the wrong revision, or let the board move mid-render. */
class FakeRenderer implements WhiteboardRenderer {
  images = new Map<string, RenderImage>();
  mode: 'ok' | 'fail' | 'wrong' = 'ok';
  renders = 0;
  released = 0;
  during?: () => void;
  available = true;
  status() {
    return this.available ? { available: true } : { available: false, reason: 'no browser' };
  }
  async render(pin: PinnedCard): Promise<RenderOutcome> {
    this.renders++;
    const release = pin.release.bind(pin);
    (pin as { release: () => void }).release = () => {
      this.released++;
      release();
    };
    this.during?.();
    if (this.mode === 'fail') return { ok: false, error: 'the page crashed' };
    const key = this.mode === 'wrong' ? { ...pin.key, content: pin.key.content + 1 } : pin.key;
    const image: RenderImage = { key, rev: pin.rev, at: Date.now() - 5, width: 1280, height: 40, tiles: [PNG, PNG], tileHeight: 20, capped: { capPx: 40 } };
    if (this.mode === 'ok') this.images.set(pin.card.id, image);
    return { ok: true, image };
  }
  changed() {}
  latest(cardId: string): CardRenders {
    const image = this.images.get(cardId);
    return image ? { image } : {};
  }
  forget(cardId: string) {
    this.images.delete(cardId);
  }
  stop() {}
}

function rig(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-wb-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const renderer = new FakeRenderer();
  const store = new WhiteboardStore(root, { renderer });
  t.after(() => store.stop());
  const epoch = store.issueEpoch();
  let seq = 0;
  const owner = (...ops: Op[]) => {
    const r = store.apply({ epoch, seq: ++seq, ops }, OWNER_AUTHOR, 'window');
    assert.equal(r.kind, 'ack', JSON.stringify(r));
  };
  /** Another worker pushes pages (content loads are for agents). */
  const push = (...ops: Op[]) => {
    const r = store.apply({ epoch, seq: ++seq, ops }, OTHER, 'agent');
    assert.equal(r.kind, 'ack', JSON.stringify(r));
  };
  return { store, renderer, owner, push };
}

const page = (card: string, body: string): Op => ({ op: 'card.create', card, kind: 'html', title: card, content: { load: { html: body } } }) as unknown as Op;

test('a read inlines the page, names each file on disk, and says what someone else changed', async (t) => {
  const { store, owner, push } = rig(t);
  push(page('c1', '<h1>Plan</h1>'));
  owner({ op: 'state.set', card: 'c1', path: ['choice'], value: 'b' });
  const out = await readBoard(store, 'w1', FLOOR);
  const c = out.cards[0] as CardOut;
  assert.equal(c.content?.html?.includes('<h1>Plan</h1>'), true);
  const entry = c.content!.files[c.content!.entry];
  assert.equal(readFileSync(entry.file, 'utf8').includes('<h1>Plan</h1>'), true);
  assert.equal(c.changed, true);
  assert.equal(c.since, 0);
  assert.deepEqual(out.returned, ['c1']);
  assert.equal(c.png, undefined, 'no images unless asked');

  // Named cards: one on the board, one that never was.
  const named = await readBoard(store, 'w1', FLOOR, { cards: ['c1', 'c1', 'nope'] });
  assert.deepEqual(
    named.cards.map((x) => x.id),
    ['c1'],
  );
  assert.deepEqual(named.unknown, ['nope']);
});

test('a read with png renders that snapshot, or uses the latest image when it shows exactly that snapshot', async (t) => {
  const { store, renderer, owner, push } = rig(t);
  push(page('c1', '<p>one</p>'));
  const first = (await readBoard(store, 'w1', FLOOR, { png: true })).cards[0].png;
  assert.equal(first?.ok, true);
  if (!first?.ok) return;
  assert.equal(first.cached, false);
  assert.equal(first.current, true);
  assert.equal(first.tiles.length, 2);
  assert.equal(Buffer.from(first.tiles[0], 'base64').equals(PNG), true);
  assert.deepEqual(first.capped, { capPx: 40 });
  assert.equal(renderer.released, 1, 'the snapshot is released after the read');

  const again = (await readBoard(store, 'w1', FLOOR, { png: true })).cards[0].png;
  assert.equal(again?.ok && again.cached, true);
  assert.equal(renderer.renders, 1, 'not rendered twice');

  // The owner changes the card while it renders: the image is of the read's snapshot, and says it's not current.
  renderer.images.clear();
  renderer.during = () => owner({ op: 'state.set', card: 'c1', path: ['x'], value: 1 });
  const moved = (await readBoard(store, 'w1', FLOOR, { png: true })).cards[0].png;
  renderer.during = undefined;
  assert.equal(moved?.ok, true);
  assert.equal(moved?.ok && moved.current, false);
});

test("a read's png says why there's no image: no renderer, a failed render, or an image of another revision", async (t) => {
  const { store, renderer, owner, push } = rig(t);
  push(page('c1', '<p>one</p>'));
  renderer.available = false;
  const none = (await readBoard(store, 'w1', FLOOR, { png: true })).cards[0].png;
  assert.deepEqual(none, { ok: false, error: 'no browser' });

  renderer.available = true;
  renderer.mode = 'fail';
  const failed = (await readBoard(store, 'w1', FLOOR, { png: true })).cards[0].png;
  assert.deepEqual(failed, { ok: false, error: 'the page crashed' });

  // An older image is kept as `last` when a new render fails.
  renderer.mode = 'ok';
  await readBoard(store, 'w1', FLOOR, { png: true });
  owner({ op: 'state.set', card: 'c1', path: ['x'], value: 1 });
  renderer.mode = 'wrong';
  const wrong = (await readBoard(store, 'w1', FLOOR, { png: true })).cards[0].png;
  assert.equal(wrong?.ok, false);
  assert.match(wrong && !wrong.ok ? wrong.error : '', /different revision/);
  assert.equal(wrong && !wrong.ok ? wrong.last?.current : undefined, false);
});

test('the agent route: hello, read, apply, and what it refuses', async (t) => {
  const { store, owner } = rig(t);
  owner({ op: 'card.create', card: 'c1', kind: 'canvas', title: 'Sketch' });
  const hello = await handleAgent(store, WORKER, FLOOR, { action: 'hello' });
  assert.equal(hello.status, 200);
  const h = hello.body as { epoch: string; worker: { id: string }; rev: number; cards: number; renderer: { available: boolean } };
  assert.equal(h.worker.id, 'w1');
  assert.equal(h.rev, 1);
  assert.equal(h.cards, 1);
  assert.equal(h.renderer.available, true);

  assert.equal((await handleAgent(store, WORKER, FLOOR, { action: 'read', cards: 'c1' })).status, 400);
  const read = await handleAgent(store, WORKER, FLOOR, { action: 'read', cards: ['c1'], timeoutMs: 5 });
  assert.equal(read.status, 200);
  assert.deepEqual((read.body as { returned: string[] }).returned, ['c1']);

  const ok = await handleAgent(store, WORKER, FLOOR, { action: 'apply', envelope: { epoch: h.epoch, seq: 1, ops: [{ op: 'card.title', card: 'c1', title: 'New' }] } });
  assert.deepEqual(ok, { status: 200, body: { ok: true, rev: 2 } });
  const dup = await handleAgent(store, WORKER, FLOOR, { action: 'apply', envelope: { epoch: h.epoch, seq: 1, ops: [{ op: 'card.title', card: 'c1', title: 'New' }] } });
  assert.deepEqual(dup, { status: 200, body: { ok: true, rev: 2, duplicate: true } });
  const bad = await handleAgent(store, WORKER, FLOOR, { action: 'apply', envelope: { epoch: h.epoch, seq: 2, ops: [{ op: 'card.title', card: 'gone', title: 'x' }] } });
  assert.equal(bad.status, 422);
  const expired = await handleAgent(store, WORKER, FLOOR, { action: 'apply', envelope: { epoch: 'not-an-epoch', seq: 1, ops: [] } });
  assert.equal(expired.status, 409);
  assert.equal((expired.body as { reason: string }).reason, 'expired');
  assert.equal((await handleAgent(store, WORKER, FLOOR, { action: 'apply', envelope: 'x' })).status, 400);
  assert.equal((await handleAgent(store, WORKER, FLOOR, null)).status, 400);

  assert.deepEqual(workerAuthor(WORKER), { kind: 'worker', id: 'w1', name: 'Pixel', color: '#ff8800' });
  assert.deepEqual(boardReaders([WORKER]), [OWNER, 'w1']);
});
