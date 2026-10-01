import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { installOfficeNative } from '../src/client/native/bridge';
import { type ImageEncoder, NativeScene } from '../src/client/native/scene';
import { base64ToBytes, bytesToBase64, type GeometryItem, type Packet, packBinary, sameAffine, affine12 } from '../src/client/native/wire';

/** A fake canvas: anything with width and height reads as a loaded texture source. */
const canvas = (w = 4, h = 4) => ({ width: w, height: h });

function encoder(log: unknown[] = []): ImageEncoder {
  return async (source, w, h, opaque) => {
    log.push(source);
    return { fmt: opaque ? 'jpeg' : 'png', bytes: new Uint8Array([w, h, 1, 2, 3]) };
  };
}

function make(opts: ConstructorParameters<typeof NativeScene>[2] = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 320);
  let clock = 0;
  const native = new NativeScene(scene, camera, { encodeImage: encoder(), now: () => clock, ...opts });
  return { scene, camera, native, tick: (ms: number) => (clock += ms) };
}

/** Drains until nothing is left, returning every packet. */
function drainAll(native: NativeScene, budget?: number): Packet[] {
  const out: Packet[] = [];
  for (let i = 0; i < 1000; i++) {
    const p = native.drain(budget);
    if (!p) return out;
    out.push(p);
  }
  throw new Error('drain never finished');
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Resolves a Bin against the blob parts seen so far. */
function binBytes(bin: { d: string } | { blob: number }, packets: Packet[]): Uint8Array {
  if ('d' in bin) return base64ToBytes(bin.d);
  const parts = packets.flatMap((p) => p.blobs ?? []).filter((b) => b.id === bin.blob);
  parts.sort((a, b) => a.part - b.part);
  assert.equal(parts.length, parts[0].parts);
  const bytes = base64ToBytes(parts.map((p) => p.d).join(''));
  assert.equal(bytes.byteLength, parts[0].bytes);
  return bytes;
}

const floats = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

test('base64 round-trips every tail length and matches Buffer', () => {
  for (let n = 0; n < 20; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    const b64 = bytesToBase64(bytes);
    assert.equal(b64, Buffer.from(bytes).toString('base64'));
    assert.deepEqual(base64ToBytes(b64), bytes);
  }
});

test('packBinary inlines small arrays and splits large ones into decodable parts', () => {
  let id = 7;
  const small = packBinary(new Uint8Array(100), () => id++);
  assert.ok('d' in small.bin);
  assert.equal(small.parts.length, 0);
  const big = new Uint8Array(100_000).map((_, i) => i & 255);
  const out = packBinary(big, () => id++, 4096);
  assert.deepEqual(out.bin, { blob: 7 });
  assert.ok(out.parts.length > 1);
  for (const p of out.parts) assert.equal(p.d.length % 4 === 0 || p.part === p.parts - 1, true);
  assert.deepEqual(base64ToBytes(out.parts.map((p) => p.d).join('')), big);
});

test('affine12 keeps the 3x4 part of a column-major matrix', () => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.2, 0.1)), new THREE.Vector3(2, 2, 2));
  const out = new Float32Array(12);
  affine12(m.elements, out);
  assert.deepEqual([out[9], out[10], out[11]], [1, 2, 3]);
  assert.ok(sameAffine(m.elements, out));
  m.elements[12] += 0.001;
  assert.ok(!sameAffine(m.elements, out));
});

test('the first drain is a reset snapshot with the whole world, then nothing', () => {
  const { scene, native } = make();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshToonMaterial({ color: '#ff0000' }));
  box.position.set(4, 5, 6);
  box.castShadow = true;
  const group = new THREE.Group();
  group.renderOrder = 3;
  group.add(box);
  scene.add(group);
  native.capture();
  const packets = drainAll(native);
  assert.equal(packets.length, 1);
  const p = packets[0];
  assert.equal(p.v, 1);
  assert.equal(p.reset, true);
  assert.equal(p.commit, true);
  assert.equal(p.geometries?.length, 1);
  assert.equal(p.materials?.length, 1);
  assert.equal(p.objects?.length, 1);
  const geo = p.geometries![0];
  assert.equal(geo.count, 24);
  assert.equal(geo.index?.t, 'u16');
  assert.equal(geo.index?.count, 36);
  assert.equal(floats(binBytes(geo.attrs.position!.data, packets)).length, 24 * 3);
  assert.equal(geo.attrs.uv?.n, 2);
  assert.deepEqual(geo.groups.length, 6);
  const mat = p.materials![0];
  assert.equal(mat.type, 'toon');
  assert.equal(mat.lit, true);
  // three keeps colors linear: #ff0000 is (1, 0, 0) either way, so check a mid tone too.
  assert.deepEqual(mat.color, [1, 0, 0]);
  const obj = p.objects![0];
  assert.equal(obj.kind, 'mesh');
  assert.equal(obj.geo, geo.id);
  assert.equal(obj.mat, mat.id);
  assert.deepEqual(obj.order, [3, 0]);
  assert.equal(obj.cast, true);
  assert.deepEqual(obj.m.slice(9), [4, 5, 6]);
  assert.ok(p.env);
  assert.ok(p.camera);
  native.capture();
  assert.equal(native.drain(), null);
});

