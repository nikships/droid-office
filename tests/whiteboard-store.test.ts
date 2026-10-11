import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_HTML_BYTES, OWNER, OWNER_AUTHOR, findCard, type Author, type Op } from '../src/shared/whiteboard.js';
import { CARD_HEADERS, CARD_SANDBOX, NoRenderer, WhiteboardStore, cardResponse, injectSdk, renderStatus, type CrashPoint, type WhiteboardOptions } from '../src/server/whiteboard.js';
import { cssReferences, htmlReferences, imageSize, loadPackage, loadPage, pictureMime } from '../src/server/whiteboard-assets.js';
import { SDK_SCRIPT } from '../src/server/whiteboard-sdk.js';

const PIXEL: Author = { kind: 'worker', id: 'w1', name: 'Pixel', color: '#ff8800' };
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function dirs(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-wb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const work = path.join(root, 'work');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(work, { recursive: true });
  return { root, checkout, work };
}

function open(checkout: string, opts: WhiteboardOptions = {}) {
  return new WhiteboardStore(checkout, { linkPollMs: 40, linkDebounceMs: 20, ...opts });
}

const html = (card: string, body: string, title = 'Plan'): Op => ({ op: 'card.create', card, kind: 'html', title, content: { load: { html: body } } }) as unknown as Op;

