import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { AXIS_PROBE_GLSL, axisProbeTexture, axisProbeUniforms, type ProbeAtlas } from '../src/client/world/probe-axis.js';
import { type BakeStore, ProbeGI, type SavedBake } from '../src/client/world/remaster.js';
import { toonUnique } from '../src/client/world/toon.js';

const NORMALS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];

function atlas(width = 2, height = 2, padded = 4): ProbeAtlas {
  const data = new Float32Array(width * height * padded * 7 * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.7) * 2;
  return { width, height, depth: padded * 7, data };
}

function coefficients(source: ProbeAtlas, voxel: number): THREE.SphericalHarmonics3 {
  const sh = new THREE.SphericalHarmonics3();
  const stride = source.data.length / 7;
  sh.coefficients.forEach((v, n) => {
    for (let c = 0; c < 3; c++) {
      const packed = n * 3 + c;
      v.setComponent(c, source.data[Math.floor(packed / 4) * stride + voxel * 4 + (packed % 4)]);
    }
  });
  return sh;
}

test('axis atlas matches three.js L2 irradiance for all six directions, channels and padded voxels', () => {
  const source = atlas();
  const before = source.data.slice();
  const texture = axisProbeTexture(source);
  const data = texture.image.data as Float32Array;
  const voxels = source.data.length / 28;
  for (let i = 0; i < voxels; i++) {
    for (const [slot, normal] of NORMALS.entries()) {
      const expected = coefficients(source, i).getIrradianceAt(normal, new THREE.Vector3());
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(data[slot * voxels * 4 + i * 4 + c] - expected.getComponent(c)) < 0.000002);
    }
  }
  assert.deepEqual(source.data, before, 'cached SH coefficients are never modified');
  assert.equal(texture.image.depth, 24);
  assert.equal(texture.type, THREE.FloatType);
  assert.equal(texture.format, THREE.RGBAFormat);
  assert.equal(texture.minFilter, THREE.LinearFilter);
  assert.equal(texture.magFilter, THREE.LinearFilter);
  assert.equal(texture.wrapR, THREE.ClampToEdgeWrapping);
  assert.equal(texture.generateMipmaps, false);
  texture.dispose();
});

test('signed light is preserved until after interpolation, including the boundary padding', () => {
  const source = atlas(1, 1);
  source.data.fill(0);
  // c0 only, with duplicated first/last slices in every padded sub-volume.
  source.data.set([-2, -2, -2], 0);
  source.data.set([-2, -2, -2], 4);
  source.data.set([1, 1, 1], 8);
  source.data.set([1, 1, 1], 12);
  const texture = axisProbeTexture(source);
  const data = texture.image.data as Float32Array;
  for (let slot = 0; slot < 6; slot++) {
    const i = slot * 16;
    assert.equal(data[i], data[i + 4]);
    assert.equal(data[i + 8], data[i + 12]);
    assert.ok(data[i + 4] < 0, 'clamping probes individually would change the interpolated light');
    assert.equal(Math.max(0, (data[i + 4] + data[i + 8]) / 2), 0);
    assert.ok((Math.max(0, data[i + 4]) + Math.max(0, data[i + 8])) / 2 > 0);
  }
  texture.dispose();
});

test('malformed atlas dimensions and lengths are rejected', () => {
  const source = atlas();
  for (const change of [{ width: 0 }, { width: 1.5 }, { height: -1 }, { depth: 27 }, { depth: 29 }, { data: new Float32Array(1) }]) {
    assert.throws(() => axisProbeTexture({ ...source, ...change }), RangeError);
  }
});

function rig(store: BakeStore | null) {
  const scene = new THREE.Scene();
  const gi = new ProbeGI(scene, store);
  gi.configure(true, 20, 0);
  gi.budgetMs = 1e6;
  const grid = gi.grid!;
  const source = atlas(grid.resolution.x, grid.resolution.y, grid.resolution.z + 2);
  const texture = new THREE.Data3DTexture(source.data, source.width, source.height, source.depth);
  texture.isRenderTargetTexture = true;
  grid.bake = () => {
    grid.texture = texture;
  };
  let layer = 0;
  let target: THREE.WebGLRenderTarget | null = null;
  let reads = 0;
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (next: THREE.WebGLRenderTarget | null, z = 0) => {
      target = next;
      layer = z;
    },
    initRenderTarget: () => {},
    copyTextureToTexture: () => {},
    readRenderTargetPixels: (_: THREE.WebGLRenderTarget, _x: number, _y: number, w: number, h: number, pixels: Float32Array) => {
      reads++;
      pixels.set(source.data.subarray(layer * w * h * 4, (layer + 1) * w * h * 4));
    },
  } as unknown as THREE.WebGLRenderer;
  return {
    gi,
    scene,
    source,
    renderer,
    reads: () => reads,
    dispose: () => {
      gi.configure(false, 20, 0);
      texture.dispose();
    },
  };
}