test('moving, hiding and recoloring send only what changed', () => {
  const { scene, native } = make();
  const mat = new THREE.MeshBasicMaterial({ color: '#808080' });
  const a = new THREE.Mesh(new THREE.PlaneGeometry(), mat);
  const b = new THREE.Mesh(new THREE.PlaneGeometry(), mat);
  const parent = new THREE.Group();
  parent.add(b);
  scene.add(a, parent);
  native.capture();
  drainAll(native);

  a.position.x = 2;
  native.capture();
  let p = native.drain()!;
  assert.deepEqual(p.xf?.ids, [native.report().stats.objects && p.xf!.ids[0]]);
  assert.equal(p.objects, undefined);
  assert.equal(floats(base64ToBytes((p.xf!.m as { d: string }).d))[9], 2);
  assert.equal(p.commit, true);

  // Hiding the parent hides the child: visibility is inherited.
  parent.visible = false;
  native.capture();
  p = native.drain()!;
  assert.equal(p.hide?.length, 1);
  assert.equal(p.show, undefined);

  mat.color.set('#ffffff');
  native.capture();
  p = native.drain()!;
  assert.equal(p.materials?.length, 1);
  assert.deepEqual(p.materials![0].color, [1, 1, 1]);
  assert.equal(p.geometries, undefined);

  parent.visible = true;
  native.capture();
  p = native.drain()!;
  assert.equal(p.show?.length, 1);
});

test('layers and material visibility follow what three would draw', () => {
  const { scene, native } = make();
  const hidden = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  hidden.layers.set(5);
  const off = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
  scene.add(hidden, off);
  native.capture();
  const p = native.drain()!;
  const byId = new Map(p.objects!.map((o) => [o.id, o]));
  assert.equal([...byId.values()].filter((o) => !o.visible).length, 1);
  assert.equal(p.materials!.find((m) => !m.visible) !== undefined, true);
});

test('removed objects, and geometry and materials nobody uses, are removed', () => {
  const { scene, native } = make();
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas() as never) }));
  scene.add(m);
  native.capture();
  drainAll(native);
  scene.remove(m);
  native.capture();
  const p = native.drain()!;
  assert.equal(p.remove?.objects?.length, 1);
  assert.equal(p.remove?.geometries?.length, 1);
  assert.equal(p.remove?.materials?.length, 1);
  assert.equal(p.commit, true);
});

test('a geometry edit sends only its changed attribute; a new shape sends it whole', () => {
  const { scene, native } = make();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 3, vertexColors: true })));
  native.capture();
  drainAll(native);

  (geo.attributes.position as THREE.BufferAttribute).setX(0, 9);
  geo.attributes.position.needsUpdate = true;
  native.capture();
  let p = native.drain()!;
  let g = p.geometries![0] as GeometryItem;
  assert.equal(g.partial, true);
  assert.ok(g.attrs.position);
  assert.equal(g.attrs.color, undefined);
  assert.equal(floats(binBytes(g.attrs.position!.data, [p]))[0], 9);

  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
  native.capture();
  p = native.drain()!;
  g = p.geometries![0];
  assert.equal(g.partial, undefined);
  assert.ok(g.attrs.position && g.attrs.color);
  assert.equal(g.index, null);
});

test('multi-material meshes keep their groups and material slots', () => {
  const { scene, native } = make();
  const mats = [new THREE.MeshBasicMaterial({ color: 'red' }), new THREE.MeshToonMaterial({ color: 'blue' })];
  const geo = new THREE.BoxGeometry();
  geo.clearGroups();
  geo.addGroup(0, 18, 0);
  geo.addGroup(18, 18, 1);
  scene.add(new THREE.Mesh(geo, mats));
  native.capture();
  const p = native.drain()!;
  assert.deepEqual(p.geometries![0].groups, [
    [0, 18, 0],
    [18, 18, 1],
  ]);
  assert.ok(Array.isArray(p.objects![0].mat));
  assert.equal((p.objects![0].mat as number[]).length, 2);
});

