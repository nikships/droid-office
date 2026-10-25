import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { resolveRemaster, type ToneMap } from '../src/client/remaster-settings.js';
import { Remaster } from '../src/client/world/remaster.js';

test('the final full-screen pass clears canvas depth without writing it, so only Classic needs another clear before hands', () => {
  const draws: { target: THREE.WebGLRenderTarget | null; clear: boolean; depthWrite: boolean }[] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const renderer = {
    getContext: () => ({}),
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(100, 100),
    capabilities: { maxTextureSize: 4096 },
    autoClear: true,
    setRenderTarget: (next: THREE.WebGLRenderTarget | null) => {
      target = next;
    },
    render: (mesh: THREE.Mesh) => {
      draws.push({ target, clear: renderer.autoClear, depthWrite: (mesh.material as THREE.ShaderMaterial).depthWrite });
    },
  } as unknown as THREE.WebGLRenderer;
  const settings = { ...resolveRemaster({ enabled: true, hdr: false }), gi: false };
  const remaster = new Remaster(renderer, new THREE.Scene(), { sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(), ambient: new THREE.AmbientLight() }, settings, () => {}, null);
  let sceneTarget: THREE.WebGLRenderTarget | null = null;
  remaster.draw(() => {
    sceneTarget = target;
  });
  assert.equal(draws.length, 1, 'the locked picture grades straight to the canvas');
  assert.deepEqual(draws[0], { target: null, clear: true, depthWrite: false });
  assert.equal(sceneTarget!.samples, 2);
  assert.equal(sceneTarget!.texture.type, THREE.HalfFloatType);
  assert.equal(sceneTarget!.resolveDepthBuffer, false);
  for (const sharpen of [0.2, 0]) {
    draws.length = 0;
    renderer.capabilities.maxTextureSize = sharpen ? 4096 : 50;
    remaster.configure({ ...settings, sharpen });
    remaster.draw(() => {});
    assert.equal(draws.length, 2, sharpen ? 'sharpening adds the present pass' : 'the texture-size limit adds the present pass');
    assert.notEqual(draws[0].target, null, 'the grade now draws offscreen');
    assert.deepEqual(draws[1], { target: null, clear: true, depthWrite: false }, 'the present pass clears canvas depth too');
  }
  const main = readFileSync(new URL('../src/client/main.ts', import.meta.url), 'utf8');
  assert.match(main, /if \(!remaster.active\) renderer.clearDepth\(\);/);
  assert.match(main, /wandLight.visible = false;/);
  assert.match(main, /wandLight.intensity = tipNow && wandGlow > 0.02 \? wandGlow : 0;\s*wandLight.visible = wandLight.intensity > 0;/, 'only the already-zero light is omitted; the original glow cutoff stays unchanged');
  remaster.configure({ ...settings, enabled: false });
});

test('the grade compiles only its selected tone curve and reuses the program across unchanged settings', () => {
  const renderer = { getContext: () => ({}) } as unknown as THREE.WebGLRenderer;
  const settings = { ...resolveRemaster({ enabled: false, hdr: false }), gi: false };
  const remaster = new Remaster(renderer, new THREE.Scene(), { sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(), ambient: new THREE.AmbientLight() }, settings, () => {}, null);
  const grade = remaster.shaderPasses()[0].material;
  assert.equal(grade.defines.RM_TONE_MAP, 5, 'the locked picture starts with linear mapping');
  assert.equal(grade.defines.RM_IDENTITY_GRADE, 1);
  assert.equal(grade.uniforms.toneMap, undefined, 'no per-pixel curve selection remains');
  assert.match(grade.fragmentShader, /#if RM_TONE_MAP == 0/);
  assert.match(grade.fragmentShader, /#elif RM_TONE_MAP == 4/);
  assert.match(grade.fragmentShader, /return clamp\( c, 0.0, 1.0 \)/);
  const tones: ToneMap[] = ['neutral', 'agx', 'aces', 'reinhard', 'cineon', 'linear'];
  for (const [index, toneMap] of tones.entries()) {
    const version = grade.version;
    remaster.configure({ ...settings, toneMap });
    assert.equal(grade.defines.RM_TONE_MAP, index);
    assert.equal(grade.version, version + 1, 'a new curve invalidates the program');
    remaster.configure({ ...settings, toneMap, exposure: 1.5 });
    assert.equal(grade.version, version + 1, 'exposure and repeated settings reuse the compiled curve');
  }
});

test('identity grading is compiled out, while altered colors and the HDR debug view retain the full grade', () => {
  const renderer = { getContext: () => ({}) } as unknown as THREE.WebGLRenderer;
  const settings = { ...resolveRemaster({ enabled: false, hdr: false }), gi: false };
  const remaster = new Remaster(renderer, new THREE.Scene(), { sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(), ambient: new THREE.AmbientLight() }, settings, () => {}, null);
  const grade = remaster.shaderPasses()[0].material;
  assert.match(grade.fragmentShader, /#if RM_IDENTITY_GRADE == 0\s*\/\/ Contrast/);
  assert.match(grade.fragmentShader, /#if RM_IDENTITY_GRADE == 0\s*if \( view == 1 \)/);
  assert.match(grade.fragmentShader, /#if RM_TONE_MAP == 5[\s\S]*?c = clamp\( c, 0.0, peak \);[\s\S]*?#else\s*c = peak \* curve\( c \/ peak \);/);
  const version = grade.version;
  remaster.configure({ ...settings, exposure: 1.75, temperature: 1200, tint: 0.1, debug: 'gi' });
  assert.equal(grade.defines.RM_IDENTITY_GRADE, 1);
  assert.equal(grade.version, version, 'exposure, white balance and GI view keep the program');
  for (const change of [{ contrast: 1.1 }, { saturation: 0.9 }, { vibrance: 0.1 }, { debug: 'hdr' as const }]) {
    remaster.configure({ ...settings, ...change });
    assert.equal(grade.defines.RM_IDENTITY_GRADE, 0, JSON.stringify(change));
    const full = grade.version;
    remaster.configure({ ...settings, ...change, exposure: 0.8 });
    assert.equal(grade.version, full, 'changing values within a grading mode reuses its program');
    remaster.configure(settings);
    assert.equal(grade.defines.RM_IDENTITY_GRADE, 1);
  }
});

test('the simplified linear grade is identical at SDR white and the locked HDR peak', () => {
  const hdrPeak = resolveRemaster({ enabled: true, hdr: true }).hdrPeak;
  for (const peak of [1, hdrPeak]) {
    assert.ok(Number.isInteger(Math.log2(peak)), 'the direct clamp relies on a power-of-two peak');
    for (const value of [-Infinity, -100, -1, -0, 0, 0.00001, 0.0031308, 0.18, 0.5, 1, 2, 4, 8, 65504, Infinity]) {
      const color = Math.fround(value);
      const original = peak * Math.max(0, Math.min(1, Math.fround(color / peak)));
      const clamped = Math.max(0, Math.min(peak, color));
      assert.equal(original, clamped, `${value} at peak ${peak}`);
    }
  }
});
