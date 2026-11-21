import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { WebSocket } from 'ws';
import { OutlineEffect } from '../src/client/outline-effect.js';
import { buildTower, type NightParts } from '../src/client/world/tower.js';
import { toonUnique } from '../src/client/world/toon.js';
import { loadConfig } from '../src/server/config.js';
import { HotReload } from '../src/server/hot-reload.js';
import { createStaticFiles } from '../src/server/server-runtime/static-files.js';
import { startServer } from '../src/server/server.js';

test('OutlineEffect skips hidden subtrees, retains cached shaders across frames, updates uniforms in place, and restores materials on throw', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  const visibleMat = new THREE.MeshToonMaterial({ color: '#ff6600' });
  const visibleMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), visibleMat);
  const originalHook = () => {};
  visibleMesh.onBeforeRender = originalHook;
  scene.add(visibleMesh);

  const noOutlineMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  noOutlineMat.userData.outlineParameters = { visible: false };
  const noOutlineMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), noOutlineMat);
  scene.add(noOutlineMesh);

  const multiA = new THREE.MeshToonMaterial({ color: '#224488' });
  const multiB = new THREE.MeshBasicMaterial({ wireframe: true });
  const multiMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [multiA, multiB]);
  scene.add(multiMesh);

  const hiddenGroup = new THREE.Group();
  hiddenGroup.visible = false;
  let hiddenGetterReads = 0;
  const hiddenMat = new THREE.MeshToonMaterial({ color: '#00ff00' });
  const hiddenMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hiddenMat);
  Object.defineProperty(hiddenMesh, 'material', {
    configurable: true,
    get() {
      hiddenGetterReads++;
      return hiddenMat;
    },
    set() {
      hiddenGetterReads++;
    },
  });
  hiddenGroup.add(hiddenMesh);
  scene.add(hiddenGroup);

  const seenOutlines: THREE.ShaderMaterial[] = [];
  let shouldThrow = false;
  const renderer = {
    autoClear: true,
    shadowMap: { enabled: true },
    setSize() {},
    render(root: THREE.Object3D, cam: THREE.Camera) {
      if (shouldThrow) throw new Error('boom');
      const outlineMat = visibleMesh.material as THREE.ShaderMaterial;
      if ((outlineMat as { isShaderMaterial?: boolean }).isShaderMaterial) {
        seenOutlines.push(outlineMat);
        visibleMesh.onBeforeRender(renderer as unknown as THREE.WebGLRenderer, root as THREE.Scene, cam, visibleMesh.geometry, outlineMat, null as unknown as THREE.Group);
        assert.equal(noOutlineMesh.material.visible, false, 'non-outlined mesh swaps to non-visible sentinel');
        assert.equal((noOutlineMesh.material as { isShaderMaterial?: boolean }).isShaderMaterial, undefined);
        const arr = multiMesh.material as THREE.Material[];
        assert.equal((arr[0] as { isShaderMaterial?: boolean }).isShaderMaterial, true);
        assert.equal(arr[1].visible, false);
      }
    },
  };

  const effect = new OutlineEffect(renderer, { defaultThickness: 0.002, defaultColor: [0.1, 0.2, 0.3], defaultAlpha: 1 });
  for (let i = 0; i < 120; i++) effect.render(scene, camera);

  assert.equal(hiddenGetterReads, 0, 'hidden subtrees are never traversed during outline passes');
  assert.equal(seenOutlines.length, 120);
  assert.equal(seenOutlines[0], seenOutlines[119], 'cached outline ShaderMaterial is never evicted after 60+ frames');
  assert.equal(Math.abs(seenOutlines[0].uniforms.outlineThickness.value - 0.002) < 1e-9, true);

  effect.setDefaults(0.0045, 0.75);
  effect.renderOutline(scene, camera);
  assert.equal(seenOutlines.at(-1), seenOutlines[0], 'setDefaults reuses existing compiled ShaderMaterial');
  assert.equal(Math.abs(seenOutlines.at(-1)!.uniforms.outlineThickness.value - 0.0045) < 1e-9, true);

  assert.equal(visibleMesh.material, visibleMat);
  assert.equal(visibleMesh.onBeforeRender, originalHook);
  assert.equal(noOutlineMesh.material, noOutlineMat);
  assert.deepEqual(multiMesh.material, [multiA, multiB]);

  shouldThrow = true;
  assert.throws(() => effect.renderOutline(scene, camera), /boom/);
  assert.equal(visibleMesh.material, visibleMat, 'materials restore cleanly after render throw');
  assert.equal(visibleMesh.onBeforeRender, originalHook);
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.shadowMap.enabled, true);
});