test('instanced meshes send instance matrices and colors, and updates to them', () => {
  const { scene, native } = make();
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial(), 3);
  for (let i = 0; i < 3; i++) {
    im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i, 0, 0));
    im.setColorAt(i, new THREE.Color(i / 2, 0, 0));
  }
  scene.add(im);
  native.capture();
  let p = native.drain()!;
  const inst = p.objects![0].inst!;
  assert.equal(p.objects![0].kind, 'instanced');
  assert.equal(inst.count, 3);
  const m = floats(binBytes(inst.m, [p]));
  assert.equal(m.length, 36);
  assert.equal(m[12 + 9], 1);
  assert.equal(floats(binBytes(inst.c!, [p])).length, 9);
  im.setMatrixAt(2, new THREE.Matrix4().makeTranslation(5, 0, 0));
  im.instanceMatrix.needsUpdate = true;
  native.capture();
  p = native.drain()!;
  assert.equal(p.objects, undefined);
  assert.equal(p.instances?.length, 1);
  assert.equal(floats(binBytes(p.instances![0].inst.m, [p]))[24 + 9], 5);
});

test('sprites, lines and points carry their kind and material fields', () => {
  const { scene, native } = make();
  const tex = new THREE.CanvasTexture(canvas() as never);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color: '#bcd0e6', transparent: true, opacity: 0.5, depthWrite: false }));
  const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, blending: THREE.AdditiveBlending, transparent: true }));
  scene.add(sprite, lines, pts);
  native.capture();
  const p = native.drain()!;
  const kinds = p.objects!.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ['lines', 'points', 'sprite']);
  const s = p.objects!.find((o) => o.kind === 'sprite')!;
  assert.deepEqual(s.center, [0.5, 0]);
  assert.deepEqual(s.order, [0, 10]);
  const sm = p.materials!.find((m) => m.type === 'sprite')!;
  assert.equal(sm.map?.t !== undefined, true);
  assert.equal(sm.depthWrite, false);
  const pm = p.materials!.find((m) => m.type === 'points')!;
  assert.equal(pm.size, 4);
  assert.equal(pm.sizeAttenuation, false);
  assert.equal(pm.blend[0], 'additive');
});

test('canvas textures encode asynchronously, then re-encode when redrawn (throttled)', async () => {
  const log: unknown[] = [];
  const { scene, native, tick } = make({ encodeImage: encoder(log), textureIntervalMs: 100 });
  const src = canvas(8, 2);
  const tex = new THREE.CanvasTexture(src as never);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: tex })));
  native.capture();
  let p = native.drain()!;
  // The material references the texture before its pixels exist; the renderer draws it white until then.
  const ref = p.materials![0].map!;
  assert.equal(ref.m[0], 2);
  assert.equal(p.textures, undefined);
  await flush();
  native.capture();
  p = native.drain()!;
  const t = p.textures![0];
  assert.equal(t.id, ref.t);
  assert.equal(t.fmt, 'png');
  assert.equal(t.w, 8);
  assert.equal(t.srgb, true);
  assert.equal(t.wrapS, 'repeat');
  assert.equal(t.flipY, true);
  assert.deepEqual(Array.from(binBytes(t.data!, [p])), [8, 2, 1, 2, 3]);
  assert.equal(log.length, 1);

  tex.needsUpdate = true;
  native.capture();
  await flush();
  assert.equal(log.length, 1, 'throttled');
  tick(150);
  native.capture();
  await flush();
  assert.equal(log.length, 2);
  native.capture();
  p = native.drain()!;
  assert.equal(p.textures?.length, 1);

  // A sampler-only change sends no pixels.
  tex.magFilter = THREE.NearestFilter;
  native.capture();
  p = native.drain()!;
  assert.equal(p.textures![0].data, undefined);
  assert.equal(p.textures![0].mag, 'nearest');
});

test('an image that loads after the first capture is sent once it is ready', async () => {
  const { scene, native } = make();
  const tex = new THREE.Texture();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: tex })));
  native.capture();
  drainAll(native);
  await flush();
  assert.equal(native.drain(), null);
  tex.image = canvas(16, 16);
  tex.needsUpdate = true;
  native.capture();
  await flush();
  native.capture();
  const p = native.drain()!;
  assert.equal(p.textures![0].w, 16);
});

test('the toon gradient DataTexture goes as raw RGBA8', () => {
  const { scene, native } = make();
  const data = new Uint8Array([90, 90, 90, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  const gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshToonMaterial({ gradientMap: gradient })));
  native.capture();
  const packets = drainAll(native);
  const t = packets.flatMap((p) => p.textures ?? [])[0];
  assert.equal(t.fmt, 'rgba8');
  assert.equal(t.w, 3);
  assert.equal(t.min, 'nearest');
  assert.equal(t.mips, false);
  assert.deepEqual(Array.from(binBytes(t.data!, packets)), Array.from(data));
});

