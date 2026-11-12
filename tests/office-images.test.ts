import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../src/server/answers.js';
import { DropStore } from '../src/server/drops.js';
import type { GrokWebhookPayload } from '../src/server/grok-webhook.js';
import { formatImageLines, OFFICE_IMAGES_PATH, OfficeImageStore, parseImageRoute, restoreStoredImages, UPLOAD_WIRE_MAX, type OfficeImageRef } from '../src/server/office-images.js';
import { createOfficeMcp } from '../src/server/office-mcp/index.js';
import type { OwnerOffice, OwnerReply } from '../src/server/office-mcp/owner.js';
import { remoteMcpListener } from '../src/server/remote-mcp-http.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore, type CardRenders, type PinnedCard, type RenderImage, type RenderOutcome, type WhiteboardRenderer } from '../src/server/whiteboard.js';
import { WorkerThreadReader } from '../src/server/worker-thread.js';
import { readMenu } from '../src/shared/asks.js';
import { DROP_MAX_BYTES, splitImages, withImages } from '../src/shared/drops.js';
import { SUBAGENT_DEFAULTS, type ClientMsg, type WorkerInfo } from '../src/shared/protocol.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLE_PNG = readFileSync(path.join(REPO_ROOT, 'src/client/public/icons/icon-192.png'));
const SAMPLE_JPG = readFileSync(path.join(REPO_ROOT, 'android/docs/unpaired.jpg'));
const SAMPLE_WEBP = readFileSync(path.join(REPO_ROOT, 'docs/assets/readme/whiteboard-collab.webp'));
const SAMPLE_GIF = Buffer.from([...Buffer.from('GIF89a'), 0x20, 0x00, 0x10, 0x00, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x3b]);

/** Node fetch ignores a caller's Host header; emulate Tailscale Serve with a real HTTP request. */
const proxyFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  return new Promise((resolve, reject) => {
    const outgoing = request(req.url, { method: req.method, headers: Object.fromEntries(req.headers), signal: req.signal }, (incoming) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = incoming.statusCode ?? 500;
      resolve(new Response([204, 205, 304].includes(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
};

async function listening(t: Cleanup, server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startWebhookReceiver(t: Cleanup) {
  const received: { headers: IncomingHttpHeaders; body: GrokWebhookPayload }[] = [];
  let waiter: (() => void) | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as GrokWebhookPayload });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"accepted":true}');
      waiter?.();
      waiter = undefined;
    });
  });
  const url = await listening(t, server);
  return {
    url: `${url}/webhook`,
    received,
    async waitFor(count: number, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`Timed out waiting for ${count} webhook pushes (got ${received.length})`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(left, 50));
          waiter = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    },
  };
}

test('OfficeImageStore validates magic bytes, bounds sizes, deduplicates content, and prunes LRU entries', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-images-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = new OfficeImageStore(dir, {
    origin: () => 'https://office-mac.tail08b849.ts.net:8443/',
    maxCount: 3,
    maxBytes: 10 * 1024 * 1024,
  });

  // Rejects empty, non-image magic bytes, and >25 MB payloads.
  assert.deepEqual(store.put(Buffer.alloc(0), 'empty.png'), { ok: false, status: 400, error: 'Empty image upload.', code: 'bad_argument' });
  assert.deepEqual(store.put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'icon.png'), {
    ok: false,
    status: 415,
    error: 'Only PNG, JPEG, GIF and WebP images are supported.',
    code: 'unsupported_media_type',
  });
  assert.deepEqual(store.put(Buffer.from('#!/bin/sh\necho nope\n'), 'exploit.jpg'), {
    ok: false,
    status: 415,
    error: 'Only PNG, JPEG, GIF and WebP images are supported.',
    code: 'unsupported_media_type',
  });
  const oversized = Buffer.alloc(DROP_MAX_BYTES + 1, 0x41);
  SAMPLE_PNG.copy(oversized, 0, 0, 32);
  assert.equal(store.put(oversized, 'huge.png').ok, false);
  assert.equal((store.put(oversized, 'huge.png') as { status: number }).status, 413);

  // Accepts PNG, JPEG, WebP, GIF and extracts dimensions + clean URLs.
  const pngRes = store.put(SAMPLE_PNG, '../../Screenshot 1.PNG');
  assert.equal(pngRes.ok, true);
  if (!pngRes.ok) return;
  assert.match(pngRes.image.id, /^[0-9a-f]{16}$/);
  assert.equal(pngRes.image.name, 'Screenshot-1.png');
  assert.equal(pngRes.image.mimeType, 'image/png');
  assert.equal(pngRes.image.width, 192);
  assert.equal(pngRes.image.height, 192);
  assert.equal(store.urlFor(pngRes.image.id), `https://office-mac.tail08b849.ts.net:8443/office/images/${pngRes.image.id}`);
  assert.equal(store.urlFor('not-a-hex-id'), undefined);

  // Deduplicates identical bytes while preserving explicit name override.
  const pngDup = store.put(SAMPLE_PNG, 'renamed.jpg');
  assert.equal(pngDup.ok, true);
  if (pngDup.ok) {
    assert.equal(pngDup.image.id, pngRes.image.id);
    assert.equal(pngDup.image.name, 'renamed.png', 'extension follows magic bytes, never caller claim');
  }

  // Age png entry back so LRU pruning evicts oldest when 4th image arrives under maxCount: 3.
  const storedPng = store.get(pngRes.image.id)!;
  const oldDate = new Date(Date.now() - 60_000);
  utimesSync(storedPng.file, oldDate, oldDate);
  utimesSync(path.dirname(storedPng.file), oldDate, oldDate);

  const jpgRes = store.put(SAMPLE_JPG, 'phone');
  const webpRes = store.put(SAMPLE_WEBP, 'board.webp');
  const gifRes = store.put(SAMPLE_GIF, 'anim.gif');
  assert.ok(jpgRes.ok && webpRes.ok && gifRes.ok);
  assert.equal(jpgRes.image.width, 540);
  assert.equal(jpgRes.image.height, 1200);
  assert.equal(webpRes.image.width, 960);
  assert.equal(webpRes.image.height, 540);
  assert.equal(gifRes.image.width, 32);
  assert.equal(gifRes.image.height, 16);

  assert.equal(store.has(pngRes.image.id), false, 'oldest image pruned at maxCount=3');
  assert.equal(store.has(jpgRes.image.id), true);
  assert.equal(store.has(webpRes.image.id), true);
  assert.equal(store.has(gifRes.image.id), true);

  // Route parsing, persistence restoration, and prose formatting helpers.
  assert.deepEqual(parseImageRoute('/office/images'), { kind: 'collection' });
  assert.deepEqual(parseImageRoute('/office/images/'), { kind: 'collection' });
  assert.deepEqual(parseImageRoute(`/office/images/${jpgRes.image.id}`), { kind: 'item', id: jpgRes.image.id });
  assert.deepEqual(parseImageRoute('/office/images/not-valid'), { kind: 'invalid_item' });
  assert.deepEqual(parseImageRoute('/office/images/%E0%A4%A'), { kind: 'invalid_item' });
  assert.equal(parseImageRoute('/office/mcp'), undefined);

  const restored = restoreStoredImages([
    { ...jpgRes.image, cardId: 'c-1234', kind: 'picture', ref: 'p-1' },
    { id: 'bad', name: 'x.png', mimeType: 'image/png', bytes: 10 },
    { id: jpgRes.image.id, name: 'x.svg', mimeType: 'image/svg+xml', bytes: 10 },
  ]);
  assert.equal(restored?.length, 1);
  assert.equal(restored?.[0].cardId, 'c-1234');
  const lines = formatImageLines(store.withUrls(restored), '  ');
  assert.equal(lines[0], '  Images:');
  assert.match(lines[1], /picture c-1234\/p-1: phone\.jpg \(id: [0-9a-f]{16}, image\/jpeg, 540×1200, \d+ B\) — https:\/\/office-mac\.tail08b849\.ts\.net:8443\/office\/images\/[0-9a-f]{16}/);
});

