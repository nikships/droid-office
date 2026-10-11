import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Sky } from '../src/client/world/sky.js';

/** Runs the office's onBeforeCompile on three.js's own shader for `lib`, as the renderer would. */
function compile(mat: THREE.Material, lib: keyof typeof THREE.ShaderLib) {
  const src = THREE.ShaderLib[lib];
  const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: src.vertexShader, fragmentShader: src.fragmentShader };
  mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
  return shader;
}

const clearRooms = (shader: ReturnType<typeof compile>) => (shader.uniforms.skyClearRooms as { value: number }).value;

test('weather fog is cleared from office and garage fragments on lit materials', () => {
  const shader = compile(new THREE.MeshToonMaterial({ fog: true }), 'toon');
  assert.match(shader.vertexShader, /varying vec3 vSkyWorld;/);
  assert.match(shader.vertexShader, /vSkyWorld = \( modelMatrix \* skyW \)\.xyz;/);
  assert.match(shader.fragmentShader, /uniform float skyClearRooms, skyDrop, skyStreet;/);
  assert.match(shader.fragmentShader, /float skyRoom = skyClearRooms \* max\( skyInOffice\( vSkyWorld \), skyInGarage\( vSkyWorld \) \);/);
  assert.match(shader.fragmentShader, /float skyFogDepth = vFogDepth \* \( 1\.0 - skyRoom \);/);
  assert.match(shader.fragmentShader, /smoothstep\( fogNear, fogFar, skyFogDepth \/ skyReach \)/);
  assert.doesNotMatch(shader.fragmentShader, /#include <fog_fragment>/);
  assert.ok('skyClearRooms' in shader.uniforms);
});

test('unlit fogged materials get the room tests they need, but none of the lighting', () => {
  const shader = compile(new THREE.MeshBasicMaterial({ fog: true }), 'basic');
  assert.match(shader.fragmentShader, /float skyInOffice/);
  assert.match(shader.fragmentShader, /float skyFogDepth = vFogDepth \* \( 1\.0 - skyRoom \);/);
  assert.match(shader.vertexShader, /vSkyWorld = \( modelMatrix \* skyW \)\.xyz;/);
  assert.doesNotMatch(shader.fragmentShader, /skyLight/);
  assert.ok('skyStreet' in shader.uniforms && 'skyDrop' in shader.uniforms);
});

test('sprites, which skip <project_vertex>, still write where they are in the world', () => {
  const shader = compile(new THREE.SpriteMaterial(), 'sprite');
  assert.doesNotMatch(THREE.ShaderLib.sprite.vertexShader, /#include <project_vertex>/);
  assert.match(shader.vertexShader, /vSkyWorld = \( vec4\( mvPosition\.xyz, 0\.0 \) \* viewMatrix \)\.xyz \+ cameraPosition;/);
  assert.match(shader.fragmentShader, /float skyFogDepth/);
});

test('materials with neither fog nor lighting are left alone', () => {
  const shader = compile(new THREE.MeshDepthMaterial(), 'depth');
  assert.equal(shader.vertexShader, THREE.ShaderLib.depth.vertexShader);
  assert.deepEqual(shader.uniforms, {});
});

test('the roof keeps its fog whole, and coming back down clears the rooms again', () => {
  const shader = compile(new THREE.MeshBasicMaterial({ fog: true }), 'basic');
  const sky = { roof: false, roofStreet: 0 } as unknown as Sky;
  Sky.prototype.setRoof.call(sky, false);
  assert.equal(clearRooms(shader), 1, 'office floors, the garage and the street clear fog in the rooms');
  Sky.prototype.setRoof.call(sky, true, 20);
  assert.equal(clearRooms(shader), 0, 'the rooftop is outdoors');
  Sky.prototype.setRoof.call(sky, false);
  assert.equal(clearRooms(shader), 1);
});