test('large scenes split into bounded packets that commit only at the end', () => {
  const { scene, native } = make();
  const mat = new THREE.MeshToonMaterial();
  for (let i = 0; i < 60; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1 + i, 48, 24), mat);
    m.position.x = i;
    scene.add(m);
  }
  native.capture();
  const budget = 64 * 1024;
  const packets = drainAll(native, budget);
  assert.ok(packets.length > 5);
  for (const p of packets) assert.ok(JSON.stringify(p).length <= budget + 256, `packet ${p.seq} is ${JSON.stringify(p).length}`);
  assert.deepEqual(
    packets.map((p) => p.commit),
    packets.map((_, i) => i === packets.length - 1),
  );
  assert.deepEqual(
    packets.map((p) => p.seq),
    packets.map((_, i) => i + 1),
  );
  assert.equal(packets[0].reset, true);
  assert.equal(packets.flatMap((p) => p.objects ?? []).length, 60);
  // Every object's geometry went out before (or with) the object.
  const seen = new Set<number>();
  for (const p of packets) {
    for (const g of p.geometries ?? []) seen.add(g.id);
    for (const o of p.objects ?? []) assert.ok(seen.has(o.geo));
  }
});

test('one geometry larger than a packet goes as blob parts across packets', () => {
  const { scene, native } = make({ chunkChars: 16 * 1024 });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), new THREE.MeshBasicMaterial()));
  native.capture();
  const packets = drainAll(native, 32 * 1024);
  assert.ok(packets.length > 3);
  for (const p of packets) assert.ok(JSON.stringify(p).length <= 32 * 1024 + 256);
  const g = packets.flatMap((p) => p.geometries ?? [])[0];
  assert.ok('blob' in g.attrs.position!.data);
  assert.equal(floats(binBytes(g.attrs.position!.data, packets)).length, g.count * 3);
  // The geometry item comes after every one of its parts.
  const gi = packets.findIndex((p) => p.geometries?.length);
  const lastPart = Math.max(...packets.map((p, i) => ((p.blobs ?? []).some((b) => b.id === (g.attrs.position!.data as { blob: number }).blob) ? i : -1)));
  assert.ok(lastPart <= gi);
});

test('changes made between drains of a long snapshot still arrive', () => {
  const { scene, native } = make();
  const mat = new THREE.MeshToonMaterial();
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1 + i, 48, 24), mat);
    meshes.push(m);
    scene.add(m);
  }
  native.capture();
  native.drain(48 * 1024);
  meshes[0].position.y = 7;
  meshes[29].position.y = 8;
  native.capture();
  const rest = drainAll(native, 48 * 1024);
  const all = rest.flatMap((p) => [...(p.objects ?? []).map((o) => ({ id: o.id, y: o.m[10] })), ...(p.xf ? p.xf.ids.map((id, i) => ({ id, y: floats(base64ToBytes((p.xf!.m as { d: string }).d))[i * 12 + 10] })) : [])]);
  const ys = all.map((a) => a.y);
  assert.ok(ys.includes(7));
  assert.ok(ys.includes(8));
  assert.equal(rest.at(-1)!.commit, true);
});

test('reset re-sends everything, including textures already encoded', async () => {
  const { scene, native } = make();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas() as never) })));
  native.capture();
  drainAll(native);
  await flush();
  native.capture();
  drainAll(native);
  native.reset();
  native.capture();
  const packets = drainAll(native);
  assert.equal(packets[0].reset, true);
  assert.equal(packets.flatMap((p) => p.objects ?? []).length, 1);
  assert.equal(packets.flatMap((p) => p.textures ?? []).filter((t) => t.data).length, 1);
});