async function waitFor(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every file the board names is on disk. */
function consistent(store: WhiteboardStore, checkout: string) {
  const blobs = new Set(readdirSync(path.join(checkout, '.droid-office', 'whiteboard', 'blobs')));
  for (const c of store.board.cards) {
    for (const f of Object.values(c.content?.files ?? {})) assert.ok(blobs.has(f.hash), `${c.id} names ${f.hash}`);
    for (const p of c.pictures) assert.ok(blobs.has(p.file.hash));
  }
}

test('a window batch applies once, a retry is acknowledged again, and the board survives a restart', (t) => {
  const { checkout } = dirs(t);
  const patches: unknown[] = [];
  const store = open(checkout, { onPatch: (p, info) => patches.push({ p, info }) });
  const epoch = store.issueEpoch();
  const env = { epoch, seq: 1, ops: [{ op: 'card.create', card: 'c1', kind: 'canvas', title: 'Sketch' } as Op] };
  assert.deepEqual(store.apply(env, OWNER_AUTHOR, 'window'), { kind: 'ack', rev: 1 });
  assert.equal(patches.length, 1);
  assert.deepEqual((patches[0] as { info: { origin: unknown } }).info.origin, { epoch, seq: 1 });
  assert.ok((patches[0] as { info: { caps: Record<string, string> } }).info.caps.c1, 'a new card comes with its capability');
  // The same batch again: acknowledged at its revision, not applied again.
  assert.deepEqual(store.apply(env, OWNER_AUTHOR, 'window'), { kind: 'ack', rev: 1, duplicate: true });
  assert.equal(store.board.rev, 1);
  assert.equal(patches.length, 1);
  // An older sequence number of the same epoch is a duplicate too.
  assert.equal(store.apply({ ...env, seq: 2, ops: [{ op: 'card.title', card: 'c1', title: 'Two' }] }, OWNER_AUTHOR, 'window').kind, 'ack');
  assert.deepEqual(store.apply({ ...env, seq: 1, ops: [{ op: 'card.title', card: 'c1', title: 'One' }] }, OWNER_AUTHOR, 'window'), { kind: 'ack', rev: 2, duplicate: true }, "acknowledged at the epoch's latest revision");
  const cap = store.cardCap('c1');
  store.stop();

  const again = open(checkout);
  assert.equal(again.board.rev, 2);
  assert.equal(findCard(again.board, 'c1')?.title, 'Two');
  assert.equal(again.cardCap('c1'), cap, 'capabilities are the same across restarts');
  assert.deepEqual(again.apply({ ...env, seq: 2, ops: [{ op: 'card.title', card: 'c1', title: 'Again' }] }, OWNER_AUTHOR, 'window'), { kind: 'ack', rev: 2, duplicate: true });
  again.stop();
});

test('an epoch the store did not sign, or one dropped from the record by age or count, is refused as expired', (t) => {
  const { checkout } = dirs(t);
  let now = 1_000_000;
  const store = open(checkout, { now: () => now, epochTtlMs: 10_000, epochMax: 2 });
  const create: Op = { op: 'card.create', card: 'c1', kind: 'canvas', title: 'A' };
  assert.deepEqual(store.apply({ epoch: 'made.up.aaaaaaaaaaaaaaaa', seq: 1, ops: [create] }, OWNER_AUTHOR, 'window'), { kind: 'rejected', reason: 'expired' });
  const a = store.issueEpoch();
  assert.equal(store.apply({ epoch: a, seq: 1, ops: [create] }, OWNER_AUTHOR, 'window').kind, 'ack');
  // Forged: a valid body with someone else's signature.
  assert.equal(store.apply({ epoch: `${a.slice(0, -1)}${a.endsWith('A') ? 'B' : 'A'}`, seq: 1, ops: [create] }, OWNER_AUTHOR, 'window').kind, 'rejected');

  // By age: A isn't heard from for longer than the TTL, so the record drops it at the next commit.
  now += 1;
  const b = store.issueEpoch();
  now += 20_000;
  assert.equal(store.apply({ epoch: b, seq: 1, ops: [{ op: 'card.title', card: 'c1', title: 'B' }] }, OWNER_AUTHOR, 'window').kind, 'ack');
  assert.deepEqual(store.apply({ epoch: a, seq: 1, ops: [create] }, OWNER_AUTHOR, 'window'), { kind: 'rejected', reason: 'expired' }, "a retry of A can't be proved new or old");
  assert.deepEqual(store.apply({ epoch: a, seq: 2, ops: [{ op: 'card.title', card: 'c1', title: 'A2' }] }, OWNER_AUTHOR, 'window'), { kind: 'rejected', reason: 'expired' });
  assert.equal(findCard(store.board, 'c1')?.title, 'B');

  // By count: at most two epochs; the least recently used goes, and with it every epoch issued before it.
  now += 1;
  const c = store.issueEpoch();
  now += 1;
  const d = store.issueEpoch();
  now += 1;
  const e = store.issueEpoch();
  for (const [ep, title] of [
    [c, 'C'],
    [d, 'D'],
    [e, 'E'],
  ])
    assert.equal(store.apply({ epoch: ep, seq: 1, ops: [{ op: 'card.title', card: 'c1', title }] }, OWNER_AUTHOR, 'window').kind, 'ack');
  assert.equal(store.apply({ epoch: b, seq: 1, ops: [] }, OWNER_AUTHOR, 'window').kind, 'rejected');
  assert.deepEqual(store.apply({ epoch: c, seq: 1, ops: [{ op: 'card.title', card: 'c1', title: 'C' }] }, OWNER_AUTHOR, 'window'), { kind: 'rejected', reason: 'expired' });
  assert.deepEqual(store.apply({ epoch: e, seq: 1, ops: [] }, OWNER_AUTHOR, 'window'), { kind: 'ack', rev: store.board.rev, duplicate: true });
  // D is one of the two the record keeps: its retry is still recognised.
  assert.equal((store.apply({ epoch: d, seq: 1, ops: [] }, OWNER_AUTHOR, 'window') as { duplicate?: true }).duplicate, true);
  // A fresh epoch, issued after the horizon, is new.
  now += 1;
  assert.equal(store.apply({ epoch: store.issueEpoch(), seq: 1, ops: [{ op: 'card.title', card: 'c1', title: 'F' }] }, OWNER_AUTHOR, 'window').kind, 'ack');
  store.stop();
});

for (const point of ['blobs', 'temp', 'rename'] as CrashPoint[]) {
  test(`killed at "${point}" in a commit, the office comes back to a consistent board, and the retry applies once`, (t) => {
    const { checkout } = dirs(t);
    const first = open(checkout);
    const epoch = first.issueEpoch();
    assert.equal(first.apply({ epoch, seq: 1, ops: [html('c1', '<h1>One</h1>')] }, PIXEL, 'agent').kind, 'ack');
    first.stop();

    let armed = true;
    const dying = open(checkout, {
      crash: (p) => {
        if (armed && p === point) {
          armed = false;
          throw new Error(`killed at ${p}`);
        }
      },
    });
    const update = { epoch, seq: 2, ops: [{ op: 'card.content', card: 'c1', content: { load: { html: '<h1>Two</h1>' } } } as unknown as Op] };
    assert.throws(() => dying.apply(update, PIXEL, 'agent'), new RegExp(`killed at ${point}`));
    dying.stop();

    const back = open(checkout);
    consistent(back, checkout);
    const page = () => {
      const c = findCard(back.board, 'c1')!;
      return back.readBlob(c.content!.files[c.content!.entry].hash)!.toString();
    };
    if (point === 'rename') {
      // Committed: the acknowledgement was what got lost. The retry is recognised.
      assert.match(page(), /Two/);
      assert.deepEqual(back.apply(update, PIXEL, 'agent'), { kind: 'ack', rev: 2, duplicate: true });
    } else {
      assert.match(page(), /One/);
      assert.equal(back.board.rev, 1);
      assert.deepEqual(back.apply(update, PIXEL, 'agent'), { kind: 'ack', rev: 2 });
      assert.match(page(), /Two/);
    }
    assert.equal(back.board.rev, 2);
    assert.ok(!existsSync(path.join(back.dir, 'board.json.tmp')));
    consistent(back, checkout);
    // The old page's blob is gone once nothing names it.
    assert.equal(readdirSync(path.join(back.dir, 'blobs')).length, 1);
    back.stop();
  });
}

test('a pinned snapshot keeps serving its files through an update and a deletion, and lets them go when released', (t) => {
  const { checkout } = dirs(t);
  const store = open(checkout);
  const epoch = store.issueEpoch();
  store.apply({ epoch, seq: 1, ops: [html('c1', '<p>first</p>')] }, PIXEL, 'agent');
  const pin = store.pin('c1')!;
  assert.ok(pin.entryUrl?.startsWith('/whiteboard/c/s'));
  const cap = pin.entryUrl!.split('/')[3];
  store.apply({ epoch, seq: 2, ops: [{ op: 'card.content', card: 'c1', content: { load: { html: '<p>second</p>' } } } as unknown as Op] }, PIXEL, 'agent');
  store.apply({ epoch, seq: 3, ops: [{ op: 'card.rm', card: 'c1' }] }, PIXEL, 'agent');
  assert.equal(store.board.cards.length, 0);
  const served = store.serve(cap, '');
  assert.equal(served?.status, 200);
  assert.match(served!.body.toString(), /first/);
  assert.equal(store.serve(store.cardCap('c1'), '')?.status, undefined, "the live card's capability reaches nothing now");
  assert.equal(readdirSync(path.join(store.dir, 'blobs')).length, 1, 'only the pinned page is left');
  pin.release();
  assert.equal(store.serve(cap, ''), undefined);
  store.prune();
  store.apply({ epoch, seq: 4, ops: [{ op: 'card.create', card: 'c2', kind: 'canvas', title: 'x' }] }, PIXEL, 'agent');
  assert.equal(readdirSync(path.join(store.dir, 'blobs')).length, 0);
  store.stop();
});

test('a staged upload waits for the batch that uses it, its size checked, and is collected after its lease', (t) => {
  const { checkout } = dirs(t);
  let now = 5_000;
  const store = open(checkout, { now: () => now });
  const ref = store.stage(PNG, 'image/png');
  const epoch = store.issueEpoch();
  store.apply({ epoch, seq: 1, ops: [{ op: 'card.create', card: 'c1', kind: 'canvas', title: 'Board' }] }, OWNER_AUTHOR, 'window');
  assert.ok(existsSync(store.blobFile(ref.hash)), 'kept while staged');
  const lie = store.apply({ epoch, seq: 2, ops: [{ op: 'picture.add', card: 'c1', id: 'p1', file: { ...ref, size: ref.size + 1 }, anchor: { kind: 'point', point: { x: 0, y: 0 } }, box: { w: 20, h: 20 } }] }, OWNER_AUTHOR, 'window');
  assert.equal(lie.kind, 'rejected');
  assert.match(lie.kind === 'rejected' && lie.reason === 'invalid' ? lie.error.message : '', /bytes, not/);
  const ghost = store.apply(
    { epoch, seq: 3, ops: [{ op: 'picture.add', card: 'c1', id: 'p1', file: { hash: 'a'.repeat(64), size: 1, mime: 'image/png' }, anchor: { kind: 'point', point: { x: 0, y: 0 } }, box: { w: 20, h: 20 } }] },
    OWNER_AUTHOR,
    'window',
  );
  assert.match(ghost.kind === 'rejected' && ghost.reason === 'invalid' ? ghost.error.message : '', /upload it first/);
  assert.equal(store.apply({ epoch, seq: 4, ops: [{ op: 'picture.add', card: 'c1', id: 'p1', file: ref, anchor: { kind: 'point', point: { x: 0, y: 0 } }, box: { w: 20, h: 20 } }] }, OWNER_AUTHOR, 'window').kind, 'ack');
  assert.equal(store.cardFile('c1', ref.hash)?.body.length, PNG.length);
  const other = store.stage(Buffer.from('GIF89a-not-used'), 'image/gif');
  now += 2 * 60 * 60 * 1000;
  store.apply({ epoch, seq: 5, ops: [{ op: 'card.title', card: 'c1', title: 'Later' }] }, OWNER_AUTHOR, 'window');
  assert.ok(!existsSync(store.blobFile(other.hash)), 'an upload nothing used is gone after its lease');
  assert.ok(existsSync(store.blobFile(ref.hash)));
  store.stop();
});

test('only the office makes links, prunes and forgets readers; a batch over a limit says the limit', (t) => {
  const { checkout } = dirs(t);
  const store = open(checkout);
  const epoch = store.issueEpoch();
  store.apply({ epoch, seq: 1, ops: [html('c1', '<p>x</p>')] }, PIXEL, 'agent');
  for (const op of [{ op: 'card.link', card: 'c1', link: null }, { op: 'prune' }, { op: 'reader.forget', reader: 'owner' }, { op: 'card.content', card: 'c1', content: { entry: 'index.html', files: {} }, viaLink: true }] as Op[]) {
    const r = store.apply({ epoch, seq: 2, ops: [op] }, OWNER_AUTHOR, 'window');
    assert.equal(r.kind, 'rejected', op.op);
    assert.match(r.kind === 'rejected' && r.reason === 'invalid' ? r.error.message : '', /only the office itself/);
  }
  const big = store.apply({ epoch, seq: 2, ops: [html('c2', `<p>${'x'.repeat(MAX_HTML_BYTES)}</p>`)] }, PIXEL, 'agent');
  assert.equal(big.kind, 'rejected');
  assert.match(big.kind === 'rejected' && big.reason === 'invalid' ? big.error.message : '', /2 MB/);
  // An expanded batch names the operation the agent sent.
  const late = store.apply({ epoch, seq: 3, ops: [{ op: 'card.title', card: 'c1', title: 'ok' }, { op: 'card.linkTo', card: 'c1', path: '/nope/missing.html' } as unknown as Op] }, PIXEL, 'agent');
  assert.equal(late.kind === 'rejected' && late.reason === 'invalid' && late.error.index, 1);
  const after = store.apply({ epoch, seq: 4, ops: [{ op: 'card.unlink', card: 'c1' } as unknown as Op, { op: 'card.title', card: 'nope', title: 'x' }] }, PIXEL, 'agent');
  assert.equal(after.kind === 'rejected' && after.reason === 'invalid' && after.error.index, 1);
  assert.match(after.kind === 'rejected' && after.reason === 'invalid' ? after.error.message : '', /^Operation 1 \(card\.title\)/);
  store.stop();
});

test('a dismissed reader stops holding tombstones, and pruning counts only the readers that matter', (t) => {
  const { checkout } = dirs(t);
  let readers = [OWNER, 'w1'];
  const store = open(checkout, { readers: () => readers });
  const epoch = store.issueEpoch();
  store.apply({ epoch, seq: 1, ops: [{ op: 'card.create', card: 'c1', kind: 'canvas', title: 'A' }] }, OWNER_AUTHOR, 'window');
  const agent = store.issueEpoch();
  store.apply({ epoch: agent, seq: 1, ops: [{ op: 'read', cards: ['c1'], rev: 1 }] }, PIXEL, 'agent');
  store.apply({ epoch, seq: 2, ops: [{ op: 'card.rm', card: 'c1' }] }, OWNER_AUTHOR, 'window');
  assert.equal(store.board.tombstones.length, 1, "Pixel hasn't seen the removal yet");
  readers = [OWNER];
  store.forgetReader('w1');
  assert.equal(store.board.reads.w1, undefined);
  assert.equal(store.board.tombstones.length, 0);
  store.stop();
});

test('links follow their file through edits, an atomic replace, a deletion and its return, and stop at unlink', async (t) => {
  const { checkout, work } = dirs(t);
  const store = open(checkout);
  t.after(() => store.stop());
  store.start();
  const page = path.join(work, 'plan.html');
  mkdirSync(path.join(work, 'img'));
  writeFileSync(path.join(work, 'img', 'a.png'), PNG);
  writeFileSync(path.join(work, 'style.css'), 'body { background: url("img/a.png") }');
  writeFileSync(page, '<link rel="stylesheet" href="style.css"><img src="img/a.png"><img src="../outside.png"><p>v1</p>');
  const epoch = store.issueEpoch();
  const r = store.apply({ epoch, seq: 1, ops: [{ op: 'card.create', card: 'c1', kind: 'html', title: 'Plan', content: { load: { link: page } } } as unknown as Op] }, PIXEL, 'agent');
  assert.equal(r.kind, 'ack');
  const card = () => findCard(store.board, 'c1')!;
  const text = () => store.serve(store.cardCap('c1'), '')!.body.toString();
  assert.deepEqual(Object.keys(card().content!.files).sort(), ['img/a.png', 'plan.html', 'style.css']);
  assert.equal(card().content!.entry, 'plan.html');
  assert.ok(card().content!.missing?.some((m) => m.ref === '../outside.png'));
  assert.equal(card().link?.status, 'ok');
  assert.equal(store.serve(store.cardCap('c1'), 'img/a.png')?.headers['content-type'], 'image/png');

  // An edit, and a stylesheet change (a collected asset).
  writeFileSync(page, '<link rel="stylesheet" href="style.css"><img src="img/a.png"><p>v2</p>');
  await waitFor(() => text().includes('v2'));
  assert.equal(card().stamps.content?.author.kind, 'worker', 'the update is authored by whoever linked it');
  writeFileSync(path.join(work, 'style.css'), 'body { color: red }');
  await waitFor(() => store.serve(store.cardCap('c1'), 'style.css')!.body.toString().includes('red'));

  // An atomic replace: write a temp file, rename it over.
  writeFileSync(path.join(work, '.plan.tmp'), '<p>v3</p>');
  renameSync(path.join(work, '.plan.tmp'), page);
  await waitFor(() => text().includes('v3'));

  // Deleted: the card keeps its content, and its link says why it's broken.
  rmSync(page);
  await waitFor(() => card().link?.status === 'broken');
  assert.match(card().link!.reason!, /plan\.html/);
  assert.match(text(), /v3/);
  // An update of a linked card's content is refused until unlink.
  const refused = store.apply({ epoch, seq: 2, ops: [{ op: 'card.content', card: 'c1', content: { load: { html: '<p>mine</p>' } } } as unknown as Op] }, PIXEL, 'agent');
  assert.match(refused.kind === 'rejected' && refused.reason === 'invalid' ? refused.error.message : '', /linked to .*unlink the card first/);

  // Back: it recovers by itself.
  writeFileSync(page, '<p>v4</p>');
  await waitFor(() => card().link?.status === 'ok' && text().includes('v4'));

  // Unlinked: the content stays, and the file no longer reaches the card.
  assert.equal(store.apply({ epoch, seq: 3, ops: [{ op: 'card.unlink', card: 'c1' } as unknown as Op] }, PIXEL, 'agent').kind, 'ack');
  assert.equal(card().link, undefined);
  writeFileSync(page, '<p>v5</p>');
  await new Promise((r) => setTimeout(r, 200));
  assert.match(text(), /v4/);
});

test('a link to a folder in a worktree that is deleted breaks and nothing more; the board restarts with its links', async (t) => {
  const { checkout, work } = dirs(t);
  const site = path.join(work, 'site');
  mkdirSync(path.join(site, 'js'), { recursive: true });
  writeFileSync(path.join(site, 'index.html'), '<script type="module" src="js/app.js"></script><p>site</p>');
  writeFileSync(path.join(site, 'js', 'app.js'), "import { n } from './n.js'; fetch('../data.json');");
  writeFileSync(path.join(site, 'js', 'n.js'), 'export const n = 1;');
  writeFileSync(path.join(site, 'data.json'), '{"a":1}');
  const store = open(checkout);
  store.start();
  const epoch = store.issueEpoch();
  assert.equal(store.apply({ epoch, seq: 1, ops: [html('c1', '<p>first</p>'), { op: 'card.linkTo', card: 'c1', path: site } as unknown as Op] }, PIXEL, 'agent').kind, 'ack');
  const card = () => findCard(store.board, 'c1')!;
  assert.equal(card().link?.dir, true);
  assert.deepEqual(Object.keys(card().content!.files).sort(), ['data.json', 'index.html', 'js/app.js', 'js/n.js']);
  assert.equal(store.serve(store.cardCap('c1'), 'data.json')?.headers['content-type'], 'application/json');
  writeFileSync(path.join(site, 'data.json'), '{"a":2}');
  await waitFor(() => store.serve(store.cardCap('c1'), 'data.json')!.body.toString().includes('2'));
  store.stop();

  // Changed while the office was down: picked up at start.
  writeFileSync(path.join(site, 'data.json'), '{"a":3}');
  const back = open(checkout);
  t.after(() => back.stop());
  back.start();
  await waitFor(() => back.serve(back.cardCap('c1'), 'data.json')!.body.toString().includes('3'));
  rmSync(work, { recursive: true, force: true });
  await waitFor(() => findCard(back.board, 'c1')!.link?.status === 'broken');
  assert.match(back.serve(back.cardCap('c1'), 'data.json')!.body.toString(), /3/);
});

test('loads: a page with its assets, a package, an image card and a picture from a file', (t) => {
  const { checkout, work } = dirs(t);
  writeFileSync(path.join(work, 'shot.png'), PNG);
  writeFileSync(path.join(work, 'page.html'), '<style>@import "a.css"; .x { background: url(shot.png) }</style><img srcset="shot.png 1x, gone.png 2x"><a href="https://example.com">x</a>');
  writeFileSync(path.join(work, 'a.css'), '.y { color: blue }');
  const store = open(checkout);
  const epoch = store.issueEpoch();
  const r = store.apply(
    {
      epoch,
      seq: 1,
      ops: [
        { op: 'card.create', card: 'c1', kind: 'html', title: 'Page', content: { load: { file: path.join(work, 'page.html') } } },
        { op: 'card.create', card: 'c2', kind: 'html', title: 'Shot', content: { load: { image: path.join(work, 'shot.png') } } },
        { op: 'card.create', card: 'c3', kind: 'canvas', title: 'Canvas' },
        { op: 'picture.add', card: 'c3', id: 'p1', file: { load: path.join(work, 'shot.png') }, anchor: { kind: 'point', point: { x: 5, y: 5 } } },
      ] as unknown as Op[],
    },
    PIXEL,
    'agent',
  );
  assert.equal(r.kind, 'ack', JSON.stringify(r));
  const c1 = findCard(store.board, 'c1')!;
  assert.deepEqual(Object.keys(c1.content!.files).sort(), ['a.css', 'page.html', 'shot.png']);
  assert.deepEqual(
    c1.content!.missing?.map((m) => m.ref),
    ['gone.png'],
  );
  const c2 = findCard(store.board, 'c2')!;
  assert.match(store.serve(store.cardCap('c2'), '')!.body.toString(), /data-wb-id="image"/);
  const pic = findCard(store.board, 'c3')!.pictures[0];
  assert.deepEqual([pic.box.w, pic.box.h], [16, 16], "a picture's size defaults to the image's own (at least 16 px)");
  assert.ok(c2.content!.files['image.png']);
  const bad = store.apply({ epoch, seq: 2, ops: [{ op: 'card.create', card: 'c4', kind: 'html', title: 'x', content: { load: { file: path.join(work, 'missing.html') } } } as unknown as Op] }, PIXEL, 'agent');
  assert.match(bad.kind === 'rejected' && bad.reason === 'invalid' ? bad.error.message : '', /^Operation 0 \(card\.create\) failed/);
  store.stop();
});

test('card answers: sandboxed, capability-scoped, SDK injected into the page only', (t) => {
  const { checkout } = dirs(t);
  const store = open(checkout);
  const epoch = store.issueEpoch();
  store.apply({ epoch, seq: 1, ops: [html('c1', '<!doctype html><html><head><title>t</title></head><body><script>1</script></body></html>'), html('c2', '<p>two</p>')] }, PIXEL, 'agent');
  const res = store.serve(store.cardCap('c1'), '')!;
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-security-policy'], `sandbox ${CARD_SANDBOX}`);
  assert.ok(!CARD_SANDBOX.includes('allow-same-origin'));
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(res.headers['permissions-policy'], /camera=\(\)/);
  const body = res.body.toString();
  assert.ok(body.indexOf('data-droid-office-whiteboard') < body.indexOf('<script>1'), 'the SDK runs before the page');
  assert.ok(body.startsWith('<!doctype html>'));
  // A card's capability reaches its own files only.
  const cap1 = store.cardCap('c1');
  const entry2 = findCard(store.board, 'c2')!.content!.entry;
  assert.equal(store.serve(cap1, entry2 === findCard(store.board, 'c1')!.content!.entry ? 'nope.html' : entry2)?.status, 404);
  assert.equal(store.serve('k'.padEnd(41, 'x'), ''), undefined);
  // Conditional and HEAD answers.
  const again = store.serve(cap1, '', { ifNoneMatch: res.headers.etag })!;
  assert.equal(again.status, 304);
  const head = store.serve(cap1, '', { method: 'HEAD' })!;
  assert.equal(head.body.length, 0);
  assert.equal(store.serve(cap1, '', { method: 'POST' })!.status, 405);
  assert.equal(cardResponse(undefined, '', () => undefined).status, 404);
  for (const v of Object.values(CARD_HEADERS)) assert.equal(typeof v, 'string');
  // Injection without a head, and a page that closes its own script tag in a string.
  assert.ok(injectSdk('<p>x</p>').startsWith('<script data-droid-office-whiteboard>'));
  assert.ok(!injectSdk('<p>x</p>', 'a("</script>")').includes('a("</script>")'));
  assert.ok(SDK_SCRIPT.includes('whiteboard'));
  store.stop();
});

test('without a renderer, every render status says why and nothing claims an image', (t) => {
  const { checkout } = dirs(t);
  const store = open(checkout);
  const r = new NoRenderer();
  assert.equal(r.status().available, false);
  assert.match(r.status().reason!, /renderer/);
  const s = renderStatus(store.renderer, undefined, 'c1');
  assert.equal(s.available, false);
  assert.equal(s.image, undefined);
  store.stop();
});

test('asset references in markup and CSS, and picture sniffing', () => {
  assert.deepEqual(htmlReferences('<img src="a.png" srcset="b.png 2x, c.png 3x"><link href="s.css"><script src="m.js"></script><div style="background:url(\'d.png\')"></div>').sort(), ['a.png', 'b.png', 'c.png', 'd.png', 'm.js', 's.css']);
  assert.deepEqual(cssReferences('@import "x.css"; @import url(y.css); .a { background: url(z.png) }').sort(), ['x.css', 'y.css', 'z.png']);
  assert.equal(pictureMime(PNG), 'image/png');
  assert.equal(pictureMime(Buffer.from('nope')), undefined);
  assert.deepEqual(imageSize(PNG), { w: 1, h: 1 });
});

test('a corrupt board.json is set aside and the board starts empty', (t) => {
  const { checkout } = dirs(t);
  const dir = path.join(checkout, '.droid-office', 'whiteboard');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'board.json'), '{nope');
  const err = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = err;
  });
  const store = open(checkout);
  assert.equal(store.board.rev, 0);
  assert.ok(readdirSync(dir).some((n) => n.startsWith('board.json.unreadable-')));
  store.stop();
  assert.ok(readFileSync(path.join(dir, 'key'), 'utf8').length === 64);
});