test('createStaticFiles negotiates brotli and gzip, caches immutable assets, and preserves ETag 304 responses', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-static-perf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const bigJs = `export const payload = ${JSON.stringify('droid-office-bundle-'.repeat(120))};\n`;
  const tinyCss = 'body{margin:0}\n';
  const jsFile = path.join(dir, 'bundle.hash123.js');
  const cssFile = path.join(dir, 'tiny.css');
  const webpFile = path.join(dir, 'grokbot.webp');
  const htmlFile = path.join(dir, 'index.html');
  writeFileSync(jsFile, bigJs);
  writeFileSync(cssFile, tinyCss);
  writeFileSync(webpFile, 'RIFF\x00\x00\x00\x00WEBP');
  writeFileSync(htmlFile, `<!doctype html><html><body>${'hello '.repeat(200)}</body></html>`);

  const reload = new HotReload({ publicDir: dir, dataDir: dir });
  t.after(() => reload.stop());
  const files = createStaticFiles(reload);

  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') return files.serveFile(res, jsFile, true, req);
    if (req.url === '/tiny.css') return files.serveFile(res, cssFile, true, req);
    if (req.url === '/icons/grokbot.webp') return files.serveFile(res, webpFile, false, req);
    if (req.url === '/manifest.json') return files.serveFile(res, jsFile, 'revalidate', req);
    return files.serveIndex(res, null, req);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const rawGet = (route: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
    });

  const brRes = await rawGet('/bundle.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(brRes.status, 200);
  assert.equal(brRes.headers['content-encoding'], 'br');
  assert.equal(brRes.headers.vary, 'Accept-Encoding');
  assert.ok(brRes.body.length < Buffer.byteLength(bigJs), 'brotli shrinks JS payload');
  assert.equal(brotliDecompressSync(brRes.body).toString('utf8'), bigJs);

  const brCached = await rawGet('/bundle.js', { 'accept-encoding': 'br' });
  assert.deepEqual(brCached.body, brRes.body, 'immutable compressed asset serves cached buffer');

  const gzipRes = await rawGet('/bundle.js', { 'accept-encoding': 'gzip' });
  assert.equal(gzipRes.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(gzipRes.body).toString('utf8'), bigJs);

  const plainRes = await rawGet('/bundle.js');
  assert.equal(plainRes.headers['content-encoding'], undefined);
  assert.equal(plainRes.body.toString('utf8'), bigJs);

  const tinyRes = await rawGet('/tiny.css', { 'accept-encoding': 'br, gzip' });
  assert.equal(tinyRes.headers['content-encoding'], undefined, 'sub-512B assets skip compression overhead');
  assert.equal(tinyRes.body.toString('utf8'), tinyCss);

  const webpRes = await rawGet('/icons/grokbot.webp');
  assert.equal(webpRes.status, 200);
  assert.equal(webpRes.headers['content-type'], 'image/webp');

  const reval = await rawGet('/manifest.json', { 'accept-encoding': 'br' });
  assert.equal(reval.status, 200);
  assert.ok(reval.headers.etag);
  const notMod = await rawGet('/manifest.json', { 'accept-encoding': 'br', 'if-none-match': String(reval.headers.etag) });
  assert.equal(notMod.status, 304);
  assert.equal(notMod.body.length, 0);

  const htmlBr = await rawGet('/', { 'accept-encoding': 'br' });
  assert.equal(htmlBr.status, 200);
  assert.equal(htmlBr.headers['content-encoding'], 'br');
  assert.match(brotliDecompressSync(htmlBr.body).toString('utf8'), /office-revision/);
});

