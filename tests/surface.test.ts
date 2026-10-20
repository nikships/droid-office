import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import '../src/client/world/sky.js';
import { beveledBox, mergeByMaterial, setToonRamp, toon, toonUnique } from '../src/client/world/toon.js';
import { contactPixels, setContactFootprints, surfaceFinish, surfaceUniforms, withFinish } from '../src/client/world/surface.js';
import { materialFeatures } from '../src/client/shader-warmup.js';
import { ProbeGI } from '../src/client/world/remaster.js';

function compile(material: THREE.Material) {
  const source = THREE.ShaderLib.toon;
  const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: source.vertexShader, fragmentShader: source.fragmentShader };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
  return shader;
}

test('finishes reuse matching materials without changing Classic colors or aliasing matte ones', () => {
  const matte = toon('#abcdef');
  const metal = toon('#abcdef', { finish: 'metal' });
  const paint = toon('#abcdef', { finish: 'paint' });
  assert.equal(toon('#abcdef', { finish: 'metal' }), metal);
  assert.notEqual(matte, metal);
  assert.notEqual(paint, metal);
  assert.deepEqual(matte.color, metal.color);
  assert.equal(surfaceFinish(matte), null);
  assert.deepEqual(surfaceFinish(metal), [0.55, 0.3]);
  assert.notEqual(toonUnique('#abcdef', 'metal'), metal);
  assert.notEqual(toon('#abcdef', { transparent: true }), matte);
});

test('only opted-in materials compile surface and contact work, with distinct shader keys', () => {
  const matte = toonUnique('#ffffff');
  const metal = toonUnique('#ffffff', 'metal');
  const paint = toonUnique('#ffffff', 'paint');
  const floor = toonUnique('#ffffff');
  floor.userData.floorContact = true;
  assert.doesNotMatch(compile(matte).fragmentShader, /rmEnvironment|rmContactUv/);
  const shader = compile(metal);
  assert.match(shader.fragmentShader, /outgoingLight \+= reflectedLight.indirectSpecular/);
  assert.match(shader.fragmentShader, /rmSurface > 0.0 && skyIndoor > 0.0 && rmGIOnly < 0.5/);
  assert.match(shader.vertexShader, /rmRoomEnergy \* rmFill/);
  assert.doesNotMatch(shader.fragmentShader, /reflect\(|rmEnvironment/, 'reflection math runs per vertex, not per pixel');
  assert.match(shader.fragmentShader, /vRmSurface \* rmTint/);
  assert.equal(shader.uniforms.rmSurface, surfaceUniforms.rmSurface);
  assert.match(compile(floor).fragmentShader, /reflectedLight.indirectDiffuse \*= mix/);
  assert.notEqual(matte.customProgramCacheKey(), metal.customProgramCacheKey());
  assert.notEqual(matte.customProgramCacheKey(), floor.customProgramCacheKey());
  assert.equal(paint.customProgramCacheKey(), metal.customProgramCacheKey(), 'finish values share one shader');
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), metal), new THREE.Mesh(new THREE.PlaneGeometry(), floor));
  assert.ok(materialFeatures(group).some((f) => f.includes('surface')));
  assert.ok(materialFeatures(group).some((f) => f.includes('contact')));
});

test('smooth lighting has a continuous ramp instead of clamped quarter-circle plateaus', (t) => {
  t.after(() => setToonRamp('classic'));
  const material = toonUnique('#ffffff');
  const texture = material.gradientMap!;
  setToonRamp('smooth');
  assert.equal(material.gradientMap, texture);
  const { data, width } = texture.image as { data: Uint8Array; width: number };
  assert.equal(width, 64);
  assert.equal(texture.magFilter, THREE.LinearFilter);
  for (let i = 1; i < width; i++) assert.ok(data[i * 4] > data[(i - 1) * 4]);
  assert.equal(data[0], 55);
  assert.equal(data[(width - 1) * 4], 255);
  setToonRamp('classic');
  assert.equal(texture.magFilter, THREE.NearestFilter);
  assert.equal(texture.image.width, 3);
});

test('beveled solids retain their exact dimensions and have smooth edge normals', () => {
  const geometry = beveledBox(2.4, 0.05, 1.2);
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  assert.ok(size.distanceTo(new THREE.Vector3(2.4, 0.05, 1.2)) < 1e-6);
  const normals = geometry.getAttribute('normal');
  let diagonal = false;
  for (let i = 0; i < normals.count; i++) {
    const n = new THREE.Vector3().fromBufferAttribute(normals, i);
    assert.ok(Math.abs(n.length() - 1) < 1e-6);
    if (Math.abs(n.x) > 0.1 && Math.abs(n.y) > 0.1) diagonal = true;
  }
  assert.ok(diagonal);
  assert.ok(geometry.getAttribute('position').count <= 324);
  geometry.dispose();
});

