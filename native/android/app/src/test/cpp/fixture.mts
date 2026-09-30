/** Real office geometry for host checks. Canvas pixels use gradient PNG placeholders here;
 * the separate browser suite compares actual three.js text and materials. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';

const context: any = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === 'measureText') return (s: string) => ({ width: s.length * 20, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') return () => ({ addColorStop() {} });
      if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      return () => {};
    },
    set: () => true,
  },
);
Object.assign(globalThis, {
  document: { createElement: () => ({ width: 300, height: 150, style: {}, getContext: () => context, addEventListener() {} }), fonts: { load: async () => [], ready: Promise.resolve() } },
  window: globalThis,
  localStorage: { getItem: () => null, setItem() {} },
  Image: class {},
});
let seed = 42;
Math.random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  head.write(type, 4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, tail]);
}
const pngCache = new Map<string, Buffer>();
function whitePng(w: number, h: number): Buffer {
  const key = `${w}x${h}`,
    cached = pngCache.get(key);
  if (cached) return cached;
  assert(w > 0 && h > 0 && w <= 4096 && h <= 4096);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(h * (w * 4 + 1), 255);
  for (let row = 0; row < h; row++) {
    const start = row * (w * 4 + 1);
    rows[start] = 0;
    for (let x = 0; x < w; x++) {
      rows[start + 1 + x * 4] = 20 + Math.floor((220 * x) / Math.max(1, w - 1));
      rows[start + 2 + x * 4] = 20 + Math.floor((220 * row) / Math.max(1, h - 1));
      rows[start + 3 + x * 4] = 128;
    }
  }
  const result = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  pngCache.set(key, result);
  return result;
}
const { buildOffice } = await import('../../../../../../src/client/world/office.ts');
const { Sky } = await import('../../../../../../src/client/world/sky.ts');
const { NativeScene } = await import('../../../../../../src/client/native/scene.ts');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0720');
scene.fog = new THREE.Fog('#0a0720', 40, 90);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 320);
camera.position.set(0, 1.7, 8);
camera.lookAt(0, 1.4, -4);
const hemi = new THREE.HemisphereLight('#2b2a6b', '#1a0d2c', 0.3),
  ambient = new THREE.AmbientLight('#5a4a9c', 0.1);
const sun = new THREE.DirectionalLight('#8f9cff', 0.18);
sun.position.set(-8, 18, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(512, 512);
scene.add(hemi, ambient, sun);
const office = buildOffice();
scene.add(office.group);
// An original worker laptop in front of the camera, with terminal text, so the checks see its
// tagged screen (the high-resolution screen layer) the way the headset receives it.
const { Laptop } = await import('../../../../../../src/client/world/laptop.ts');
const laptop = new Laptop();
laptop.root.position.set(0, 1.05, 6.5);
scene.add(laptop.root);
// A see-through pane (no depth write, like the office glass) across the screen's upper right and
// past its top edge: the screen layer redraws it over the screen, and nowhere else.
const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.3), new THREE.MeshBasicMaterial({ color: '#ff3020', transparent: true, opacity: 0.5, depthWrite: false }));
pane.position.set(0.15, 1.6, 6.6);
scene.add(pane);
const termLine = (y: number): [string, number, number, number][] => [[`$ npm test -- --grep "row ${y}" ${'|#'.repeat(30)}`, y % 16, -1, 0]];
const terminal = { cols: 96, rows: 24, lines: Array.from({ length: 24 }, (_, y) => termLine(y)), cursor: [0, 23] as [number, number], version: 1 };
const sky = new Sky(scene, { sun, hemi, ambient }, office.night);
let now = 0;
const native = new NativeScene(scene, camera, { now: () => now, encodeImage: async (_source, w, h) => ({ fmt: 'png', bytes: whitePng(w, h) }) });
const packets: unknown[] = [];
for (let frame = 0; frame < 160; frame++) {
  now = frame * 100;
  office.update?.(frame / 30, 1 / 30, [new THREE.Vector3()]);
  laptop.update(1 / 30, terminal, 1.5);
  sky.update(1 / 30, frame / 30, camera);
  native.capture();
  for (;;) {
    const p = native.drain();
    if (!p) break;
    packets.push(p);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}
const report = native.report();
assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
assert.equal(report.stats.pendingTextures, 0);
assert.equal(report.stats.encoding, 0);
assert(report.stats.objects > 1000 && report.stats.textures > 10 && packets.length > 20);
const sharp = (packets as { materials?: { id: number; sharpText?: boolean }[] }[]).flatMap((p) => p.materials ?? []).filter((m) => m.sharpText);
assert.equal(new Set(sharp.map((m) => m.id)).size, 1, 'the laptop screen is the only sharp material');
const output = process.argv[2];
assert(output, 'provide an output JSON path');
await writeFile(output, JSON.stringify(packets));
console.log(`Original office fixture: ${report.stats.objects} objects, ${report.stats.textures} textures, ${packets.length} packets`);
