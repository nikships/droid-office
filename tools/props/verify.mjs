// Loads every prop GLB through the real three.js GLTFLoader+DRACOLoader stack in Node,
// to prove the Draco payload decodes and the materials survive. No WebGL needed.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { webcrypto } from 'node:crypto';

// three's loaders reach for a couple of browser globals. These are the only two the
// GLB + Draco path touches; nothing here needs a real DOM or WebGL context.
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
// DRACOLoader decodes in a Worker. Node has none, so run the same script inline; this
// mirrors the fallback DRACOLoader already takes when worker creation fails.
if (typeof globalThis.Worker === 'undefined') {
  globalThis.Worker = class InlineWorker {
    constructor() {
      const listeners = { message: [], error: [] };
      this.onmessage = null;
      this.onerror = null;
      this.addEventListener = (type, fn) => (listeners[type] ??= []).push(fn);
      this.postMessage = (port) => {
        this._port = port;
        this._onmessage = (ev) => {
          const data = ev.data;
          for (const fn of listeners.message) fn({ data });
          this.onmessage?.({ data });
        };
        this._onerror = (err) => {
          for (const fn of listeners.error) fn(err);
          this.onerror?.(err);
        };
        port.onmessage = this._onmessage;
        port.onmessageerror = this._onerror;
      };
      this.terminate = () => {};
    }
  };
}

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
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const draco = new DRACOLoader();
draco.setDecoderPath(`${base}/props/draco/`);
const loader = new GLTFLoader().setDRACOLoader(draco);

const fetchGlb = (url) => new Promise((resolve, reject) => {
  loader.load(base + url, (g) => resolve(g), undefined, reject);
});

let bad = 0, totalTris = 0, totalMats = 0;
for (const name of names) {
  const info = manifest[name];
  try {
    const gltf = await fetchGlb(info.url);
    let tris = 0, meshes = 0, mats = new Set(), hasColor = 0;
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
      }
    });
    totalTris += tris; totalMats += mats.size;
    const size = box.getSize(new THREE.Vector3());
    const ok = tris === info.triangles && tris <= 8000;
    if (!ok) bad++;
    console.log(
      `${ok ? 'OK ' : 'BAD'} ${name.padEnd(18)} tris=${String(tris).padStart(5)} (manifest ${info.triangles})`,
      `meshes=${meshes} mats=${mats.size} colored=${hasColor}`,
      `size=${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`,
    );
  } catch (e) {
    bad++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${names.length} props, ${totalTris} tris, ${totalMats} material slots, failures: ${bad}`);
draco.dispose(); server.close();
process.exit(bad ? 1 : 0);