test('finishing a bake derives its atlas without a cache and invalidates it before rebaking or dropping the grid', (t) => {
  const r = rig(null);
  t.after(r.dispose);
  r.gi.setKey('first');
  assert.equal(axisProbeUniforms.rmAxisReady.value, 0);
  r.gi.step(r.renderer);
  assert.equal(r.gi.baked, true);
  assert.equal(r.gi.progress, 1);
  assert.equal(axisProbeUniforms.rmAxisReady.value, 1);
  assert.equal(r.reads(), r.source.depth);
  const first = axisProbeUniforms.rmAxisSH.value!;
  let disposed = 0;
  first.addEventListener('dispose', () => disposed++);
  r.gi.rebake();
  assert.equal(disposed, 1);
  assert.equal(axisProbeUniforms.rmAxisReady.value, 0);
  assert.equal(axisProbeUniforms.rmAxisSH.value, null);
  r.gi.step(r.renderer);
  assert.notEqual(axisProbeUniforms.rmAxisSH.value, first);
  r.gi.configure(false, 20, 0);
  assert.equal(r.scene.children.length, 0);
  assert.equal(axisProbeUniforms.rmAxisReady.value, 0);
});

test('a cached bake derives the atlas from the loaded coefficients without another GPU readback', async (t) => {
  let saved: SavedBake;
  const r = rig({
    load: async () => saved,
    save: async () => {
      throw new Error('unneeded save');
    },
  });
  t.after(r.dispose);
  saved = { ...r.source, key: 'cached' };
  r.gi.setKey('cached');
  await Promise.resolve();
  r.gi.step(r.renderer);
  assert.equal(r.gi.baked, true);
  assert.equal(r.reads(), 0);
  const expected = axisProbeTexture(saved);
  assert.deepEqual(axisProbeUniforms.rmAxisSH.value!.image.data, expected.image.data);
  expected.dispose();
  const first = axisProbeUniforms.rmAxisSH.value;
  // Same settings/key and a paused roof reuse the same table and program.
  r.gi.configure(true, 20, 0);
  r.gi.setKey('cached');
  r.gi.paused = true;
  r.gi.step(r.renderer);
  assert.equal(axisProbeUniforms.rmAxisSH.value, first);
  saved = { ...saved, key: 'bad', width: saved.width + 1 };
  r.gi.paused = false;
  r.gi.setKey('bad');
  await Promise.resolve();
  r.gi.step(r.renderer);
  assert.equal(r.gi.baking, true);
  assert.equal(axisProbeUniforms.rmAxisReady.value, 0);
});

test('a finished uncached bake saves the original coefficients, not the directional table', async (t) => {
  let saved: SavedBake | undefined;
  const r = rig({
    load: async () => null,
    save: async (value) => {
      saved = value;
    },
  });
  t.after(r.dispose);
  r.gi.setKey('new');
  await Promise.resolve();
  r.gi.step(r.renderer);
  assert.equal(saved?.key, 'new');
  assert.equal(saved?.depth, r.source.depth);
  assert.deepEqual(saved?.data, r.source.data);
  assert.equal(axisProbeUniforms.rmAxisSH.value!.image.depth, (r.source.depth / 7) * 6);
});

test('lit materials share the ready uniform, curved fallback and unchanged sample bias without shader variants', () => {
  const material = toonUnique('#ffffff');
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.toon.vertexShader,
    fragmentShader: THREE.ShaderLib.toon.fragmentShader,
  };
  material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  assert.equal((shader.uniforms as typeof axisProbeUniforms).rmAxisSH, axisProbeUniforms.rmAxisSH);
  assert.equal((shader.uniforms as typeof axisProbeUniforms).rmAxisReady, axisProbeUniforms.rmAxisReady);
  assert.ok(shader.fragmentShader.includes(AXIS_PROBE_GLSL));
  assert.match(AXIS_PROBE_GLSL, /return getLightProbeGridIrradiance\( worldPos, worldNormal \)/);
  assert.match(AXIS_PROBE_GLSL, /worldPos \+ worldNormal \* \( gridRange \/ \( res - 1.0 \) \) \* 0.5/);
  const key = material.customProgramCacheKey();
  axisProbeUniforms.rmAxisReady.value = 1;
  assert.equal(material.customProgramCacheKey(), key);
  axisProbeUniforms.rmAxisReady.value = 0;
  material.dispose();
});