test('contact atlas matches floor UV direction, feathers smoothly and leaves empty space white', () => {
  const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  const footprint = { minX: 2, maxX: 4, minZ: 1, maxZ: 3, strength: 0.4, feather: 1 };
  const data = contactPixels(bounds, [footprint], 100, 100);
  const at = (x: number, z: number) => data[Math.floor((10 - z) * 10) * 100 + Math.floor(x * 10)];
  assert.equal(at(3, 2), 153);
  assert.equal(at(3, 8), 255, 'north and south must not be mirrored');
  assert.equal(at(9, 9), 255);
  assert.ok(at(4.1, 2) < at(4.5, 2));
  assert.ok(at(4.5, 2) < at(4.9, 2));
  assert.deepEqual(contactPixels(bounds, [], 2, 2), new Uint8Array([255, 255, 255, 255]));
  assert.deepEqual(contactPixels(bounds, [{ ...footprint, minX: 20, maxX: 30 }], 2, 2), new Uint8Array([255, 255, 255, 255]));
  const overlap = contactPixels(bounds, [footprint, footprint], 100, 100);
  assert.ok(overlap[80 * 100 + 30] < data[80 * 100 + 30]);
});

test('the contact atlas is shared, linear, mipmapped and single-channel', () => {
  setContactFootprints([]);
  const texture = surfaceUniforms.rmContactMap.value!;
  setContactFootprints([]);
  assert.equal(surfaceUniforms.rmContactMap.value, texture);
  assert.equal(texture.format, THREE.RedFormat);
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.equal(texture.generateMipmaps, true);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.unpackAlignment, 1);
  assert.equal(surfaceFinish(withFinish(new THREE.MeshToonMaterial(), 'paint'))?.[0], 0.04);
  const invalid = new THREE.MeshToonMaterial();
  invalid.userData.remasterFinish = 'unknown';
  assert.equal(surfaceFinish(invalid), null);
});

test('wall contact is analytic, separate from the floor atlas and Classic lighting', () => {
  const wall = toonUnique('#ffffff');
  wall.userData.wallContact = true;
  const shader = compile(wall);
  assert.match(shader.fragmentShader, /rmJunction/);
  assert.doesNotMatch(shader.fragmentShader, /texture2D\( rmContactMap/);
  assert.equal(shader.uniforms.rmContact, surfaceUniforms.rmContact);
  assert.notEqual(wall.customProgramCacheKey(), toonUnique('#ffffff').customProgramCacheKey());
});

test('probe baking excludes view-dependent reflections and restores state even after a failed bake', (t) => {
  const previous = surfaceUniforms.rmSurface.value;
  const scene = new THREE.Scene();
  const gi = new ProbeGI(scene, null);
  const visible = new THREE.Object3D();
  const hidden = new THREE.Object3D();
  hidden.visible = false;
  gi.hideWhileBaking = () => [visible, hidden];
  gi.configure(true, 3, 0);
  surfaceUniforms.rmSurface.value = 1;
  t.after(() => {
    gi.configure(false, 3, 0);
    surfaceUniforms.rmSurface.value = previous;
  });
  gi.grid!.bake = () => {
    assert.equal(surfaceUniforms.rmSurface.value, 0);
    assert.equal(visible.visible, false);
    assert.equal(hidden.visible, false);
    throw new Error('capture failed');
  };
  gi.rebake();
  assert.throws(() => gi.step(null as unknown as THREE.WebGLRenderer), /capture failed/);
  assert.equal(surfaceUniforms.rmSurface.value, 1);
  assert.equal(visible.visible, true);
  assert.equal(hidden.visible, false);
});

test('static batching retains each painted face, triangle and local transform', () => {
  const root = new THREE.Group();
  root.position.set(10, 3, -2);
  const inside = toonUnique('#888888');
  const outside = toonUnique('#111111');
  const materials = [outside, inside, inside, inside, inside, inside];
  for (let i = 0; i < 2; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.2), materials);
    box.position.set(i * 3, 1.5, 0);
    root.add(box);
  }
  const merged = mergeByMaterial(root);
  assert.equal(merged.children.length, 2, 'twelve material draws become two');
  const counts = new Map<THREE.Material, number>();
  for (const object of merged.children) {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    counts.set(mesh.material, mesh.geometry.getAttribute('position').count / 3);
    assert.deepEqual(Object.keys(mesh.geometry.attributes).sort(), ['normal', 'position']);
  }
  assert.equal(counts.get(outside), 4);
  assert.equal(counts.get(inside), 20);
  const bounds = new THREE.Box3().setFromObject(merged);
  assert.ok(bounds.min.distanceTo(new THREE.Vector3(-1, 0, -0.1)) < 1e-6);
  assert.ok(bounds.max.distanceTo(new THREE.Vector3(4, 3, 0.1)) < 1e-6);
  assert.equal((root.children[0] as THREE.Mesh).geometry.index?.count, 36, 'source geometry is untouched');
});