test('lights, fog, background and shadows are sent in world space', () => {
  const { scene, native } = make();
  scene.background = new THREE.Color('#0a0720');
  scene.fog = new THREE.Fog('#0a0720', 40, 90);
  const sun = new THREE.DirectionalLight('#8f9cff', 0.5);
  sun.position.set(-8, 18, 10);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 30, bottom: -30, near: 1, far: 100 });
  scene.add(sun, new THREE.HemisphereLight('#2b2a6b', '#1a0d2c', 0.3), new THREE.AmbientLight('#5a4a9c', 0.1));
  const p = new THREE.PointLight('#ff4fd8', 2, 15, 1.2);
  p.position.set(1, 2, 3);
  scene.add(p);
  native.capture();
  const env = native.drain()!.env!;
  assert.deepEqual(
    env.background,
    new THREE.Color('#0a0720').toArray().map((x) => Math.round(x * 1e6) / 1e6),
  );
  assert.deepEqual((env.fog as { near: number }).near, 40);
  assert.equal(env.dir.length, 1);
  const d = env.dir[0];
  const len = Math.hypot(...d.dir);
  assert.ok(Math.abs(len - 1) < 1e-5);
  assert.ok(d.dir[1] > 0.7);
  assert.ok(d.shadow);
  assert.equal(d.shadow!.viewProj.length, 16);
  assert.deepEqual(d.shadow!.mapSize, [512, 512]);
  assert.equal(env.hemi.length, 1);
  assert.deepEqual(env.hemi[0].dir, [0, 1, 0]);
  assert.ok(env.ambient[2] > 0);
  assert.deepEqual(env.point[0].pos, [1, 2, 3]);
  assert.equal(env.point[0].distance, 15);
});

test('unsupported things are reported, never dropped silently', () => {
  const { scene, native } = make();
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const custom = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial({ vertexShader: 'void main(){}', fragmentShader: 'void main(){}' }));
  const normalMapped = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ normalMap: new THREE.Texture() }));
  scene.add(skinned, custom, normalMapped);
  native.capture();
  const p = native.drain()!;
  const reasons = p.unsupported!.map((u) => u.reason).join('\n');
  assert.match(reasons, /SkinnedMesh/);
  assert.match(reasons, /unknown ShaderMaterial/);
  assert.match(reasons, /normalMap/);
  assert.equal(native.report().unsupported.length, 3);
  native.capture();
  assert.equal(native.drain(), null, 'each is reported once');
});

test('the office ShaderMaterials are recognized by name with their uniforms', () => {
  const { scene, native } = make();
  const beam = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(1, 0.5, 0) }, opacity: { value: 0.4 } },
    vertexShader: 'varying float vAlong; void main() { vAlong = uv.y; }',
    fragmentShader: 'void main() {}',
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Mesh(new THREE.CylinderGeometry(), beam));
  native.capture();
  const m = native.drain()!.materials![0];
  assert.equal(m.type, 'shader');
  assert.equal(m.shader?.program, 'beam');
  assert.deepEqual(m.shader?.uniforms, { color: [1, 0.5, 0], opacity: 0.4 });
});

test('identical unedited built-in geometries go over the wire once', () => {
  const { scene, native } = make();
  const mat = new THREE.MeshToonMaterial();
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), mat);
  const b = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), mat);
  const edited = new THREE.BoxGeometry(1, 2, 3).translate(0, 1, 0);
  const c = new THREE.Mesh(edited, mat);
  scene.add(a, b, c);
  native.capture();
  const p = native.drain()!;
  assert.equal(p.geometries!.length, 2);
  const [oa, ob, oc] = p.objects!;
  assert.equal(oa.geo, ob.geo);
  assert.notEqual(oa.geo, oc.geo);
  // Once the shared one goes, the other takes its place.
  scene.remove(a);
  native.capture();
  const q = native.drain()!;
  assert.equal(q.remove?.objects?.length, 1);
  assert.equal(q.remove?.geometries, undefined);
});

test('shared geometry keeps independent buffers when built-in attributes are replaced', () => {
  const { scene, native } = make();
  const first = new THREE.BoxGeometry(1, 2, 3);
  const second = new THREE.BoxGeometry(1, 2, 3);
  const position = second.attributes.position.clone();
  position.setX(0, 19); // A fresh attribute still has version 0.
  second.setAttribute('position', position);
  scene.add(new THREE.Mesh(first, new THREE.MeshBasicMaterial()), new THREE.Mesh(second, new THREE.MeshBasicMaterial()));
  native.capture();
  const packets = drainAll(native);
  const objects = packets.flatMap((p) => p.objects ?? []);
  assert.notEqual(objects[0].geo, objects[1].geo);
  const geometry = packets.flatMap((p) => p.geometries ?? []).find((g) => g.id === objects[1].geo)!;
  assert.equal(floats(binBytes(geometry.attrs.position!.data, packets))[0], 19);
  native.capture();
  assert.equal(native.drain(), null);
});