test('ingestWorkerReportImages enforces containment, blocks dot-dirs and internal .droid-office state, and resolves drops and Whiteboard cards', (t) => {
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'office-img-outside-'));
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'office-img-floor-'));
  t.after(() => {
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });

  const floorDir = path.join(rootDir, 'repo');
  const worktreeDir = path.join(floorDir, '.droid-office', 'worktrees', 'widget-sub');
  const workerDropDir = path.join(floorDir, '.droid-office', 'drops', 'sub-1');
  const otherDropDir = path.join(floorDir, '.droid-office', 'drops', 'sub-2');
  const gitDir = path.join(worktreeDir, '.git');
  const sshDir = path.join(worktreeDir, '.ssh');
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(workerDropDir, { recursive: true });
  mkdirSync(otherDropDir, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(sshDir, { recursive: true });

  const store = new OfficeImageStore(path.join(rootDir, 'office-data'));
  const drops = new DropStore(path.join(floorDir, '.droid-office'));
  const whiteboard = new WhiteboardStore(floorDir);
  t.after(() => whiteboard.stop());

  // Valid files inside worktree and worker's own drop folder.
  const validShot = path.join(worktreeDir, 'artifacts', 'proof.png');
  mkdirSync(path.dirname(validShot), { recursive: true });
  writeFileSync(validShot, SAMPLE_PNG);
  const ownDropShot = path.join(workerDropDir, '12345678-drop.jpg');
  writeFileSync(ownDropShot, SAMPLE_JPG);

  // Sensitive / forbidden locations (even if disguised with valid PNG header!).
  const otherWorkerDrop = path.join(otherDropDir, 'secret.png');
  writeFileSync(otherWorkerDrop, SAMPLE_PNG);
  const internalStateFakePng = path.join(floorDir, '.droid-office', 'workers.json');
  writeFileSync(internalStateFakePng, SAMPLE_PNG);
  const gitObjectPng = path.join(gitDir, 'obj.png');
  writeFileSync(gitObjectPng, SAMPLE_PNG);
  const sshKeyPng = path.join(sshDir, 'id.png');
  writeFileSync(sshKeyPng, SAMPLE_PNG);

  // Symlink inside worktree pointing to `.git` secret and outside root (/etc/hosts).
  const symlinkToGit = path.join(worktreeDir, 'linked-git.png');
  symlinkSync(gitObjectPng, symlinkToGit);
  const symlinkToEtc = path.join(worktreeDir, 'hosts.png');
  symlinkSync('/etc/hosts', symlinkToEtc);
  const textFile = path.join(worktreeDir, 'notes.txt');
  writeFileSync(textFile, 'plain text, not an image');
  const emptyFile = path.join(worktreeDir, 'empty.png');
  writeFileSync(emptyFile, Buffer.alloc(0));

  for (const [badInput, pattern] of [
    [otherWorkerDrop, /internal \.droid-office state files/],
    [internalStateFakePng, /internal \.droid-office state files/],
    [gitObjectPng, /inside \.git/],
    [sshKeyPng, /inside \.ssh/],
    [symlinkToGit, /inside \.git/],
    [symlinkToEtc, /must stay inside your working folder|Only PNG/],
    ['/etc/hosts', /must stay inside your working folder/],
    [textFile, /Only PNG, JPEG, GIF and WebP/],
    [emptyFile, /empty/i],
    ['missing-shot.png', /not found/i],
    [worktreeDir, /Not a regular file/],
    ['deadbeefcafebabe', /Unknown image id/],
  ] as const) {
    const res = store.ingestWorkerReportImages({
      explicit: [badInput],
      cwd: worktreeDir,
      floorDir,
      workerId: 'sub-1',
      drops,
      whiteboard,
    });
    assert.equal(res.ok, false, `expected ${badInput} to be rejected`);
    if (!res.ok) assert.match(res.error, pattern);
  }

  // Create one image Whiteboard card and one text-only Markdown Whiteboard card.
  const imgFile = path.join(worktreeDir, 'mockup.webp');
  writeFileSync(imgFile, SAMPLE_WEBP);
  const mdFile = path.join(worktreeDir, 'spec.md');
  writeFileSync(mdFile, '# Spec\nNo raster images here.\n');
  const imgCard = 'c-img0001';
  const mdCard = 'c-md00001';
  const author = { kind: 'worker' as const, id: 'sub-1', name: 'Worker1', color: '#ff6600' };
  assert.equal(
    whiteboard.apply(
      {
        epoch: whiteboard.issueEpoch(),
        seq: 1,
        ops: [
          { op: 'card.create', card: imgCard, title: 'Mockup', kind: 'html', content: { load: { kind: 'image', file: imgFile } } } as never,
          { op: 'card.create', card: mdCard, title: 'Spec', kind: 'html', content: { load: { kind: 'markdownFile', file: mdFile } } } as never,
        ],
      },
      author,
      'agent',
    ).kind,
    'ack',
  );

  // Explicit non-image card explains png: true hint.
  const mdCardRes = store.ingestWorkerReportImages({
    explicit: [mdCard],
    cwd: worktreeDir,
    floorDir,
    workerId: 'sub-1',
    drops,
    whiteboard,
  });
  assert.equal(mdCardRes.ok, false);
  if (!mdCardRes.ok) assert.match(mdCardRes.error, /png: true/);

  // Staged DropStore ID + relative worktree path + worker's own drop + card ID mentioned in prose all resolve cleanly!
  const stagedId = drops.stage('staged.gif', SAMPLE_GIF)!;
  const okRes = store.ingestWorkerReportImages({
    explicit: ['artifacts/proof.png', ownDropShot, stagedId],
    text: `Published visual proof on Whiteboard card ${imgCard} (see also ${mdCard}).`,
    cwd: worktreeDir,
    floorDir,
    workerId: 'sub-1',
    drops,
    whiteboard,
  });
  assert.equal(okRes.ok, true);
  if (okRes.ok) {
    assert.equal(okRes.images.length, 4);
    assert.deepEqual(
      okRes.images.map((i) => i.mimeType),
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    );
    assert.equal(okRes.images[3].cardId, imgCard);
    assert.equal(okRes.images[3].kind, 'content');
  }
});

