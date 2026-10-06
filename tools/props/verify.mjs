// Loads every prop GLB through the real three.js GLTFLoader+DRACOLoader stack in Node,
// to prove the Draco payload decodes and the materials survive. No WebGL needed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { webcrypto } from 'node:crypto';
import { inflateSync } from 'node:zlib';

// three's loaders reach for a couple of browser globals. `self`, `crypto` and
// `ProgressEvent` are shimmed; the Worker below is backed by a real worker thread.
globalThis.self = globalThis;
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
}
// The palette props embed small PNGs. Decode their actual pixels rather than letting
// GLTFLoader silently drop textures because Node has neither Image nor ImageBitmap.
// This is a CPU-only bitmap substitute, not evidence of WebGL rendering.
globalThis.createImageBitmap = async (blob) => {
  const png = Buffer.from(await blob.arrayBuffer());
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('verify: expected a PNG texture');
  }
  let width, height, channels;
  const compressed = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (offset + length + 12 > png.length) throw new Error('verify: truncated PNG chunk');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (data[8] !== 8 || !channels || data[10] || data[11] || data[12]) {
        throw new Error('verify: only non-interlaced 8-bit RGB/RGBA PNGs are supported');
      }
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  if (!width || !height || !channels) throw new Error('verify: missing PNG header');
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(compressed));
  if (filtered.length !== (stride + 1) * height) throw new Error('verify: invalid PNG pixel length');
  const pixels = new Uint8Array(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const da = Math.abs(p - a),
      db = Math.abs(p - b),
      dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    if (filter > 4) throw new Error('verify: unknown PNG filter');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? pixels[i - channels] : 0;
      const up = y ? pixels[i - stride] : 0;
      const corner = y && x >= channels ? pixels[i - stride - channels] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      pixels[i] = (filtered[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set(pixels.subarray(i * channels, i * channels + 3), i * 4);
    data[i * 4 + 3] = channels === 4 ? pixels[i * channels + 3] : 255;
  }
  return { width, height, data, close() {} };
};
// DRACOLoader always decodes in a Web Worker, which Node lacks. Run its worker body in
// a worker thread instead: capture the generated source three hands to the Worker
// constructor, prepend a bootstrap mapping the worker globals onto parentPort, and run
// that as a Classic worker script. Messages posted before the thread is up are queued.
const workerSources = new Map();
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  const url = createObjectURL(blob);
  workerSources.set(url, blob);
  return url;
};
const WORKER_BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
globalThis.self = globalThis;
globalThis.location = { href: 'file:///draco-worker.cjs' };
Object.defineProperty(globalThis, 'onmessage', {
  configurable: true,
  get() { return globalThis.__dracoOnMessage ?? null; },
  set(fn) { globalThis.__dracoOnMessage = fn; },
});
parentPort.on('message', (data) => {
  try { globalThis.__dracoOnMessage?.({ data }); }
  catch (error) { parentPort.postMessage({ type: 'error', id: data?.id ?? -1, error: String(error?.stack ?? error) }); }
});
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, Array.isArray(transfer) ? transfer : []);
`;
let workerSerial = 0;
globalThis.Worker = class NodeDracoWorker {
  constructor(url) {
    this._queue = [];
    this._real = null;
    this._file = null;
    this.onmessage = null;
    this.onerror = null;
    const listeners = { message: [], error: [] };
    this.addEventListener = (type, fn) => (listeners[type] ??= []).push(fn);
    const blob = workerSources.get(url);
    if (!blob) throw new Error(`verify: unknown worker source ${url}`);
    this._ready = blob.text().then((body) => {
      this._file = path.join(tmpdir(), `draco-worker-${process.pid}-${workerSerial++}.cjs`);
      writeFileSync(this._file, WORKER_BOOTSTRAP + body);
      const real = new NodeWorker(this._file);
      this._real = real;
      real.on('message', (data) => {
        const ev = { data };
        for (const fn of listeners.message) fn(ev);
        this.onmessage?.(ev);
      });
      // DRACOLoader never listens for worker errors, so a crash would hang the run
      // silently; report it loudly instead.
      real.on('error', (err) => {
        console.error(`verify: draco worker failed: ${err?.stack ?? err}`);
        for (const fn of listeners.error) fn(err);
        this.onerror?.(err);
      });
      for (const [data, transfer] of this._queue.splice(0)) real.postMessage(data, transfer);
    });
  }
  postMessage(data, transfer) {
    const list = Array.isArray(transfer) ? transfer : [];
    if (this._real) this._real.postMessage(data, list);
    else this._queue.push([data, list]);
  }
  terminate() {
    return this._ready.then(() => this._real.terminate());
  }
};

const ROOT = new URL('../../src/client/public/', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${ROOT}/props/manifest.json`, 'utf8'));
const names = Object.keys(manifest);

const server = createServer((req, res) => {
  const p = req.url.split('?')[0];
  try {
    const buf = readFileSync(`${ROOT}${p}`);
    const type = p.endsWith('.glb') ? 'model/gltf-binary' : p.endsWith('.wasm') ? 'application/wasm' : 'application/javascript';
    res.writeHead(200, { 'content-type': type });
    res.end(buf);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const draco = new DRACOLoader();
draco.setDecoderPath(`${base}/props/draco/`);
const loader = new GLTFLoader().setDRACOLoader(draco);
let textureFailures = 0;
loader.manager.onError = () => textureFailures++;

const fetchGlb = (url) =>
  new Promise((resolve, reject) => {
    loader.load(base + url, (g) => resolve(g), undefined, reject);
  });

let bad = 0,
  totalTris = 0,
  totalMats = 0;
for (const name of names) {
  const info = manifest[name];
  try {
    textureFailures = 0;
    const gltf = await fetchGlb(info.url);
    let tris = 0,
      meshes = 0,
      mats = new Set(),
      images = new Set(),
      hasColor = 0;
    const box = new THREE.Box3();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      const count = g.index ? g.index.count : g.attributes.position.count;
      tris += Math.floor(count / 3);
      box.expandByObject(o);
      for (const m of [].concat(o.material)) {
        mats.add(m);
        if (m.color) hasColor++;
        for (const texture of [m.map, m.metalnessMap, m.roughnessMap]) {
          if (texture?.image?.data) images.add(texture.image);
        }
      }
    });
    totalTris += tris;
    totalMats += mats.size;
    const size = box.getSize(new THREE.Vector3());
    const expectedImages = gltf.parser.json.images?.length ?? 0;
    const boundsMatch = Math.abs(size.x - info.width) < 0.001 && Math.abs(size.y - info.height) < 0.001 && Math.abs(size.z - info.depth) < 0.001;
    const ok = tris === info.triangles && tris <= 8000 && mats.size === info.materials && images.size === expectedImages && !textureFailures && boundsMatch;
    if (!ok) bad++;
    console.log(
      `${ok ? 'OK ' : 'BAD'} ${name.padEnd(18)} tris=${String(tris).padStart(5)} (manifest ${info.triangles})`,
      `meshes=${meshes} mats=${mats.size} colored=${hasColor} images=${images.size}/${expectedImages}`,
      `size=${size.x.toFixed(4)}x${size.y.toFixed(4)}x${size.z.toFixed(4)}`,
    );
  } catch (e) {
    bad++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${names.length} props, ${totalTris} tris, ${totalMats} material slots, failures: ${bad}`);
draco.dispose();
server.close();
process.exit(bad ? 1 : 0);