test('an unreadable key is kept aside, loudly, and a new one is made', (t) => {
  const { checkout } = dirs(t);
  const dir = path.join(checkout, '.droid-office', 'whiteboard');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'key'), 'not hex');
  const said: string[] = [];
  const err = console.error;
  console.error = (s: string) => said.push(s);
  t.after(() => {
    console.error = err;
  });
  const store = open(checkout);
  store.stop();
  const kept = readdirSync(dir).filter((n) => n.startsWith('key.unreadable-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(path.join(dir, kept[0]), 'utf8'), 'not hex');
  assert.match(readFileSync(path.join(dir, 'key'), 'utf8'), /^[0-9a-f]{64}$/);
  assert.ok(!existsSync(path.join(dir, 'key.tmp')));
  assert.ok(said.some((s) => s.includes('not a 32-byte hex key')));
  const again = open(checkout);
  again.stop();
  assert.equal(readdirSync(dir).filter((n) => n.startsWith('key.unreadable-')).length, 1, 'a good key is reused');
});

test('loadPage and loadPackage refuse what they cannot take', (t) => {
  const { work } = dirs(t);
  assert.throws(() => loadPage(path.join(work, 'none.html')));
  assert.throws(() => loadPackage(path.join(work, 'none')));
  mkdirSync(path.join(work, 'pkg'));
  writeFileSync(path.join(work, 'pkg', 'other.html'), 'x');
  assert.throws(() => loadPackage(path.join(work, 'pkg')), /index\.html/);
  assert.equal(loadPackage(path.join(work, 'pkg'), 'other.html').content.entry, 'other.html');
});