test('Tailnet /office/images enforces auth/Funnel/Origin/Host/owner gates, supports raw/multipart/JSON uploads, and never accepts or leaks tokens in URLs', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-images-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = new RemoteWorkers(dir);
  const settings = { ...SUBAGENT_DEFAULTS };
  const office = new RemoteOffice(store, () => []);
  t.after(() => office.stop());
  const bot = office.add('grokbot');
  const hostname = 'office-mac.tail08b849.ts.net';
  let ownerLogin: string | undefined = 'nik@github';

  const server = remoteMcpListener({
    answers: new Answers(),
    remote: office,
    remoteTransport: {
      hostname: () => hostname,
      owner: () => ownerLogin,
      origin: () => `https://${hostname}:8443`,
    },
    floor: () => undefined,
    settings: () => settings,
  });
  const base = await listening(t, server);
  const collectionUrl = `${base}${OFFICE_IMAGES_PATH}`;

  const authHeaders = (extra: Record<string, string> = {}) => ({
    host: `${hostname}:8443`,
    Authorization: `Bearer ${bot.token}`,
    'Tailscale-User-Login': 'nik@github',
    ...extra,
  });

  // 1. Security gates on POST and GET: missing auth, query-param token, wrong token, browser Origin, Funnel, non-owner tailnet user, wrong Host.
  for (const [desc, url, headers, expectedStatus] of [
    ['missing Authorization header', collectionUrl, { host: `${hostname}:8443` }, 401],
    ['bearer token passed in URL query string without header', `${collectionUrl}?token=${encodeURIComponent(bot.token)}&access_token=${encodeURIComponent(bot.token)}`, { host: `${hostname}:8443` }, 401],
    ['invalid bearer token', collectionUrl, authHeaders({ Authorization: 'Bearer rtok-wrong' }), 401],
    ['browser Origin header refused', collectionUrl, authHeaders({ Origin: 'https://evil.example' }), 403],
    ['Tailscale Funnel header refused', collectionUrl, authHeaders({ 'Tailscale-Funnel-Request': '?1' }), 403],
    ['shared tailnet non-owner refused', collectionUrl, authHeaders({ 'Tailscale-User-Login': 'intruder@github' }), 403],
    ['wrong Host header refused', collectionUrl, authHeaders({ host: 'evil.example:8443' }), 403],
  ] as const) {
    const postRes = await proxyFetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'image/png' }, body: SAMPLE_PNG });
    assert.equal(postRes.status, expectedStatus, `POST ${desc}`);
    const errText = await postRes.text();
    assert.equal(errText.includes(bot.token), false, `POST ${desc} must never leak bot token`);

    const getRes = await proxyFetch(`${base}${OFFICE_IMAGES_PATH}/0123456789abcdef`, { method: 'GET', headers });
    assert.equal(getRes.status, expectedStatus, `GET ${desc}`);
  }

  // Turning Office MCP off gates /office/images immediately too (401 office_mcp_disabled).
  settings.officeMcp = false;
  assert.equal((await proxyFetch(collectionUrl, { method: 'POST', headers: authHeaders({ 'content-type': 'image/png' }), body: SAMPLE_PNG })).status, 401);
  settings.officeMcp = true;

  // 2. Raw binary upload with query ?name=, x-file-name, and Content-Disposition.
  const rawRes = await proxyFetch(`${collectionUrl}?name=hero-mockup.png`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'image/png' }),
    body: SAMPLE_PNG,
  });
  assert.equal(rawRes.status, 200);
  assert.equal(rawRes.headers.get('x-droid-office-worker-id'), bot.worker.id);
  const rawJson = (await rawRes.json()) as OfficeImageRef;
  assert.match(rawJson.id, /^[0-9a-f]{16}$/);
  assert.equal(rawJson.url, `https://${hostname}:8443/office/images/${rawJson.id}`);
  assert.equal(rawJson.url?.includes(bot.token), false);
  assert.equal(rawJson.name, 'hero-mockup.png');
  assert.equal(rawJson.width, 192);
  assert.equal(rawJson.height, 192);

  // Content-Disposition filename header on raw JPEG upload.
  const dispRes = await proxyFetch(collectionUrl, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="camera-roll.jpg"' }),
    body: SAMPLE_JPG,
  });
  assert.equal(dispRes.status, 200);
  const dispJson = (await dispRes.json()) as OfficeImageRef;
  assert.equal(dispJson.name, 'camera-roll.jpg');
  assert.equal(dispJson.mimeType, 'image/jpeg');

  // 3. Multipart upload (FormData `file` field and missing-file rejection).
  const form = new FormData();
  form.append('file', new Blob([SAMPLE_WEBP], { type: 'image/webp' }), 'whiteboard-preview.webp');
  const mpRes = await proxyFetch(collectionUrl, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  assert.equal(mpRes.status, 200);
  const mpJson = (await mpRes.json()) as OfficeImageRef;
  assert.equal(mpJson.name, 'whiteboard-preview.webp');
  assert.equal(mpJson.mimeType, 'image/webp');

  const emptyForm = new FormData();
  emptyForm.append('note', 'no file field');
  assert.equal((await proxyFetch(collectionUrl, { method: 'POST', headers: authHeaders(), body: emptyForm })).status, 400);
  assert.equal((await proxyFetch(collectionUrl, { method: 'POST', headers: authHeaders({ 'content-type': 'multipart/form-data; boundary=missing' }), body: Buffer.from('corrupt') })).status, 400);

  // 4. JSON base64 & data-URI upload + malformed JSON rejections.
  const jsonRes = await proxyFetch(collectionUrl, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ data: `data:image/gif;base64,${SAMPLE_GIF.toString('base64')}`, name: 'spinner.gif' }),
  });
  assert.equal(jsonRes.status, 200);
  const jsonOut = (await jsonRes.json()) as OfficeImageRef;
  assert.equal(jsonOut.name, 'spinner.gif');
  assert.equal(jsonOut.mimeType, 'image/gif');

  for (const badBody of ['{not-json', '[]', '{}', '{"data":"not!base64!"}']) {
    const badRes = await proxyFetch(collectionUrl, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: badBody,
    });
    assert.equal(badRes.status, 400, badBody);
  }

  // Magic-byte mismatch returns 415; wire oversize returns 413; wrong methods return 405.
  assert.equal((await proxyFetch(collectionUrl, { method: 'POST', headers: authHeaders({ 'content-type': 'image/png' }), body: Buffer.from('not-a-png') })).status, 415);
  // Stream > UPLOAD_WIRE_MAX without Content-Length triggers bounded stream cut-off (413).
  const hugeRes = await new Promise<number>((resolve, reject) => {
    const req = request(collectionUrl, { method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }) }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.write(Buffer.alloc(UPLOAD_WIRE_MAX + 1024, 0x55));
    req.end();
  });
  assert.equal(hugeRes, 413);

  assert.equal((await proxyFetch(`${collectionUrl}/${rawJson.id}`, { method: 'POST', headers: authHeaders(), body: SAMPLE_PNG })).status, 405);
  assert.equal((await proxyFetch(collectionUrl, { method: 'DELETE', headers: authHeaders() })).status, 405);

  // 5. GET & HEAD download with sandboxed headers, query fallback ?id=, and 404 on unknown/invalid ids.
  const dlRes = await proxyFetch(`${collectionUrl}/${rawJson.id}`, { method: 'GET', headers: authHeaders() });
  assert.equal(dlRes.status, 200);
  assert.equal(dlRes.headers.get('content-type'), 'image/png');
  assert.equal(dlRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(dlRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(dlRes.headers.get('x-droid-office-worker-id'), bot.worker.id);
  assert.deepEqual(Buffer.from(await dlRes.arrayBuffer()), SAMPLE_PNG);

  const queryDl = await proxyFetch(`${collectionUrl}?id=${dispJson.id}`, { method: 'GET', headers: authHeaders() });
  assert.equal(queryDl.status, 200);
  assert.deepEqual(Buffer.from(await queryDl.arrayBuffer()), SAMPLE_JPG);

  const headRes = await proxyFetch(`${collectionUrl}/${mpJson.id}`, { method: 'HEAD', headers: authHeaders() });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('content-length'), String(SAMPLE_WEBP.length));
  assert.equal((await headRes.arrayBuffer()).byteLength, 0);

  assert.equal((await proxyFetch(`${collectionUrl}/ffffffffffffffff`, { method: 'GET', headers: authHeaders() })).status, 404);
  assert.equal((await proxyFetch(`${collectionUrl}/invalid-id`, { method: 'GET', headers: authHeaders() })).status, 404);
  assert.equal((await proxyFetch(collectionUrl, { method: 'GET', headers: authHeaders() })).status, 404);

  ownerLogin = undefined;
});

