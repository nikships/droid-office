import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { resolveRemaster, type ToneMap } from '../src/client/remaster-settings.js';
import { Remaster } from '../src/client/world/remaster.js';

test('the grade compiles only its selected tone curve and reuses the program across unchanged settings', () => {
  const renderer = { getContext: () => ({}) } as unknown as THREE.WebGLRenderer;
  const settings = { ...resolveRemaster({ enabled: false, hdr: false }), gi: false };
  const remaster = new Remaster(renderer, new THREE.Scene(), { sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(), ambient: new THREE.AmbientLight() }, settings, () => {}, null);
  const grade = remaster.shaderPasses()[0].material;
  assert.equal(grade.defines.RM_TONE_MAP, 5, 'the locked picture starts with linear mapping');
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