test('non-streaming worker.attach marks workers open without sending snapshots or term.data until streaming attach', { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'office-stream-attach-'));
  mkdirSync(path.join(home, '.git'));
  const cfg = loadConfig(['--home', home, '--projects', home, home, '--host', '127.0.0.1', '--weather', 'clear']);
  cfg.port = 0;
  const office = await startServer(cfg);
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    office.server.closeAllConnections();
    await closed;
    await delay(100);
    rmSync(home, { recursive: true, force: true });
  });

  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=StreamCheck`, { headers: { origin: base } });
  t.after(() => ws.terminate());
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await once(ws, 'open');

  const waitMsg = async (pred: (m: Record<string, unknown>) => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await delay(25);
    }
    throw new Error(`timed out waiting for message; got: ${messages.map((m) => m.t).join(',')}`);
  };

  await waitMsg((m) => m.t === 'welcome');
  ws.send(JSON.stringify({ t: 'worker.spawn', deskId: 'auto', kind: 'shell' }));
  const spawned = await waitMsg((m) => m.t === 'worker.update');
  const workerId = String((spawned.worker as { id: string }).id);

  messages.length = 0;
  ws.send(JSON.stringify({ t: 'worker.attach', workerId, stream: false }));
  await waitMsg((m) => m.t === 'worker.update' && (m.worker as { id: string; open: boolean }).id === workerId && (m.worker as { open: boolean }).open === true);

  ws.send(JSON.stringify({ t: 'term.input', workerId, data: 'echo QUIET_THREAD_STREAM\r' }));
  await delay(250);
  assert.equal(
    messages.some((m) => m.t === 'term.snapshot' || m.t === 'term.data'),
    false,
    'stream: false attachment sends zero raw terminal snapshots or stream chunks',
  );

  ws.send(JSON.stringify({ t: 'worker.attach', workerId, stream: true }));
  await waitMsg((m) => m.t === 'term.snapshot' && m.workerId === workerId);
  ws.send(JSON.stringify({ t: 'term.input', workerId, data: 'echo LIVE_RAW_TTY\r' }));
  await waitMsg((m) => m.t === 'term.data' && m.workerId === workerId && String(m.data).includes('LIVE_RAW_TTY'));

  ws.send(JSON.stringify({ t: 'worker.detach', workerId }));
  await waitMsg((m) => m.t === 'worker.update' && (m.worker as { id: string; open: boolean }).id === workerId && (m.worker as { open: boolean }).open === false);
  ws.terminate();
});

test('buildTower reuses night bulbs across floor switches and skips redundant rebuilds', (t) => {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const fakeCanvas = {
    width: 64,
    height: 64,
    getContext: () =>
      new Proxy(
        {
          createRadialGradient: () => ({ addColorStop() {} }),
        },
        { get: (target, prop) => Reflect.get(target, prop) ?? (() => {}) },
      ),
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ ...fakeCanvas }) },
  });
  t.after(() => (prevDoc ? Object.defineProperty(globalThis, 'document', prevDoc) : Reflect.deleteProperty(globalThis, 'document')));

  const colliders = [];
  const night: NightParts = {
    bulbs: [],
    halos: [],
    lamps: [],
    street: 0,
    windows: [],
    clouds: toonUnique('#ffffff'),
  };
  const tower = buildTower(colliders, night);
  const initialBulbs = night.bulbs.length;

  tower.set(0, 4);
  const firstChild = tower.group.children[0];
  assert.equal(night.bulbs.length, initialBulbs, 'tower.set does not leak new bulb materials per rebuild');

  tower.set(0, 4);
  assert.equal(tower.group.children[0], firstChild, 'identical (index, count) skips rebuilding tower geometry');

  for (let floor = 1; floor <= 4; floor++) tower.set(floor, 4);
  assert.equal(night.bulbs.length, initialBulbs, 'switching across every floor and roof keeps night.bulbs bounded');
});