test('End-to-end Tailnet image exchange: upload -> team_hire / team_message / office_worker_prompt -> team_report / lead_notify / whiteboard_read / office_worker_thread -> Tailnet GET', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-images-e2e-'));
  const cleanups: (() => void | Promise<void>)[] = [];
  const rig: Cleanup = { after: (fn) => cleanups.push(fn) };
  t.after(async () => {
    try {
      for (const fn of cleanups.reverse()) await fn();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  const webhookToken = 'grok_secret_token_image_png_must_not_leak';
  const receiver = await startWebhookReceiver(rig);
  const store = new RemoteWorkers(dir);
  const settings = { ...SUBAGENT_DEFAULTS, visits: true, maxPerLead: 6 };
  let now = 20_000;
  const floors: RemoteFloor[] = [];
  const hostname = 'office.example.ts.net';
  const remoteOrigin = `https://${hostname}:8443`;
  const office = new RemoteOffice(store, () => floors, { webhookDelayMs: 20, imageOrigin: () => remoteOrigin });
  rig.after(() => office.stop());

  const alphaDir = path.join(dir, 'alpha');
  const betaDir = path.join(dir, 'beta');
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });
  const alphaDrops = new DropStore(path.join(alphaDir, '.droid-office'), office.images);

  const people = new Map<string, WorkerInfo>();
  const tokens = new Map<string, string>();
  const hiredPrompts = new Map<string, string>();
  const deliveredPrompts: { workerId: string; text: string; mode: string }[] = [];
  const sessionFiles = new Map<string, { sessionId: string; cwd: string; transcript: string; drops: string }>();
  let seq = 0;
  const screenRows = ['working'];

  const adoptWithText = (workerId: string, text: string, images?: string[]) => {
    const paths = images?.length ? alphaDrops.adopt(workerId, images) : [];
    return paths.length ? withImages(text, paths) : text;
  };

  const get = (id: string) => people.get(id) ?? store.identity(id);
  const workers: TeamWorkers & RemoteFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (tokens.get(id) === token ? people.get(id) : undefined),
    hasImage: (id) => alphaDrops.hasImage(id),
    releaseLead: (id) => {
      for (const w of people.values()) if (w.lead === id) delete w.lead;
    },
    officeDefault: undefined,
    deskOccupied: (id) => [...people.values()].some((w) => w.deskId === id),
    hire: (deskId, _by, prompt, _worktree, _choice, lead, _from, _branch, images) => {
      const id = `sub-${++seq}`;
      const relWt = path.join('.droid-office', 'worktrees', id);
      mkdirSync(path.join(alphaDir, relWt), { recursive: true });
      const w: WorkerInfo = {
        id,
        name: `Worker${seq}`,
        kind: 'agent',
        deskId,
        lead,
        color: '#ff6600',
        status: 'working',
        acked: true,
        createdAt: now,
        createdBy: lead ?? 'owner',
        cols: 100,
        rows: 30,
        open: false,
        worktree: { path: relWt, branch: `office/worker-${seq}` },
      };
      people.set(id, w);
      tokens.set(id, `tok-${id}`);
      if (prompt || images?.length) hiredPrompts.set(id, adoptWithText(id, prompt ?? '', images));
      return w;
    },
    notice: (wid, text, images) => {
      const w = people.get(wid);
      if (w?.status !== 'working') return false;
      deliveredPrompts.push({ workerId: wid, text: adoptWithText(wid, text, [...(images ?? [])]), mode: 'next_step' });
      return true;
    },
    prompt: (wid, text, queue, images) => {
      if (store.identity(wid)) {
        office.tell(wid, text, 'alpha');
        return undefined;
      }
      const w = people.get(wid);
      if (!w) return 'No such worker';
      deliveredPrompts.push({ workerId: wid, text: adoptWithText(wid, text, [...(images ?? [])]), mode: queue ? 'queued_turn' : 'sent' });
      return undefined;
    },
    cancelTurn: (wid) => {
      const w = people.get(wid);
      if (w?.status !== 'working') return false;
      w.status = 'done';
      return true;
    },
    resume: (wid, text, images) => {
      if (text && store.identity(wid)) {
        office.tell(wid, text, 'alpha');
        return undefined;
      }
      const w = people.get(wid);
      if (!w) return 'No such worker';
      w.status = 'working';
      if (text || images?.length) deliveredPrompts.push({ workerId: wid, text: adoptWithText(wid, text ?? '', [...(images ?? [])]), mode: 'resumed' });
      return undefined;
    },
    kill: async (wid) => {
      people.delete(wid);
      return {};
    },
    tail: () => screenRows.join('\n'),
    screenLines: () => screenRows,
    screenMenu: () => readMenu(screenRows),
    write: () => true,
    setTask() {},
  };

  const renderedImages = new Map<string, RenderImage>();
  const fakeRenderer: WhiteboardRenderer = {
    status: () => ({ available: true }),
    render: async (pin: PinnedCard): Promise<RenderOutcome> => {
      const image: RenderImage = {
        key: pin.key,
        rev: pin.rev,
        at: Date.now() - 5,
        width: 192,
        height: 192,
        tileHeight: 192,
        tiles: [SAMPLE_PNG],
      };
      renderedImages.set(pin.card.id, image);
      return { ok: true, image };
    },
    changed() {},
    latest: (id: string): CardRenders => ({ image: renderedImages.get(id) }),
    forget: (id: string) => {
      renderedImages.delete(id);
    },
    stop() {},
  };
  const alphaWhiteboard = new WhiteboardStore(alphaDir, { renderer: fakeRenderer });
  rig.after(() => alphaWhiteboard.stop());
  const alphaTeam = new Team({ ...workers, get }, { dataDir: alphaDir, dir: alphaDir, git: false, settings: () => settings, toast() {}, now: () => now, images: office.images });
  rig.after(() => alphaTeam.stop());
  const alphaVisits = new Visits({ ...workers, get, tell: workers.prompt, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {}, now: () => now });
  rig.after(() => alphaVisits.stop());

  const betaWhiteboard = new WhiteboardStore(betaDir);
  rig.after(() => betaWhiteboard.stop());
  const betaTeam = new Team({ ...workers, list: () => [], get: (id) => store.identity(id) }, { dataDir: betaDir, dir: betaDir, git: false, settings: () => settings, toast() {}, now: () => now, images: office.images });
  rig.after(() => betaTeam.stop());
  const betaVisits = new Visits({ ...workers, list: () => [], get: (id) => store.identity(id), tell: () => false, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {}, now: () => now });
  rig.after(() => betaVisits.stop());

  floors.push(
    { id: 'alpha', dir: alphaDir, def: { name: 'Alpha App' }, workers, team: alphaTeam, visits: alphaVisits, whiteboard: alphaWhiteboard },
    { id: 'beta', dir: betaDir, def: { name: 'Beta Docs' }, workers: { ...workers, list: () => [], get: () => undefined }, team: betaTeam, visits: betaVisits, whiteboard: betaWhiteboard },
  );

  const sessionsDir = path.join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const threadReader = new WorkerThreadReader(sessionsDir);
  const ownerBridge: OwnerOffice = {
    floors: () => floors.map((f, i) => ({ id: f.id, number: i + 1, name: f.def.name, cwd: f.dir, git: false, workers: f.workers.list() })),
    mission: () => [],
    tail: () => '',
    threadImages: async (workerId, entries) => {
      const source = sessionFiles.get(workerId);
      if (!source) return [];
      return office.images.collectThreadImages(entries, {
        dropPicture: (name) => alphaDrops.picture(workerId, name),
        sessionPicture: (imageId) => threadReader.image(source, imageId),
      });
    },
    act: async (_by: WorkerInfo, msg: ClientMsg): Promise<OwnerReply> => {
      if (msg.t === 'worker.prompt') {
        const err = workers.prompt(msg.workerId, msg.prompt, msg.queue, msg.images);
        return err ? { error: err, notes: [] } : { notes: ['Prompt sent.'], workerId: msg.workerId };
      }
      if (msg.t === 'thread.read') {
        const source = sessionFiles.get(msg.workerId);
        if (!source) return { error: 'No session.', notes: [] };
        const snap = await threadReader.read(source, msg.before !== undefined ? { before: msg.before } : undefined);
        if (snap.error) return { error: snap.error, notes: [] };
        return {
          notes: [],
          workerId: msg.workerId,
          reply: {
            t: 'thread.snapshot',
            workerId: msg.workerId,
            request: msg.request,
            sessionId: snap.sessionId,
            entries: snap.entries,
            hasMore: snap.hasMore,
            presentation: snap.presentation,
          },
        };
      }
      return { notes: [] };
    },
  };

  const grok = office.add('grokbot', { webhookUrl: receiver.url, webhookToken });
  const floorLookup = (wid: string) => {
    const f = floors.find((x) => x.workers.get(wid));
    return f ? { ...f, name: f.def.name } : undefined;
  };
  const mcpDeps = { answers: new Answers(), owner: ownerBridge, remote: office, images: office.images, floor: floorLookup, settings: () => settings };
  const localMcp = createOfficeMcp(mcpDeps);
  const localServer = createServer((req, res) => void localMcp.handle(req, res));
  const localUrl = new URL('/office/mcp', await listening(rig, localServer));

  const remoteServer = remoteMcpListener({
    ...mcpDeps,
    remoteTransport: { hostname: () => hostname, owner: () => undefined, origin: () => remoteOrigin },
  });
  const remoteBase = await listening(rig, remoteServer);
  const remoteMcpUrl = new URL('/office/mcp', remoteBase);

  const grokClient = new Client({ name: 'grok-lead', version: '1' });
  rig.after(() => grokClient.close());
  await grokClient.connect(
    new StreamableHTTPClientTransport(remoteMcpUrl, {
      fetch: proxyFetch,
      requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}` } },
    }),
  );

  // Step 1: Grok Bot uploads two images over Tailnet POST /office/images.
  const up1Res = await proxyFetch(`${remoteBase}${OFFICE_IMAGES_PATH}?name=wireframe.png`, {
    method: 'POST',
    headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}`, 'content-type': 'image/png' },
    body: SAMPLE_PNG,
  });
  assert.equal(up1Res.status, 200);
  const up1 = (await up1Res.json()) as OfficeImageRef;

  const up2Res = await proxyFetch(`${remoteBase}${OFFICE_IMAGES_PATH}?name=annotation.jpg`, {
    method: 'POST',
    headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}`, 'content-type': 'image/jpeg' },
    body: SAMPLE_JPG,
  });
  assert.equal(up2Res.status, 200);
  const up2 = (await up2Res.json()) as OfficeImageRef;

  // Unknown image id on team_hire fails fast without taking a desk.
  const badHire = await grokClient.callTool({
    name: 'team_hire',
    arguments: { title: 'Bad image', brief: 'Try missing image', floor: 'alpha', images: ['0000000000000000'], worktree: false },
  });
  assert.equal(badHire.isError, true);
  assert.equal(people.size, 0);

  // Step 2: team_hire with uploaded image ID adopts image into subagent's drops folder!
  const hire1 = await grokClient.callTool({
    name: 'team_hire',
    arguments: { title: 'Implement UI', brief: 'Match the attached wireframe.', floor: 'alpha', images: [up1.id], worktree: false },
  });
  assert.equal(hire1.isError, undefined);
  const sub1 = (hire1.structuredContent as { worker: WorkerInfo }).worker;
  const sub1Initial = hiredPrompts.get(sub1.id)!;
  const splitHire = splitImages(sub1Initial);
  assert.ok(splitHire, 'initial hire brief carries Image 1 drop path');
  assert.equal(splitHire.paths.length, 1);
  assert.deepEqual(readFileSync(splitHire.paths[0]), SAMPLE_PNG);

  // Hire second subagent to test multi-worker broadcast + resting/urgent/queued team_message attachments.
  const hire2 = await grokClient.callTool({
    name: 'team_hire',
    arguments: { title: 'Review copy', brief: 'Check layout.', floor: 'alpha', worktree: false },
  });
  const sub2 = (hire2.structuredContent as { worker: WorkerInfo }).worker;

  // Unknown image ID on team_message is refused cleanly.
  const badMsg = await grokClient.callTool({
    name: 'team_message',
    arguments: { worker: sub1.id, floor: 'alpha', text: 'Missing attachment', images: ['1111111111111111'] },
  });
  assert.equal(badMsg.isError, true);

  // Step 3: team_message broadcast (`workers: [sub1, sub2]`) while both are working delivers next_step notices with independent local drop files!
  const broadcastMsg = await grokClient.callTool({
    name: 'team_message',
    arguments: { workers: [sub1.id, sub2.id], floor: 'alpha', text: 'Updated mobile annotation attached.', images: [up2.id] },
  });
  assert.equal(broadcastMsg.isError, undefined);
  assert.equal(deliveredPrompts.length, 2);
  for (const delivery of deliveredPrompts) {
    assert.equal(delivery.mode, 'next_step');
    const parsed = splitImages(delivery.text);
    assert.ok(parsed, `worker ${delivery.workerId} received Image 1 path`);
    assert.ok(parsed.paths[0].includes(`${path.sep}${delivery.workerId}${path.sep}`));
    assert.deepEqual(readFileSync(parsed.paths[0]), SAMPLE_JPG);
  }
  assert.notEqual(splitImages(deliveredPrompts[0].text)!.paths[0], splitImages(deliveredPrompts[1].text)!.paths[0]);

  // Also test queue: true, urgent: true, resting sent, and office_worker_prompt with uploaded image IDs!
  await grokClient.callTool({
    name: 'team_message',
    arguments: { worker: sub1.id, floor: 'alpha', text: 'Queued follow-up', images: [up1.id], queue: true },
  });
  assert.equal(deliveredPrompts.at(-1)?.mode, 'queued_turn');
  assert.deepEqual(readFileSync(splitImages(deliveredPrompts.at(-1)!.text)!.paths[0]), SAMPLE_PNG);

  await grokClient.callTool({
    name: 'team_message',
    arguments: { worker: sub1.id, floor: 'alpha', text: 'Urgent interrupt with image', images: [up2.id], urgent: true },
  });
  assert.equal(deliveredPrompts.at(-1)?.mode, 'sent');
  assert.deepEqual(readFileSync(splitImages(deliveredPrompts.at(-1)!.text)!.paths[0]), SAMPLE_JPG);

  const ownerPrompt = await grokClient.callTool({
    name: 'office_worker_prompt',
    arguments: { worker: sub2.id, floor: 'alpha', prompt: 'Owner-level prompt with uploaded image', images: [up1.id] },
  });
  assert.equal(ownerPrompt.isError, undefined);
  assert.deepEqual(readFileSync(splitImages(deliveredPrompts.at(-1)!.text)!.paths[0]), SAMPLE_PNG);

  // Step 4: Subagent creates Whiteboard card + picture mark and writes a local screenshot in its worktree.
  const sub1Client = new Client({ name: 'sub-1-mcp', version: '1' });
  rig.after(() => sub1Client.close());
  await sub1Client.connect(
    new StreamableHTTPClientTransport(localUrl, {
      requestInit: { headers: { Authorization: `Bearer ${tokens.get(sub1.id)!}`, 'x-droid-office-worker-id': sub1.id } },
    }),
  );

  const worktreeWebp = path.join(sub1.worktree!.path, 'board-card.webp');
  const worktreeGif = path.join(sub1.worktree!.path, 'pin.gif');
  const worktreePng = path.join(sub1.worktree!.path, 'final-screenshot.png');
  writeFileSync(worktreeWebp, SAMPLE_WEBP);
  writeFileSync(worktreeGif, SAMPLE_GIF);
  writeFileSync(worktreePng, SAMPLE_PNG);

  const cardCreated = await sub1Client.callTool({
    name: 'whiteboard_card',
    arguments: { action: 'create', title: 'Landing Preview', source: { image: 'board-card.webp', caption: 'Hero layout' } },
  });
  assert.equal(cardCreated.isError, undefined);
  const createdStruct = cardCreated.structuredContent as { card: string; images?: OfficeImageRef[] };
  const cardId = createdStruct.card;
  assert.equal(createdStruct.images?.length, 1);
  assert.equal(createdStruct.images?.[0].url, `${remoteOrigin}/office/images/${createdStruct.images?.[0].id}`);

  const markAdded = await sub1Client.callTool({
    name: 'whiteboard_marks',
    arguments: { card: cardId, kind: 'picture', op: 'add', file: 'pin.gif', box: { x: 10, y: 20, w: 120 }, message: 'Badge asset' },
  });
  assert.equal(markAdded.isError, undefined);
  const markStruct = markAdded.structuredContent as { images?: OfficeImageRef[] };
  assert.equal(
    markStruct.images?.some((img) => img.kind === 'picture'),
    true,
  );

  // Step 5: Subagent sends mid-turn `lead_notify` with local screenshot + Whiteboard card mention.
  people.get(sub1.id)!.status = 'working';
  const notifyRes = await sub1Client.callTool({
    name: 'lead_notify',
    arguments: { kind: 'update', text: `Draft ready on ${cardId}`, images: ['final-screenshot.png'] },
  });
  assert.equal(notifyRes.isError, undefined);
  await receiver.waitFor(1);
  const notifyHook = receiver.received[0].body.items[0];
  assert.equal(notifyHook.images?.length, 3, 'includes explicit screenshot + card content + card picture mark');
  for (const img of notifyHook.images ?? []) {
    assert.match(img.id, /^[0-9a-f]{16}$/);
    assert.equal(img.url, `${remoteOrigin}/office/images/${img.id}`);
    assert.match(img.mimeType, /^image\/(png|webp|gif)$/, 'mimeType preserved by Grok webhook scrubber');
    assert.equal(JSON.stringify(img).includes(webhookToken), false);
  }

  // Step 6: Subagent sends final `team_report` with local screenshot + card reference.
  now += 1000;
  const reportRes = await sub1Client.callTool({
    name: 'team_report',
    arguments: {
      text: `All UI checks green; card ${cardId} is ready for review.`,
      images: ['final-screenshot.png'],
      result: { status: 'ok', summary: 'UI ready with screenshot and Whiteboard card.' },
    },
  });
  assert.equal(reportRes.isError, undefined);
  const reportStruct = reportRes.structuredContent as { images?: OfficeImageRef[] };
  assert.equal(reportStruct.images?.length, 3);

  await receiver.waitFor(2);
  const reportHook = receiver.received[1].body.items[0];
  assert.equal(reportHook.images?.length, 3);
  const reportEventId = reportHook.reportId!;

  // Verify Grok Bot sees downloadable `{ id, url }` in office_inbox, team_status, team_wait, and team_report_get!
  const inboxRes = (await grokClient.callTool({ name: 'office_inbox', arguments: {} })).structuredContent as {
    messages: { kind: string; images?: OfficeImageRef[] }[];
  };
  const inboxReport = inboxRes.messages.find((m) => m.kind === 'report');
  assert.equal(inboxReport?.images?.length, 3);
  assert.equal(inboxReport?.images?.[0].url, `${remoteOrigin}/office/images/${inboxReport?.images?.[0].id}`);

  const statusRes = (await grokClient.callTool({ name: 'team_status', arguments: { floor: 'alpha', since: 'team:alpha:0' } })).structuredContent as {
    workers: { id: string; images?: OfficeImageRef[] }[];
    news: { id: string; images?: OfficeImageRef[] }[];
  };
  assert.equal(statusRes.workers.find((w) => w.id === sub1.id)?.images?.length, 3);
  assert.equal(statusRes.news.find((n) => n.id === reportEventId)?.images?.length, 3);

  const waitRes = (await grokClient.callTool({ name: 'team_wait', arguments: { floor: 'alpha', since: 'team:alpha:0', timeoutSec: 5 } })).structuredContent as {
    matched: boolean;
    events: { id: string; images?: OfficeImageRef[] }[];
  };
  assert.equal(waitRes.matched, true);
  assert.equal(waitRes.events.find((n) => n.id === reportEventId)?.images?.length, 3);

  const getReportRes = (await grokClient.callTool({ name: 'team_report_get', arguments: { id: reportEventId, floor: 'alpha' } })).structuredContent as {
    report: { images?: OfficeImageRef[] };
  };
  assert.equal(getReportRes.report.images?.length, 3);

  // Reload Team from disk (`team.json`) and verify persisted report images survive restart!
  const reloadedTeam = new Team({ ...workers, get }, { dataDir: alphaDir, dir: alphaDir, git: false, settings: () => settings, toast() {}, now: () => now, images: office.images });
  rig.after(() => reloadedTeam.stop());
  const seqNum = Number(reportEventId.split(':').at(-1));
  assert.equal(reloadedTeam.reports(grok.worker.id).find((e) => e.seq === seqNum)?.images?.length, 3);

  // Step 7: External Grok Bot calls `whiteboard_read` directly (refuses omitted floor when 2 floors are open, succeeds with floor: "alpha" and png: true!).
  const ambiguousWb = await grokClient.callTool({ name: 'whiteboard_read', arguments: {} });
  assert.equal(ambiguousWb.isError, true);
  assert.match((ambiguousWb.content[0] as { text: string }).text, /Name the floor whose Whiteboard to read/);

  const wbRead = await grokClient.callTool({ name: 'whiteboard_read', arguments: { floor: 'alpha', cards: [cardId], png: true } });
  assert.equal(wbRead.isError, undefined);
  const wbStruct = wbRead.structuredContent as { cards: { id: string; images?: OfficeImageRef[] }[] };
  const cardImages = wbStruct.cards[0].images ?? [];
  assert.equal(cardImages.length, 3, 'content webp + picture gif + rendered PNG tile');
  assert.deepEqual(
    cardImages.map((i) => i.kind),
    ['content', 'picture', 'render'],
  );

  // Download all three Whiteboard images over Tailnet GET /office/images/<id> and verify byte-for-byte fidelity!
  for (const [img, expectedBytes] of [
    [cardImages[0], SAMPLE_WEBP],
    [cardImages[1], SAMPLE_GIF],
    [cardImages[2], SAMPLE_PNG],
  ] as const) {
    assert.ok(img.url);
    const localFetchUrl = img.url.replace(remoteOrigin, remoteBase);
    const resp = await proxyFetch(localFetchUrl, {
      method: 'GET',
      headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}` },
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(Buffer.from(await resp.arrayBuffer()), expectedBytes);
  }

  // Step 8: External Grok Bot reads `office_worker_thread` and downloads prompt-drop + tool-result session images!
  const dropPath = splitImages(sub1Initial)!.paths[0];
  const sessionId = 'sess-sub-1';
  const sessionFolder = path.join(sessionsDir, sub1.worktree!.path.replace(/[^a-zA-Z0-9-]/g, '-'));
  mkdirSync(sessionFolder, { recursive: true });
  const sessionFile = path.join(sessionFolder, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'session_start', id: sessionId, cwd: sub1.worktree!.path }),
    JSON.stringify({
      type: 'message',
      id: 'm-user-1',
      timestamp: new Date(now).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: withImages('Match wireframe', [dropPath]) }] },
    }),
    JSON.stringify({
      type: 'message',
      id: 'm-asst-1',
      timestamp: new Date(now + 100).toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: worktreeWebp } }] },
    }),
    JSON.stringify({
      type: 'message',
      id: 'm-tool-1',
      timestamp: new Date(now + 200).toISOString(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: SAMPLE_WEBP.toString('base64') } }],
          },
        ],
      },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join('\n')}\n`);
  sessionFiles.set(sub1.id, {
    sessionId,
    cwd: sub1.worktree!.path,
    transcript: sessionFile,
    drops: path.join(alphaDir, '.droid-office', 'drops', sub1.id),
  });

  const threadRes = await grokClient.callTool({ name: 'office_worker_thread', arguments: { worker: sub1.id, floor: 'alpha' } });
  assert.equal(threadRes.isError, undefined, (threadRes.content[0] as { text?: string })?.text);
  const threadStruct = threadRes.structuredContent as { images?: OfficeImageRef[] };
  assert.equal(threadStruct.images?.length, 2, 'prompt drop PNG + tool_result WebP registered with Tailnet URLs');
  for (const [img, expectedBytes] of [
    [threadStruct.images![0], SAMPLE_PNG],
    [threadStruct.images![1], SAMPLE_WEBP],
  ] as const) {
    assert.equal(img.kind, 'thread');
    assert.ok(img.url?.startsWith(`${remoteOrigin}/office/images/`));
    const resp = await proxyFetch(img.url!.replace(remoteOrigin, remoteBase), {
      method: 'GET',
      headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}` },
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(Buffer.from(await resp.arrayBuffer()), expectedBytes);
    assert.ok(existsSync(dropPath));
  }
});