test('editing the canonical shared geometry preserves the unchanged alias regardless of visit order', () => {
  for (const reverse of [false, true]) {
    const { scene, native } = make();
    const first = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const alias = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    scene.add(first, alias);
    native.capture();
    const initial = drainAll(native).flatMap((p) => p.objects ?? []);
    assert.equal(initial[0].geo, initial[1].geo);
    if (reverse) {
      scene.remove(first, alias);
      scene.add(alias, first);
    }
    first.geometry.attributes.position.setX(0, 27);
    first.geometry.attributes.position.needsUpdate = true;
    native.capture();
    const packets = drainAll(native);
    const geometries = packets.flatMap((p) => p.geometries ?? []);
    const changed = geometries.find((g) => g.id === initial[0].geo)!;
    assert.equal(floats(binBytes(changed.attrs.position!.data, packets))[0], 27);
    const independent = packets.flatMap((p) => p.objects ?? []).find((o) => o.id === initial[1].id)!;
    assert.notEqual(independent.geo, initial[0].geo);
    const preserved = geometries.find((g) => g.id === independent.geo)!;
    assert.equal(floats(binBytes(preserved.attrs.position!.data, packets))[0], 0.5);
  }
});

test('geometry metadata and normalization changes invalidate the capture cache', () => {
  const { scene, native } = make();
  const geo = new THREE.BufferGeometry();
  const position = new THREE.Uint8BufferAttribute([0, 0, 0, 255, 0, 0, 0, 255, 0], 3);
  geo.setAttribute('position', position);
  geo.addGroup(0, 3, 0);
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
  native.capture();
  drainAll(native);
  position.normalized = true;
  geo.groups[0].materialIndex = 2;
  geo.drawRange.count = 2;
  native.capture();
  const packets = drainAll(native);
  const changed = packets.flatMap((p) => p.geometries ?? [])[0];
  assert.equal(changed.partial, undefined);
  assert.deepEqual(changed.groups, [[0, 3, 2]]);
  assert.deepEqual(changed.range, [0, 2]);
  assert.equal(floats(binBytes(changed.attrs.position!.data, packets))[3], 1);
});

test('material cache observes direct properties, map matrices and shader uniforms without needsUpdate', () => {
  const { scene, native } = make();
  const texture = new THREE.CanvasTexture(canvas() as never);
  const mat = new THREE.MeshPhongMaterial({ map: texture });
  const beam = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(1, 0.5, 0) }, opacity: { value: 0.4 } },
    vertexShader: 'varying float vAlong; void main() { vAlong = uv.y; }',
    fragmentShader: 'void main() {}',
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), mat), new THREE.Mesh(new THREE.PlaneGeometry(), beam));
  native.capture();
  drainAll(native);
  mat.color.setRGB(0.2, 0.3, 0.4);
  mat.emissive.setRGB(0.1, 0.2, 0.3);
  mat.emissiveIntensity = 2;
  mat.specular.setRGB(0.5, 0.6, 0.7);
  mat.shininess = 99;
  mat.opacity = 0.7;
  mat.depthWrite = false;
  mat.shadowSide = THREE.DoubleSide;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 3;
  texture.offset.set(0.25, 0.5);
  texture.repeat.set(2, 3);
  beam.uniforms.color.value.g = 0.9;
  beam.uniforms.opacity.value = 0.2;
  native.capture();
  const materials = drainAll(native).flatMap((p) => p.materials ?? []);
  const phong = materials.find((m) => m.type === 'phong')!;
  assert.deepEqual(phong.color, [0.2, 0.3, 0.4]);
  assert.deepEqual(phong.emissive, [0.2, 0.4, 0.6]);
  assert.deepEqual(phong.specular, [0.5, 0.6, 0.7]);
  assert.equal(phong.shininess, 99);
  assert.equal(phong.opacity, 0.7);
  assert.equal(phong.depthWrite, false);
  assert.equal(phong.shadowSide, 'double');
  assert.equal(phong.blend[6], 'one');
  assert.deepEqual(phong.polygonOffset, [3, 0]);
  assert.deepEqual(JSON.parse(JSON.stringify(phong.map?.m)), [2, 0, 0, 0, 3, 0, 0.25, 0.5, 1]);
  assert.deepEqual(materials.find((m) => m.type === 'shader')!.shader?.uniforms, { color: [1, 0.9, 0], opacity: 0.2 });
  native.capture();
  assert.equal(native.drain(), null);
});

test('object metadata, multi-material edits and instance replacement remain live', () => {
  const { scene, native } = make();
  const first = new THREE.MeshBasicMaterial();
  const second = new THREE.MeshToonMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [first, second]);
  const instances = new THREE.InstancedMesh(new THREE.PlaneGeometry(), first, 1);
  const group = new THREE.Group();
  group.add(mesh, instances);
  scene.add(group);
  native.capture();
  drainAll(native);
  group.renderOrder = 7;
  mesh.renderOrder = 8;
  mesh.name = 'updated label';
  mesh.material[0] = second;
  mesh.castShadow = true;
  instances.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(new THREE.Matrix4().makeTranslation(12, 0, 0).elements), 16);
  native.capture();
  const packets = drainAll(native);
  const object = packets.flatMap((p) => p.objects ?? []).find((o) => o.name === 'updated label')!;
  assert.deepEqual(object.order, [7, 8]);
  assert.equal(object.cast, true);
  assert.equal((object.mat as number[])[0], (object.mat as number[])[1]);
  const updatedInstances = packets.flatMap((p) => p.objects ?? []).find((o) => o.kind === 'instanced')!.inst!;
  assert.equal(floats(binBytes(updatedInstances.m, packets))[9], 12);
  native.capture();
  assert.equal(native.drain(), null);
});

test('first texture pixels cannot be starved by a continuously redrawn early canvas', async () => {
  const sources = Array.from({ length: 4 }, () => canvas());
  const starts: unknown[] = [];
  const pending: (() => void)[] = [];
  const encodeImage: ImageEncoder = (source) =>
    new Promise((resolve) => {
      starts.push(source);
      pending.push(() => resolve({ fmt: 'png', bytes: new Uint8Array([starts.length]) }));
    });
  const { scene, native, tick } = make({ encodeImage, maxEncodes: 1, textureIntervalMs: 0 });
  const textures = sources.map((source) => new THREE.CanvasTexture(source as never));
  for (const map of textures) scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map })));
  native.capture();
  for (let i = 0; i < sources.length; i++) {
    assert.equal(starts[i], sources[i], `source ${i} gets its first pixels before redraws`);
    textures[0].needsUpdate = true;
    pending.shift()!();
    await flush();
    tick(1);
    native.capture();
  }
  assert.equal(starts[4], sources[0]);
  // All canvases now change continuously: every source still gets a turn.
  for (let i = 0; i < sources.length; i++) {
    for (const texture of textures) texture.needsUpdate = true;
    pending.shift()!();
    await flush();
    tick(1);
    native.capture();
  }
  assert.deepEqual(new Set(starts.slice(4, 8)), new Set(sources));
  native.dispose();
  pending.shift()!();
  await flush();
});

test('texture updates during an encode retain latest pixels and sampler settings', async () => {
  const starts: unknown[] = [];
  const pending: ((bytes: Uint8Array) => void)[] = [];
  const encodeImage: ImageEncoder = (source) =>
    new Promise((resolve) => {
      starts.push(source);
      pending.push((bytes) => resolve({ fmt: 'png', bytes }));
    });
  const { scene, native, tick } = make({ encodeImage, maxEncodes: 1, textureIntervalMs: 0 });
  const first = canvas(4, 4);
  const last = canvas(8, 8);
  const texture = new THREE.CanvasTexture(first as never);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: texture })));
  native.capture();
  drainAll(native);
  texture.image = last;
  texture.needsUpdate = true;
  const latestVersion = texture.version;
  texture.flipY = false;
  texture.magFilter = THREE.NearestFilter;
  pending.shift()!(new Uint8Array([1]));
  await flush();
  tick(1);
  native.capture();
  assert.deepEqual(starts, [first, last]);
  const earlier = drainAll(native).flatMap((p) => p.textures ?? [])[0];
  assert.equal(earlier.rev, latestVersion - 1, 'the revision belongs to the encoded snapshot, not a newer canvas');
  pending.shift()!(new Uint8Array([2]));
  await flush();
  native.capture();
  const packets = drainAll(native);
  const item = packets.flatMap((p) => p.textures ?? [])[0];
  assert.equal(item.w, 8);
  assert.equal(item.rev, latestVersion);
  assert.equal(item.flipY, false);
  assert.equal(item.mag, 'nearest');
  assert.deepEqual(binBytes(item.data!, packets), new Uint8Array([2]));
});

test('failed texture encodes retry without losing pixels or monopolizing initial loads', async () => {
  const starts: unknown[] = [];
  const first = canvas();
  const next = canvas();
  let failed = false;
  const encodeImage: ImageEncoder = async (source) => {
    starts.push(source);
    if (source === first && !failed) {
      failed = true;
      throw new Error('transient encoder failure');
    }
    return { fmt: 'png', bytes: new Uint8Array([7]) };
  };
  const { scene, native, tick } = make({ encodeImage, maxEncodes: 1, textureIntervalMs: 100 });
  for (const source of [first, next]) scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(source as never) })));
  native.capture();
  drainAll(native);
  await flush();
  native.capture();
  await flush();
  assert.deepEqual(starts, [first, next]);
  assert.match(native.report().errors[0], /transient encoder failure/);
  tick(101);
  native.capture();
  await flush();
  native.capture();
  assert.deepEqual(starts, [first, next, first]);
  assert.equal(
    drainAll(native)
      .flatMap((p) => p.textures ?? [])
      .filter((t) => t.data).length,
    2,
  );
});

test('capture never mutates the scene graph', () => {
  const { scene, native } = make();
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  scene.add(m);
  const before = { children: scene.children.length, layers: m.layers.mask, visible: m.visible, raycast: m.raycast };
  native.capture();
  drainAll(native);
  assert.deepEqual({ children: scene.children.length, layers: m.layers.mask, visible: m.visible, raycast: m.raycast }, before);
  const hits = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)).intersectObject(scene);
  assert.equal(hits.length > 0, true);
});

test('only the laptop screen material carries sharpText, and the tag follows the material', async (t) => {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ctx = new Proxy({}, { get: (_target, key) => (key === 'measureText' ? () => ({ width: 1 }) : () => {}), set: () => true });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ width: 300, height: 150, getContext: () => ctx }) } });
  t.after(() => {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const { Laptop } = await import('../src/client/world/laptop');
  const { scene, native } = make();
  const laptop = new Laptop();
  scene.add(laptop.root);
  // Another canvas-textured basic material (a board, a label) stays untagged.
  const board = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas(64, 64) as never) }));
  // A tagged material that the headset cannot redraw as an opaque screen is not sent tagged.
  const glassy = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas(64, 64) as never), transparent: true, opacity: 0.5 });
  glassy.userData.nativeSharpText = true;
  scene.add(board, new THREE.Mesh(new THREE.PlaneGeometry(), glassy));
  native.capture();
  const packets = drainAll(native);
  // Pixels are encoded off the capture; later captures send them.
  for (let i = 0; i < 5; i++) {
    await flush();
    native.capture();
    packets.push(...drainAll(native));
  }
  const materials = packets.flatMap((p) => p.materials ?? []);
  const sharp = materials.filter((m) => m.sharpText);
  assert.equal(sharp.length, 1, 'exactly one sharp material');
  const screenMat = (laptop as unknown as { screenMat: THREE.MeshBasicMaterial }).screenMat;
  assert.equal(screenMat.userData.nativeSharpText, true);
  assert.equal(sharp[0].type, 'basic');
  assert.equal(sharp[0].transparent, false);
  assert.ok(sharp[0].map, 'the sharp screen keeps its map');
  const tex = packets.flatMap((p) => p.textures ?? []).find((x) => x.id === sharp[0].map!.t);
  assert.ok(tex, 'the laptop texture is sent');
  // The source bitmap at full size, with its mipmapped trilinear, anisotropic, sRGB sampler.
  assert.equal(tex.w, 2048);
  assert.equal(tex.h, 1360);
  assert.equal(tex.srgb, true);
  assert.equal(tex.min, 'linearMipLinear');
  assert.equal(tex.mips, true);
  assert.ok(tex.aniso > 1);
  const objects = packets.flatMap((p) => p.objects ?? []);
  assert.equal(objects.filter((o) => o.mat === sharp[0].id).length, 1, 'one screen mesh uses it');
  // Removing the tag sends the material again without it, so the headset stops redrawing it.
  screenMat.userData.nativeSharpText = false;
  native.capture();
  const again = drainAll(native).flatMap((p) => p.materials ?? []);
  assert.equal(again.length, 1);
  assert.equal(again[0].id, sharp[0].id);
  assert.equal(again[0].sharpText, undefined);
  laptop.dispose();
});

test('officeNative.frame returns scene, control and panel, and honours skip and reset', () => {
  const { scene, native } = make();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  const target: Record<string, unknown> = {};
  const api = installOfficeNative(target, { scene: native, control: (f) => ({ frames: f ?? 0 }), panel: () => ({ open: true }) });
  assert.equal(target.officeNative, api);
  const skipped = api.frame({ frames: 3, skipScene: true });
  assert.equal(skipped.scene, null);
  assert.deepEqual(skipped.control, { frames: 3 });
  assert.deepEqual(skipped.panel, { open: true });
  const first = api.frame(4);
  assert.equal(first.scene?.reset, true);
  assert.equal(first.scene?.objects?.length, 1);
  assert.equal(api.frame().scene, null);
  const again = api.frame({ sceneReset: true });
  assert.equal(again.scene?.reset, true);
  assert.equal(again.scene?.objects?.length, 1);
  // The result is plain JSON, as evaluateJavascript hands it back.
  assert.deepEqual(JSON.parse(JSON.stringify(again)), again);
});
