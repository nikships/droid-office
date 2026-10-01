/*
 * Browser half of compare.mjs. Each case builds a small scene out of the office's own materials
 * (world/toon.ts, the sky.ts patch, copies of the two ShaderMaterials), renders it with three.js r186,
 * then draws the same objects through raw WebGL2 with the programs scene_shaders.cpp generates, in the
 * same context, sharing three's textures (and, in one pass, its shadow map) so that the only thing
 * that differs is the GLSL. The uniforms are filled the way the native renderer fills them
 * (scene_uniforms.h): world-space lights, linear colors, the fog color sRGB-encoded.
 */
import * as THREE from 'three';
import { FLOOR, SLAB, STREET_Y, WALL_T } from '../../../../../../../src/shared/layout';
import '../../../../../../../src/client/world/sky';
import { cardSprite, textPlane, textSprite, toon } from '../../../../../../../src/client/world/toon';

const SIZE = 160;

type Shaders = Record<string, { vertex: string; fragment: string }>;
interface Case {
  name: string;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}
interface Stats {
  max: number;
  over2: number;
  over8: number;
  pixels: number;
}
export interface Result {
  name: string;
  keys: string[];
  srgb: Stats;
  srgbThreeShadowMap: Stats;
  linear: Stats;
  linearOpaque: Stats;
  /** Standard only: the same programs reading three's DFG LUT instead of DFGApprox, to isolate that one approximation. */
  srgbThreeDfg?: Stats;
  /** Cases with points: sRGB output with the points drawn as the native renderer's quads. */
  srgbPointQuads?: Stats;
  images: Record<string, string>;
}

// ---- The sky patch's uniforms ------------------------------------------------------------------

/** sky.ts keeps its uniforms private; its hook hands them to any shader it patches, as it does for scene.ts. */
function skyUniforms(): Record<string, { value: any }> {
  const shader = {
    uniforms: {} as Record<string, { value: any }>,
    vertexShader: '#include <common>\n#include <fog_pars_vertex>\n#include <fog_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <fog_pars_fragment>\n#include <lights_fragment_begin>\n#include <lights_fragment_end>\n#include <fog_fragment>',
  };
  (THREE.Material.prototype.onBeforeCompile as any).call(THREE.Material.prototype, shader, null);
  return shader.uniforms;
}
const sky = skyUniforms();

interface SkySetup {
  wet?: number;
  snow?: number;
  lamps?: { at: [number, number, number]; reach: number; color: [number, number, number] }[];
  screens?: { at: [number, number, number]; reach: number; dir: [number, number, number]; color: [number, number, number] }[];
}

function setSky(s: SkySetup): void {
  sky.skyOn.value = 1;
  sky.skyInside.value = 1;
  sky.skyOffice.value.setRGB(0.19, 0.13, 0.42);
  sky.skyGarage.value.setRGB(0.05, 0.12, 0.3);
  sky.skyWet.value = s.wet ?? 0;
  sky.skySnow.value = s.snow ?? 0;
  sky.skyDrop.value = 0;
  sky.skyStreet.value = STREET_Y;
  const lamps = s.lamps ?? [];
  sky.skyLampCount.value = lamps.length;
  const lmin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const lmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  lamps.forEach((l, i) => {
    sky.skyLamps.value.set([...l.at, l.reach], i * 4);
    sky.skyLampColors.value.set(l.color, i * 3);
    lmin.min(new THREE.Vector3(...l.at).subScalar(l.reach));
    lmax.max(new THREE.Vector3(...l.at).addScalar(l.reach));
  });
  if (!lamps.length) lmin.set(1, 1, 1), lmax.set(0, 0, 0);
  sky.skyLampMin.value.copy(lmin);
  sky.skyLampMax.value.copy(lmax);
  const screens = s.screens ?? [];
  sky.skyScreenCount.value = screens.length;
  const smin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const smax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  screens.forEach((l, i) => {
    sky.skyScreens.value.set([...l.at, l.reach], i * 4);
    sky.skyScreenDirs.value.set(l.dir, i * 3);
    sky.skyScreenColors.value.set(l.color, i * 3);
    smin.min(new THREE.Vector3(...l.at).subScalar(l.reach));
    smax.max(new THREE.Vector3(...l.at).addScalar(l.reach));
  });
  if (!screens.length) smin.set(1, 1, 1), smax.set(0, 0, 0);
  sky.skyScreenMin.value.copy(smin);
  sky.skyScreenMax.value.copy(smax);
}

// ---- Copies of the office's two ShaderMaterials -------------------------------------------------

/** world/sky.ts gradientDome()'s material, verbatim. */
function domeMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      top: { value: new THREE.Color('#07020d') },
      horizon: { value: new THREE.Color('#24102f') },
      glow: { value: new THREE.Color('#ff6a2a') },
      glowK: { value: 0.8 },
      moonDir: { value: new THREE.Vector3(0.2, 0.35, -0.9).normalize() },
      moonGlow: { value: new THREE.Color('#ffc46b') },
      opacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 glow;
      uniform float glowK;
      uniform vec3 moonDir;
      uniform vec3 moonGlow;
      uniform float opacity;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize( vDir );
        vec3 c = mix( horizon, top, smoothstep( 0.0, 0.6, d.y ) );
        c = mix( c, glow, glowK * exp( -abs( d.y ) * 7.0 ) );
        float m = max( dot( d, moonDir ), 0.0 );
        c += moonGlow * ( pow( m, 60.0 ) * 0.9 + pow( m, 10.0 ) * 0.14 );
        gl_FragColor = vec4( c, opacity );
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  mat.userData.model = 'skydome';
  return mat;
}

/** world/rooftop.ts beamMaterial(), verbatim. */
function beamMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color('#9ad8ff') }, opacity: { value: 0.9 } },
    vertexShader: `
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vAlong = uv.y;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vN = normalize( normalMatrix * normal );
        vView = normalize( -mv.xyz );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float opacity;
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        float edge = pow( abs( dot( normalize( vN ), normalize( vView ) ) ), 1.6 );
        float a = opacity * vAlong * vAlong * edge;
        gl_FragColor = vec4( color * a, a );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  m.userData.model = 'beam';
  return m;
}

/** sky.ts blobTexture(): the halos' and the snowflakes' soft dot. */
function blobTexture(inner: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(inner, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function stripes(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#f4a261' : '#2a9d8f';
    g.fillRect(i * 8, 0, 8, 64);
  }
  g.fillStyle = 'rgba(255,255,255,0.0)';
  g.clearRect(0, 0, 16, 16);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  t.offset.set(0.1, 0);
  return t;
}

// ---- The cases ----------------------------------------------------------------------------------

function lights(scene: THREE.Scene, shadowAt: THREE.Vector3): void {
  scene.add(new THREE.AmbientLight('#5a4a9c', 0.35));
  const hemi = new THREE.HemisphereLight('#2b2a6b', '#1a0d2c', 1.2);
  hemi.position.set(0.2, 1, 0.1);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight('#8f9cff', 2.2);
  moon.position.set(shadowAt.x + 6, shadowAt.y + 10, shadowAt.z + 4);
  moon.target.position.copy(shadowAt);
  moon.castShadow = true;
  moon.shadow.mapSize.set(512, 512);
  moon.shadow.camera.left = moon.shadow.camera.bottom = -6;
  moon.shadow.camera.right = moon.shadow.camera.top = 6;
  moon.shadow.camera.near = 0.5;
  moon.shadow.camera.far = 40;
  moon.shadow.bias = -0.0008;
  moon.shadow.normalBias = 0.02;
  moon.shadow.radius = 2;
  moon.shadow.intensity = 0.8;
  scene.add(moon, moon.target);
  const fill = new THREE.DirectionalLight('#ffb48c', 0.6);
  fill.position.set(shadowAt.x - 5, shadowAt.y + 3, shadowAt.z + 6);
  fill.target.position.copy(shadowAt);
  scene.add(fill, fill.target);
  const bulb = new THREE.PointLight('#ffcf8a', 6, 9, 2);
  bulb.position.set(shadowAt.x - 1.5, shadowAt.y + 2.2, shadowAt.z + 1.5);
  scene.add(bulb);
  const neon = new THREE.PointLight('#6fdcff', 3, 0, 1.4);
  neon.position.set(shadowAt.x + 2, shadowAt.y + 1, shadowAt.z - 1);
  scene.add(neon);
}

function base(fog: THREE.Fog | THREE.FogExp2 | null, eye: THREE.Vector3, at: THREE.Vector3): Case & { at: THREE.Vector3 } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a0720');
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);
  camera.position.copy(eye);
  camera.lookAt(at);
  return { name: '', scene, camera, at };
}

function toonScene(): Case {
  const at = new THREE.Vector3(2, 0.8, -3);
  const c = base(new THREE.Fog('#2c1345', 3, 14), new THREE.Vector3(2.5, 2.6, 2.5), at);
  setSky({ screens: [{ at: [at.x - 0.8, at.y + 0.4, at.z + 0.6], reach: 3.4, dir: [0.3, 0, 0.95], color: [0.29, 0.72, 1.0] }] });
  lights(c.scene, at);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), toon('#c9b79c'));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(at.x, 0, at.z);
  floor.receiveShadow = true;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 16), toon('#ef476f'));
  ball.position.set(at.x, 0.9, at.z);
  ball.castShadow = ball.receiveShadow = true;
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.4, 0.7), toon('#118ab2', { emissive: '#1a0033' }));
  box.position.set(at.x + 1.6, 0.7, at.z + 0.4);
  box.rotation.y = 0.6;
  box.castShadow = box.receiveShadow = true;
  const far = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 2), toon('#06d6a0'));
  far.position.set(at.x - 2, 1.5, at.z - 6);
  c.scene.add(floor, ball, box, far);
  c.name = 'toon-indoor-shadow-fog-sky';
  return c;
}

function outdoorScene(): Case {
  // Outside the office's walls, high over the street: wet ground, snow, lamps, the haze's reach.
  const at = new THREE.Vector3(FLOOR.maxX + 8, 0, 4);
  const c = base(new THREE.Fog('#2c1345', 6, 30), new THREE.Vector3(at.x - 3, 18, at.z + 9), at);
  setSky({
    wet: 0.6,
    snow: 0.45,
    lamps: [
      { at: [at.x - 1, 3, at.z + 1], reach: 7, color: [2.2, 1.4, 0.6] },
      { at: [at.x + 3, 3, at.z - 2], reach: 5, color: [0.6, 0.3, 1.9] },
    ],
  });
  lights(c.scene, at);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14, 4, 4), toon('#5b5f6b'));
  ground.rotation.x = -Math.PI / 2;
  ground.position.copy(at);
  ground.receiveShadow = true;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 3, 12), toon('#3a3f4b'));
  post.position.set(at.x - 1, 1.5, at.z + 1);
  post.castShadow = post.receiveShadow = true;
  const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshToonMaterial({ map: stripes(), gradientMap: toon('#fff').gradientMap }));
  crate.position.set(at.x + 1.5, 0.6, at.z);
  crate.rotation.y = 0.4;
  crate.castShadow = crate.receiveShadow = true;
  // Just inside the garage's mouth, under the bottom floor.
  const garage = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), toon('#e9c46a'));
  garage.position.set(FLOOR.maxX - 1, -SLAB - 1.2, FLOOR.maxZ - 1);
  c.scene.add(ground, post, crate, garage);
  c.name = 'toon-outdoor-wet-snow-lamps-haze';
  return c;
}

function toonVariants(): Case {
  const at = new THREE.Vector3(-4, 1, -2);
  const c = base(null, new THREE.Vector3(-4, 2.2, 2.2), at);
  setSky({});
  lights(c.scene, at);
  // No gradient map: three's fwidth() fallback.
  const plain = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 12), new THREE.MeshToonMaterial({ color: '#8338ec' }));
  plain.position.set(at.x - 1.2, at.y, at.z);
  // Emissive map.
  const glow = stripes();
  const lit = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), new THREE.MeshToonMaterial({ color: '#ffbe0b', emissive: '#ffffff', emissiveMap: glow, emissiveIntensity: 0.3, gradientMap: toon('#fff').gradientMap }));
  lit.position.set(at.x + 0.2, at.y + 0.2, at.z);
  // Flat shading (MeshToonMaterial has no flatShading in r186; Lambert does).
  const flat = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 0), new THREE.MeshLambertMaterial({ color: '#c77dff', flatShading: true }));
  flat.position.set(at.x + 1.3, at.y + 0.9, at.z - 0.3);
  // DoubleSide, seen from behind.
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.8), new THREE.MeshToonMaterial({ color: '#ef476f', side: THREE.DoubleSide, gradientMap: toon('#fff').gradientMap }));
  flag.position.set(at.x + 1.4, at.y, at.z);
  flag.rotation.y = Math.PI * 0.85;
  // BackSide.
  const inside = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshToonMaterial({ color: '#3a86ff', side: THREE.BackSide, gradientMap: toon('#fff').gradientMap }));
  inside.position.set(at.x - 0.4, at.y - 0.9, at.z + 0.6);
  // Instanced, non-uniform scale, per-instance color.
  const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 16, 8), toon('#ffffff'), 4);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 4; i++) {
    m.compose(new THREE.Vector3(at.x - 1.5 + i, at.y + 1.1, at.z - 0.5), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3 * i, 0.5, 0)), new THREE.Vector3(1 + i * 0.4, 1, 0.6));
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, new THREE.Color().setHSL(i / 4, 0.7, 0.55));
  }
  c.scene.add(plain, lit, flat, flag, inside, inst);
  c.name = 'toon-fallback-emissive-flat-double-back-instanced';
  return c;
}

function unlitScene(): Case {
  const at = new THREE.Vector3(0, 1.4, -2.5);
  const c = base(new THREE.Fog('#2c1345', 2, 12), new THREE.Vector3(0, 1.6, 0.6), at);
  setSky({});
  // Real office text: a wall sign (basic + map + alphaTest), a label sprite and a speech-bubble card.
  const sign = textPlane('Droid Office', { bg: '#fff3d6', size: 40 });
  sign.position.set(-0.9, 1.9, -2.6);
  const label = textSprite('claude · working', { bg: '#ffffff' });
  label.position.set(0.9, 1.9, -2.4);
  const card = cardSprite({ chip: { text: 'WORKING', bg: '#06d6a0', color: '#0a0a0a' }, title: 'Fix the elevator doors', body: 'Waiting on review', bg: '#ffffff' });
  card.position.set(0, 0.7, -2.2);
  const colors = new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed();
  const col: number[] = [];
  for (let i = 0; i < colors.attributes.position.count; i++) col.push((i % 3) / 2, ((i >> 1) % 3) / 2, 1 - (i % 5) / 4);
  colors.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const cube = new THREE.Mesh(colors, new THREE.MeshBasicMaterial({ vertexColors: true }));
  cube.position.set(1.1, 0.9, -2.8);
  cube.rotation.set(0.4, 0.7, 0);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.6), new THREE.MeshBasicMaterial({ color: '#9ad8ff', transparent: true, opacity: 0.35, premultipliedAlpha: true }));
  glass.position.set(-1.1, 0.8, -2.0);
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1.5, 0.2, -3), new THREE.Vector3(1.5, 2.4, -3.5), new THREE.Vector3(-1.5, 2.4, -3.5), new THREE.Vector3(1.5, 0.2, -3)]);
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: '#bcd0e6', transparent: true, opacity: 0.5, depthWrite: false }));
  // An alpha map, a rotated sprite and a fixed-size one.
  const cutout = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ color: '#ffd166', alphaMap: blobTexture(0.4), transparent: true, side: THREE.DoubleSide }));
  cutout.position.set(-0.3, 0.35, -2.4);
  const tilted = textSprite('elevator', { bg: '#ffe8a3' });
  tilted.material.rotation = 0.35;
  tilted.position.set(-1.2, 0.3, -2.9);
  const fixed = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTexture(0.2), color: '#ff5ea8', sizeAttenuation: false, transparent: true }));
  fixed.scale.set(0.06, 0.06, 1);
  fixed.position.set(1.3, 0.3, -3.2);
  c.scene.add(sign, label, card, cube, glass, lines, cutout, tilted, fixed);
  c.name = 'basic-text-sprite-card-line-premul';
  return c;
}

function pointsScene(): Case {
  const at = new THREE.Vector3(0, 30, -100);
  const c = base(new THREE.Fog('#2c1345', 20, 160), new THREE.Vector3(0, 2, 0), at);
  setSky({});
  const rnd = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1;
  const star: number[] = [];
  for (let i = 0; i < 300; i++) star.push(rnd(i) * 120, 10 + Math.abs(rnd(i + 7)) * 60, -170);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(star, 3));
  // sky.ts's stars, halos and snow.
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
  const halo: number[] = [];
  const haloCol: number[] = [];
  for (let i = 0; i < 12; i++) {
    halo.push(-12 + i * 2.2, 3 + (i % 3), -18 - (i % 4) * 6);
    const k = new THREE.Color().setHSL(i / 12, 0.8, 0.6);
    haloCol.push(k.r, k.g, k.b);
  }
  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.Float32BufferAttribute(halo, 3));
  haloGeo.setAttribute('color', new THREE.Float32BufferAttribute(haloCol, 3));
  const halos = new THREE.Points(haloGeo, new THREE.PointsMaterial({ size: 2.5, map: blobTexture(0.25), vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const flake: number[] = [];
  for (let i = 0; i < 80; i++) flake.push(rnd(i + 3) * 6, 0.5 + Math.abs(rnd(i + 11)) * 4, -2 - Math.abs(rnd(i + 5)) * 12);
  const flakeGeo = new THREE.BufferGeometry();
  flakeGeo.setAttribute('position', new THREE.Float32BufferAttribute(flake, 3));
  const flakes = new THREE.Points(flakeGeo, new THREE.PointsMaterial({ size: 0.14, map: blobTexture(0.5), transparent: true, depthWrite: false, color: '#ffffff' }));
  c.scene.add(stars, halos, flakes);
  c.name = 'points-stars-halos-snow';
  return c;
}

function domeScene(): Case {
  const c = base(new THREE.Fog('#2c1345', 20, 160), new THREE.Vector3(0, 2, 0), new THREE.Vector3(0.2, 8, -30));
  setSky({});
  const dome = new THREE.Mesh(new THREE.SphereGeometry(185, 32, 16), domeMaterial());
  dome.renderOrder = -1;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 2.4, 14, 24, 1, true), beamMaterial());
  beam.position.set(-3, 9, -22);
  beam.rotation.z = 0.3;
  const moonDisc = new THREE.Mesh(new THREE.SphereGeometry(3.2, 24, 16), new THREE.MeshBasicMaterial({ color: '#f2f1ea', transparent: true, fog: false, depthWrite: false }));
  moonDisc.position.set(6, 14, -60);
  c.scene.add(dome, beam, moonDisc);
  c.name = 'skydome-beam-moon';
  return c;
}

function pbrScene(): Case {
  const at = new THREE.Vector3(6, 1, 6);
  const c = base(new THREE.FogExp2('#2c1345', 0.06), new THREE.Vector3(6, 2.2, 10), at);
  setSky({ screens: [{ at: [at.x, at.y + 0.6, at.z + 1], reach: 3.4, dir: [0, 0, 1], color: [0.29, 0.72, 1.0] }] });
  lights(c.scene, at);
  const geo = new THREE.SphereGeometry(0.55, 32, 16);
  const std = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#c0c4cc', metalness: 0.7, roughness: 0.35 }));
  std.position.set(at.x - 1.3, at.y, at.z);
  const std2 = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#2a2d33', metalness: 0.0, roughness: 0.8 }));
  std2.position.set(at.x - 1.3, at.y + 1.2, at.z);
  const lam = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: '#e76f51', emissive: '#220000' }));
  lam.position.set(at.x, at.y, at.z);
  const pho = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: '#2a9d8f', specular: '#ffffff', shininess: 40 }));
  pho.position.set(at.x + 1.3, at.y, at.z);
  const t = new THREE.Mesh(geo, toon('#f4a261'));
  t.position.set(at.x, at.y + 1.2, at.z);
  std.castShadow = std.receiveShadow = lam.receiveShadow = pho.receiveShadow = true;
  c.scene.add(std, std2, lam, pho, t);
  c.name = 'standard-lambert-phong-exp2';
  return c;
}

const CASES = [toonScene, outdoorScene, toonVariants, unlitScene, pointsScene, domeScene, pbrScene];

// ---- Program keys, as the native renderer derives them (scene_model.cpp programKey) -------------

type Item = { obj: THREE.Mesh | THREE.Points | THREE.LineSegments | THREE.Sprite; mat: THREE.Material; key: string; depthKey: string };

function modelOf(obj: THREE.Object3D, m: THREE.Material): string {
  if ((m as THREE.ShaderMaterial).isShaderMaterial) return m.userData.model;
  if ((m as THREE.SpriteMaterial).isSpriteMaterial) return 'sprite';
  if ((m as THREE.PointsMaterial).isPointsMaterial) return 'points';
  if ((m as THREE.LineBasicMaterial).isLineBasicMaterial || (obj as THREE.Line).isLine) return 'line';
  if ((m as THREE.MeshToonMaterial).isMeshToonMaterial) return 'toon';
  if ((m as THREE.MeshLambertMaterial).isMeshLambertMaterial) return 'lambert';
  if ((m as THREE.MeshPhongMaterial).isMeshPhongMaterial) return 'phong';
  if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return 'standard';
  return 'basic';
}

const LIT = new Set(['toon', 'lambert', 'phong', 'standard']);

function keyOf(obj: THREE.Object3D, m: THREE.Material, scene: THREE.Scene, shadows: boolean, linear: boolean): string {
  const model = modelOf(obj, m);
  const lit = LIT.has(model);
  const shaderMat = model === 'beam' || model === 'skydome';
  const mm = m as any;
  const parts = [model];
  const add = (on: boolean, s: string) => on && parts.push(s);
  add(!shaderMat && !!mm.map, 'map');
  add(!shaderMat && !!mm.alphaMap, 'alphamap');
  add(lit && !!mm.emissiveMap, 'emissive');
  add(model === 'toon' && !!mm.gradientMap, 'gradient');
  add(!shaderMat && m.alphaTest > 0, 'alphatest');
  add(!shaderMat && !m.transparent && m.blending === THREE.NormalBlending, 'opaque');
  add(!shaderMat && m.premultipliedAlpha, 'premul');
  add(m.side === THREE.DoubleSide, 'double');
  add(m.side === THREE.BackSide, 'back');
  add(!!mm.flatShading, 'flat');
  add((model === 'points' || model === 'sprite') && mm.sizeAttenuation === false, 'fixedsize');
  add(!shaderMat, 'sky');
  const fog = !shaderMat && mm.fog && scene.fog;
  add(!!fog && !(scene.fog as THREE.FogExp2).isFogExp2, 'fog');
  add(!!fog && !!(scene.fog as THREE.FogExp2).isFogExp2, 'fog2');
  add(lit && shadows, 'shadow');
  add(!linear, 'srgbout');
  return parts.join('+');
}

function depthKeyOf(m: THREE.Material): string {
  const mm = m as any;
  const parts = ['depth'];
  const test = m.alphaTest > 0;
  if (test && mm.map) parts.push('map');
  if (test && mm.alphaMap) parts.push('alphamap');
  if (test) parts.push('alphatest');
  // A shadow pass draws the side opposite the material's, which the renderer handles by culling.
  parts.push('srgbout');
  return parts.join('+');
}

function items(c: Case, linear: boolean): Item[] {
  const out: Item[] = [];
  const shadows = c.scene.children.some((o) => (o as THREE.DirectionalLight).isDirectionalLight && o.castShadow);
  c.scene.traverse((o) => {
    const obj = o as Item['obj'];
    if (!(obj as THREE.Mesh).isMesh && !(obj as THREE.Points).isPoints && !(obj as THREE.Line).isLine && !(obj as THREE.Sprite).isSprite) return;
    const mat = obj.material as THREE.Material;
    out.push({ obj, mat, key: keyOf(obj, mat, c.scene, shadows, linear), depthKey: depthKeyOf(mat) });
  });
  return out;
}

// ---- Raw WebGL2 drawing with the generated programs ----------------------------------------------

interface Program {
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
}

const UNIFORMS = [
  'uModel',
  'uNormalMatrix',
  'uColor',
  'uEmissive',
  'uAlphaTest',
  'uMapTransform',
  'uAlphaMapTransform',
  'uEmissiveMapTransform',
  'uReceiveShadow',
  'uPointSize',
  'uPointQuad',
  'uSpriteCenter',
  'uSpriteRotation',
  'uMetalRough',
  'uSpecular',
  'uLightViewProj',
  'uSky0',
  'uSky1',
  'uSky2',
  'uSky3',
  'uSky4',
];
const SAMPLERS: [string, number][] = [
  ['uMap', 0],
  ['uAlphaMap', 1],
  ['uEmissiveMap', 2],
  ['uGradientMap', 3],
  ['uShadowMap', 4],
  ['uDfgLut', 5],
];

/** The generated Standard programs with DFGApprox's body swapped for r186's LUT read. */
function withThreeDfg(shaders: Shaders): Shaders {
  const out: Shaders = {};
  for (const [k, v] of Object.entries(shaders)) {
    const body = /(vec2 DFGApprox\( const in vec3 normal, const in vec3 viewDir, const in float roughness \) \{\n\tfloat dotNV = saturate\( dot\( normal, viewDir \) \);\n)[\s\S]*?\n\}/;
    const fragment = k.startsWith('standard')
      ? v.fragment.replace(body, '$1\treturn texture( uDfgLut, vec2( roughness, dotNV ) ).rg;\n}').replace('uniform vec2 uMetalRough;', 'uniform vec2 uMetalRough;\nuniform sampler2D uDfgLut;')
      : v.fragment;
    if (k.startsWith('standard') && !fragment.includes('uDfgLut, vec2')) throw new Error(`DFGApprox not found in ${k}`);
    out[k] = { vertex: v.vertex, fragment };
  }
  return out;
}

class Raw {
  private programs = new Map<string, Program>();
  private readonly view: WebGLBuffer;
  private readonly frame: WebGLBuffer;
  private readonly skyBuf: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers = new Map<unknown, WebGLBuffer>();
  readonly log: string[] = [];
  /** Bound to unit 5 for programs patched to read three's DFG LUT (see withThreeDfg). */
  dfg: WebGLTexture | null = null;
  /**
   * Draw non-indexed points the way the native renderer does: one instanced quad per point
   * (uPointQuad 1). Off, they are GL points (uPointQuad 0), so the shading is compared with three's
   * own points exactly; the quads' rasterization is compared on its own (srgbPointQuads).
   */
  pointQuads = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly shaders: Shaders,
  ) {
    this.view = gl.createBuffer()!;
    this.frame = gl.createBuffer()!;
    this.skyBuf = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
  }

  program(key: string): Program {
    const hit = this.programs.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const src = this.shaders[key];
    if (!src) throw new Error(`no shader for ${key}`);
    const stage = (type: number, text: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${key} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, stage(gl.VERTEX_SHADER, src.vertex));
    gl.attachShader(prog, stage(gl.FRAGMENT_SHADER, src.fragment));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`${key} link: ${gl.getProgramInfoLog(prog)}`);
    for (const [name, binding] of [
      ['Frame', 0],
      ['Sky', 1],
      ['View', 2],
    ] as const) {
      const i = gl.getUniformBlockIndex(prog, name);
      if (i !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(prog, i, binding);
        const size = gl.getActiveUniformBlockParameter(prog, i, gl.UNIFORM_BLOCK_DATA_SIZE);
        const want = { Frame: 576, Sky: 1760, View: 432 }[name];
        if (size !== want) this.log.push(`${key}: block ${name} is ${size} bytes on this driver, the struct ${want}`);
      }
    }
    const loc: Program['loc'] = {};
    for (const u of UNIFORMS) loc[u] = gl.getUniformLocation(prog, u);
    gl.useProgram(prog);
    for (const [u, unit] of SAMPLERS) {
      const l = gl.getUniformLocation(prog, u);
      if (l) gl.uniform1i(l, unit);
    }
    const p = { prog, loc };
    this.programs.set(key, p);
    return p;
  }

  private buffer(data: ArrayBufferView, target: number, owner: unknown): WebGLBuffer {
    const hit = this.buffers.get(owner);
    if (hit) return hit;
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    this.buffers.set(owner, b);
    return b;
  }

  private texture(t: THREE.Texture | null | undefined): WebGLTexture | null {
    if (!t) return null;
    return (this.renderer.properties.get(t) as { __webglTexture?: WebGLTexture }).__webglTexture ?? null;
  }

  uploadBlocks(c: Case, shadowMatrix: THREE.Matrix4 | null, light: THREE.DirectionalLight | null): void {
    const gl = this.gl;
    const cam = c.camera;
    const v = new Float32Array(108);
    const view = cam.matrixWorldInverse;
    const proj = cam.projectionMatrix;
    v.set(new THREE.Matrix4().multiplyMatrices(proj, view).elements, 0);
    v.set(view.elements, 32);
    v.set(proj.elements, 64);
    v.set([cam.position.x, cam.position.y, cam.position.z, 1], 96);
    v.set([SIZE, SIZE * 0.5, 0, 0], 104);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.view);
    gl.bufferData(gl.UNIFORM_BUFFER, v, gl.DYNAMIC_DRAW);

    const fb = new ArrayBuffer(576);
    const f = new Float32Array(fb);
    const fi = new Int32Array(fb);
    const fog = c.scene.fog as (THREE.Fog & THREE.FogExp2) | null;
    if (fog) {
      const enc = fog.color.clone();
      const rgb = { r: 0, g: 0, b: 0 };
      enc.getRGB(rgb, THREE.SRGBColorSpace);
      f.set([rgb.r, rgb.g, rgb.b, fog.isFogExp2 ? 2 : 1], 0);
      f.set([fog.near ?? 0, fog.far ?? 0, fog.density ?? 0, 0], 4);
    }
    let hemi = 0;
    let dir = 0;
    let point = 0;
    let shadowIndex = -1;
    const amb = new THREE.Color(0, 0, 0);
    // three puts the shadow-casting lights first; the renderer's counts.w says which one it is.
    const all: THREE.Light[] = [];
    c.scene.traverse((o) => (o as THREE.Light).isLight && all.push(o as THREE.Light));
    all.sort((a, b) => (b.castShadow ? 1 : 0) - (a.castShadow ? 1 : 0));
    for (const l of all) {
      const col = l.color.clone().multiplyScalar(l.intensity);
      if ((l as THREE.AmbientLight).isAmbientLight) amb.add(col);
      else if ((l as THREE.HemisphereLight).isHemisphereLight) {
        const h = l as THREE.HemisphereLight;
        const g = h.groundColor.clone().multiplyScalar(h.intensity);
        const d = new THREE.Vector3().setFromMatrixPosition(h.matrixWorld).normalize();
        f.set([col.r, col.g, col.b, 0], 16 + hemi * 4);
        f.set([g.r, g.g, g.b, 0], 24 + hemi * 4);
        f.set([d.x, d.y, d.z, 0], 32 + hemi * 4);
        hemi++;
      } else if ((l as THREE.DirectionalLight).isDirectionalLight) {
        const d = l as THREE.DirectionalLight;
        const to = new THREE.Vector3().setFromMatrixPosition(d.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(d.target.matrixWorld)).normalize();
        if (d === light) shadowIndex = dir;
        f.set([col.r, col.g, col.b, 0], 40 + dir * 4);
        f.set([to.x, to.y, to.z, 0], 48 + dir * 4);
        dir++;
      } else if ((l as THREE.PointLight).isPointLight) {
        const p = l as THREE.PointLight;
        const at = new THREE.Vector3().setFromMatrixPosition(p.matrixWorld);
        f.set([at.x, at.y, at.z, p.distance], 56 + point * 4);
        f.set([col.r, col.g, col.b, p.decay], 88 + point * 4);
        point++;
      }
    }
    f.set([amb.r, amb.g, amb.b, 0], 8);
    fi.set([hemi, dir, point, shadowIndex], 12);
    if (shadowMatrix && light) {
      f.set(shadowMatrix.elements, 120);
      f.set([light.shadow.bias, light.shadow.normalBias, light.shadow.radius, light.shadow.intensity], 136);
      f.set([light.shadow.mapSize.x, light.shadow.mapSize.y, 1 / light.shadow.mapSize.x, 1 / light.shadow.mapSize.y], 140);
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frame);
    gl.bufferData(gl.UNIFORM_BUFFER, fb, gl.DYNAMIC_DRAW);

    const sb = new ArrayBuffer(1760);
    const s = new Float32Array(sb);
    const si = new Int32Array(sb);
    const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T };
    s.set([sky.skyOn.value, sky.skyInside.value, sky.skyWet.value, sky.skySnow.value], 0);
    s.set([sky.skyDrop.value, sky.skyStreet.value, 6, 17.5], 4);
    s.set([300, 1, 0, 0], 8);
    s.set([sky.skyOffice.value.r, sky.skyOffice.value.g, sky.skyOffice.value.b, 0], 12);
    s.set([sky.skyGarage.value.r, sky.skyGarage.value.g, sky.skyGarage.value.b, 0], 16);
    s.set([FLOOR.minX - 0.02, -0.06, FLOOR.minZ - 0.02, 0], 20);
    s.set([FLOOR.maxX + 0.02, 40, FLOOR.maxZ + 0.02, 0], 24);
    s.set([B.minX + 0.05, B.minZ + 0.05, B.maxX, B.maxZ], 28);
    s.set([STREET_Y - 0.5, -SLAB + 0.02, 0, 0], 32);
    si.set([sky.skyLampCount.value, sky.skyScreenCount.value, 0, 0], 36);
    const v3 = (x: THREE.Vector3) => [x.x, x.y, x.z, 0];
    s.set(v3(sky.skyLampMin.value), 40);
    s.set(v3(sky.skyLampMax.value), 44);
    s.set(v3(sky.skyScreenMin.value), 48);
    s.set(v3(sky.skyScreenMax.value), 52);
    s.set(sky.skyLamps.value, 56);
    for (let i = 0; i < 24; i++) s.set(sky.skyLampColors.value.subarray(i * 3, i * 3 + 3), 152 + i * 4);
    s.set(sky.skyScreens.value, 248);
    for (let i = 0; i < 16; i++) {
      s.set(sky.skyScreenDirs.value.subarray(i * 3, i * 3 + 3), 312 + i * 4);
      s.set(sky.skyScreenColors.value.subarray(i * 3, i * 3 + 3), 376 + i * 4);
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.skyBuf);
    gl.bufferData(gl.UNIFORM_BUFFER, sb, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frame);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.skyBuf);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, this.view);
  }

  private attributes(it: Item): { count: number; instances: number; indexed: boolean; indexType: number } {
    const gl = this.gl;
    const geo = (it.obj as THREE.Mesh).geometry as THREE.BufferGeometry;
    gl.bindVertexArray(this.vao);
    for (let i = 0; i < 8; i++) {
      gl.disableVertexAttribArray(i);
      gl.vertexAttribDivisor(i, 0);
    }
    gl.vertexAttrib4f(1, 0, 0, 1, 0);
    gl.vertexAttrib4f(2, 0, 0, 0, 0);
    gl.vertexAttrib4f(3, 1, 1, 1, 1);
    gl.vertexAttrib4f(4, 1, 0, 0, 0);
    gl.vertexAttrib4f(5, 0, 1, 0, 0);
    gl.vertexAttrib4f(6, 0, 0, 1, 0);
    gl.vertexAttrib4f(7, 1, 1, 1, 1);
    const bind = (name: string, loc: number) => {
      const a = geo.attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
      if (!a) return;
      if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
        const ia = a as THREE.InterleavedBufferAttribute;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer(ia.data.array as Float32Array, gl.ARRAY_BUFFER, ia.data));
        gl.vertexAttribPointer(loc, ia.itemSize, gl.FLOAT, false, ia.data.stride * 4, ia.offset * 4);
      } else {
        const ba = a as THREE.BufferAttribute;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer(ba.array as Float32Array, gl.ARRAY_BUFFER, ba));
        gl.vertexAttribPointer(loc, ba.itemSize, gl.FLOAT, ba.normalized, 0, 0);
      }
      gl.enableVertexAttribArray(loc);
    };
    bind('position', 0);
    bind('normal', 1);
    bind('uv', 2);
    if (it.mat.vertexColors) bind('color', 3);
    let instances = 1;
    const im = it.obj as unknown as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      instances = im.count;
      const e = im.instanceMatrix.array as Float32Array;
      const rows = new Float32Array(instances * 12);
      for (let i = 0; i < instances; i++) for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) rows[i * 12 + r * 4 + k] = e[i * 16 + k * 4 + r];
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer(rows, gl.ARRAY_BUFFER, im.instanceMatrix));
      for (let r = 0; r < 3; r++) {
        gl.vertexAttribPointer(4 + r, 4, gl.FLOAT, false, 48, r * 16);
        gl.vertexAttribDivisor(4 + r, 1);
        gl.enableVertexAttribArray(4 + r);
      }
      if (im.instanceColor) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer(im.instanceColor.array as Float32Array, gl.ARRAY_BUFFER, im.instanceColor));
        gl.vertexAttribPointer(7, 3, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(7, 1);
        gl.enableVertexAttribArray(7);
      }
    }
    const index = geo.index;
    if (index) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffer(index.array as Uint16Array, gl.ELEMENT_ARRAY_BUFFER, index));
      return { count: index.count, instances, indexed: true, indexType: index.array instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
    }
    return { count: geo.attributes.position.count, instances, indexed: false, indexType: 0 };
  }

  private drawCall(it: Item, mode: number): void {
    const gl = this.gl;
    const a = this.attributes(it);
    if (this.pointQuads && mode === gl.POINTS && !a.indexed) {
      // The native renderer draws each point as a quad: its attributes advance per instance and
      // the vertex stage builds the square from gl_VertexID (scene_shaders.cpp, uPointQuad).
      gl.vertexAttribDivisor(0, 1);
      gl.vertexAttribDivisor(3, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, a.count);
      return;
    }
    if (a.indexed) gl.drawElementsInstanced(mode, a.count, a.indexType, 0, a.instances);
    else gl.drawArraysInstanced(mode, 0, a.count, a.instances);
  }

  private mode(it: Item): number {
    const gl = this.gl;
    if ((it.obj as THREE.Points).isPoints) return gl.POINTS;
    if ((it.obj as THREE.LineSegments).isLineSegments) return gl.LINES;
    if ((it.obj as THREE.Line).isLine) return gl.LINE_STRIP;
    return gl.TRIANGLES;
  }

  private bindTextures(it: Item, shadowTex: WebGLTexture | null): void {
    const gl = this.gl;
    const m = it.mat as any;
    const units: [number, THREE.Texture | null | undefined][] = [
      [0, m.map],
      [1, m.alphaMap],
      [2, m.emissiveMap],
      [3, m.gradientMap],
    ];
    for (const [unit, t] of units) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.texture(t));
    }
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.dfg);
    gl.activeTexture(gl.TEXTURE0);
  }

  private uniforms(p: Program, it: Item): void {
    const gl = this.gl;
    const m = it.mat as any;
    const L = p.loc;
    const o = it.obj;
    gl.uniformMatrix4fv(L.uModel, false, o.matrixWorld.elements);
    gl.uniformMatrix3fv(L.uNormalMatrix, false, new THREE.Matrix3().getNormalMatrix(o.matrixWorld).elements);
    const sh = m as THREE.ShaderMaterial;
    if (sh.isShaderMaterial) {
      const u = sh.uniforms;
      if (m.userData.model === 'beam') gl.uniform4f(L.uColor, u.color.value.r, u.color.value.g, u.color.value.b, u.opacity.value);
      else {
        gl.uniform4f(L.uColor, 1, 1, 1, u.opacity.value);
        gl.uniform4f(L.uSky0, u.top.value.r, u.top.value.g, u.top.value.b, 0);
        gl.uniform4f(L.uSky1, u.horizon.value.r, u.horizon.value.g, u.horizon.value.b, 0);
        gl.uniform4f(L.uSky2, u.glow.value.r, u.glow.value.g, u.glow.value.b, u.glowK.value);
        gl.uniform4f(L.uSky3, u.moonDir.value.x, u.moonDir.value.y, u.moonDir.value.z, 0);
        gl.uniform4f(L.uSky4, u.moonGlow.value.r, u.moonGlow.value.g, u.moonGlow.value.b, 0);
      }
      return;
    }
    gl.uniform4f(L.uColor, m.color.r, m.color.g, m.color.b, m.opacity);
    if (m.emissive) gl.uniform3f(L.uEmissive, m.emissive.r * m.emissiveIntensity, m.emissive.g * m.emissiveIntensity, m.emissive.b * m.emissiveIntensity);
    gl.uniform1f(L.uAlphaTest, m.alphaTest);
    const tm = (t: THREE.Texture | null | undefined, l: WebGLUniformLocation | null) => {
      if (!t) return;
      if (t.matrixAutoUpdate) t.updateMatrix();
      gl.uniformMatrix3fv(l, false, t.matrix.elements);
    };
    tm(m.map, L.uMapTransform);
    tm(m.alphaMap, L.uAlphaMapTransform);
    tm(m.emissiveMap, L.uEmissiveMapTransform);
    gl.uniform1f(L.uReceiveShadow, o.receiveShadow ? 1 : 0);
    if (m.isPointsMaterial) {
      gl.uniform1f(L.uPointSize, m.size);
      gl.uniform1i(L.uPointQuad, this.pointQuads && !((o as THREE.Points).geometry as THREE.BufferGeometry).index ? 1 : 0);
    }
    const sp = o as THREE.Sprite;
    if (sp.isSprite) {
      gl.uniform2f(L.uSpriteCenter, sp.center.x, sp.center.y);
      gl.uniform1f(L.uSpriteRotation, m.rotation);
    }
    if (m.isMeshStandardMaterial) gl.uniform2f(L.uMetalRough, m.metalness, m.roughness);
    if (m.isMeshPhongMaterial) gl.uniform4f(L.uSpecular, m.specular.r, m.specular.g, m.specular.b, Math.max(m.shininess, 1e-4));
  }

  /** three.js's per-material state: blending, depth, culling. */
  private state(it: Item, depthPass: boolean): void {
    const gl = this.gl;
    const m = it.mat;
    const side = depthPass ? ({ [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide } as Record<number, number>)[m.side] : m.side;
    if (side === THREE.DoubleSide) gl.disable(gl.CULL_FACE);
    else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(side === THREE.BackSide ? gl.FRONT : gl.BACK);
    }
    gl.frontFace(gl.CCW);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(depthPass || m.depthWrite);
    if (depthPass || (!m.transparent && m.blending === THREE.NormalBlending) || m.blending === THREE.NoBlending) {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    if (m.blending === THREE.AdditiveBlending) {
      if (m.premultipliedAlpha) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
    } else if (m.premultipliedAlpha) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** The shadow pass with the Depth programs, into a depth texture set up like three's (LEQUAL compare, linear). */
  depthPass(list: Item[], light: THREE.DirectionalLight): WebGLTexture {
    const gl = this.gl;
    const w = light.shadow.mapSize.x;
    const h = light.shadow.mapSize.y;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.viewport(0, 0, w, h);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const cam = light.shadow.camera;
    const lvp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    for (const it of list) {
      if (!it.obj.castShadow || !(it.obj as THREE.Mesh).isMesh) continue;
      const p = this.program(it.depthKey);
      gl.useProgram(p.prog);
      this.state(it, true);
      this.uniforms(p, it);
      gl.uniformMatrix4fv(p.loc.uLightViewProj, false, lvp.elements);
      this.bindTextures(it, null);
      this.drawCall(it, gl.TRIANGLES);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return tex;
  }

  draw(c: Case, list: Item[], target: WebGLFramebuffer | null, clearLinear: boolean, shadowTex: WebGLTexture | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, SIZE, SIZE);
    const bg = c.scene.background as THREE.Color;
    const rgb = { r: 0, g: 0, b: 0 };
    bg.getRGB(rgb, clearLinear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.clearColor(rgb.r, rgb.g, rgb.b, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // three's order: opaque front to back, then transparent back to front, each by renderOrder first.
    const pv = new THREE.Matrix4().multiplyMatrices(c.camera.projectionMatrix, c.camera.matrixWorldInverse);
    // three's projectObject: a sprite's origin, anything else its bounding sphere's center.
    const z = (it: Item) => {
      if ((it.obj as THREE.Sprite).isSprite) return new THREE.Vector3().setFromMatrixPosition(it.obj.matrixWorld).applyMatrix4(pv).z;
      const im = it.obj as unknown as THREE.InstancedMesh;
      if (im.isInstancedMesh && im.boundingSphere === null) im.computeBoundingSphere();
      const geo = (it.obj as THREE.Mesh).geometry;
      if (!im.isInstancedMesh && geo.boundingSphere === null) geo.computeBoundingSphere();
      const center = (im.isInstancedMesh ? im.boundingSphere! : geo.boundingSphere!).center;
      return center.clone().applyMatrix4(it.obj.matrixWorld).applyMatrix4(pv).z;
    };
    const opaque = list.filter((it) => !it.mat.transparent).sort((a, b) => a.obj.renderOrder - b.obj.renderOrder || z(a) - z(b));
    const transparent = list.filter((it) => it.mat.transparent).sort((a, b) => a.obj.renderOrder - b.obj.renderOrder || z(b) - z(a));
    for (const it of [...opaque, ...transparent]) {
      const p = this.program(it.key);
      gl.useProgram(p.prog);
      this.state(it, false);
      this.uniforms(p, it);
      this.bindTextures(it, shadowTex);
      this.drawCall(it, this.mode(it));
    }
    gl.bindVertexArray(null);
  }
}

// ---- Running a case ----------------------------------------------------------------------------

function read(gl: WebGL2RenderingContext): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

function compare(a: Uint8Array, b: Uint8Array, mask?: Uint8Array): Stats {
  const s: Stats = { max: 0, over2: 0, over8: 0, pixels: 0 };
  for (let i = 0; i < a.length; i += 4) {
    if (mask && !mask[i / 4]) continue;
    s.pixels++;
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    s.max = Math.max(s.max, d);
    if (d > 2) s.over2++;
    if (d > 8) s.over8++;
  }
  return s;
}

function png(px: Uint8Array): string {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d')!;
  const img = g.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) img.data.set(px.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function diffImage(a: Uint8Array, b: Uint8Array): Uint8Array {
  const d = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 4) {
    const m = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    d[i] = Math.min(255, m * 16);
    d[i + 1] = m > 2 ? 0 : Math.min(255, m * 16);
    d[i + 2] = 0;
    d[i + 3] = 255;
  }
  return d;
}

let renderer: THREE.WebGLRenderer;

function setup(): THREE.WebGLRenderer {
  if (renderer) return renderer;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.appendChild(canvas);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/** The program keys every case needs, for scene_shaders.cpp to generate. */
function keys(): string[] {
  const set = new Set<string>();
  for (const make of CASES) {
    const c = make();
    for (const linear of [false, true]) for (const it of items(c, linear)) set.add(it.key).add(it.depthKey);
  }
  return [...set];
}

function run(shaders: Shaders): { results: Result[]; log: string[] } {
  const r = setup();
  const gl = r.getContext() as WebGL2RenderingContext;
  const raw = new Raw(gl, r, shaders);
  const results: Result[] = [];

  const color = gl.createRenderbuffer()!;
  gl.bindRenderbuffer(gl.RENDERBUFFER, color);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.SRGB8_ALPHA8, SIZE, SIZE);
  const depth = gl.createRenderbuffer()!;
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, SIZE, SIZE);
  const srgbFbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, srgbFbo);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) raw.log.push('SRGB8_ALPHA8 framebuffer incomplete');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  for (const make of CASES) {
    const c = make();
    r.resetState();
    r.setRenderTarget(null);
    r.render(c.scene, c.camera);
    const expected = read(gl);

    let light: THREE.DirectionalLight | null = null;
    c.scene.traverse((o) => {
      if ((o as THREE.DirectionalLight).isDirectionalLight && o.castShadow) light = o as THREE.DirectionalLight;
    });
    const L = light as THREE.DirectionalLight | null;
    const threeShadow = L?.shadow.map?.depthTexture ? ((r.properties.get(L.shadow.map.depthTexture) as { __webglTexture?: WebGLTexture }).__webglTexture ?? null) : null;

    const srgbItems = items(c, false);
    const linearItems = items(c, true);
    raw.uploadBlocks(c, L ? L.shadow.matrix : null, L);

    raw.draw(c, srgbItems, null, false, threeShadow);
    const mineThreeShadow = read(gl);
    const own = L ? raw.depthPass(srgbItems, L) : null;
    raw.draw(c, srgbItems, null, false, own);
    const mine = read(gl);
    raw.draw(c, linearItems, srgbFbo, true, own);
    const mineLinear = read(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Where only opaque objects cover the pixel: blending in linear space is an accepted difference.
    const noTransparent = new Uint8Array(SIZE * SIZE).fill(1);
    {
      const transparent = srgbItems.filter((it) => it.mat.transparent);
      if (transparent.length) {
        raw.draw(
          c,
          transparent.map((it) => ({ ...it, mat: Object.assign(it.mat.clone(), { transparent: true, blending: THREE.NoBlending }) })),
          null,
          false,
          own,
        );
        const cover = read(gl);
        const bg = { r: 0, g: 0, b: 0 };
        (c.scene.background as THREE.Color).getRGB(bg, THREE.SRGBColorSpace);
        for (let i = 0; i < noTransparent.length; i++) {
          const same = Math.abs(cover[i * 4] - bg.r * 255) < 1.5 && Math.abs(cover[i * 4 + 1] - bg.g * 255) < 1.5 && Math.abs(cover[i * 4 + 2] - bg.b * 255) < 1.5;
          noTransparent[i] = same ? 1 : 0;
        }
      }
    }
    let srgbThreeDfg: Stats | undefined;
    const std = srgbItems.find((it) => it.key.startsWith('standard'));
    if (std) {
      const lut = (r.properties.get(std.mat) as { uniforms?: Record<string, { value: THREE.Texture | null }> }).uniforms?.dfgLUT?.value;
      const lutRaw = new Raw(gl, r, withThreeDfg(shaders));
      lutRaw.dfg = lut ? ((r.properties.get(lut) as { __webglTexture?: WebGLTexture }).__webglTexture ?? null) : null;
      if (!lutRaw.dfg) raw.log.push("three's DFG LUT texture not found");
      lutRaw.uploadBlocks(c, L ? L.shadow.matrix : null, L);
      lutRaw.draw(c, srgbItems, null, false, own);
      srgbThreeDfg = compare(expected, read(gl));
    }
    let srgbPointQuads: Stats | undefined;
    let pointQuadImage: Uint8Array | undefined;
    if (srgbItems.some((it) => (it.obj as THREE.Points).isPoints)) {
      raw.pointQuads = true;
      raw.draw(c, srgbItems, null, false, own);
      pointQuadImage = read(gl);
      srgbPointQuads = compare(expected, pointQuadImage);
      raw.pointQuads = false;
    }
    if (own) gl.deleteTexture(own);
    r.resetState();

    results.push({
      name: c.name,
      keys: [...new Set(srgbItems.map((it) => it.key))],
      srgb: compare(expected, mine),
      srgbThreeShadowMap: compare(expected, mineThreeShadow),
      linear: compare(expected, mineLinear),
      linearOpaque: compare(expected, mineLinear, noTransparent),
      srgbThreeDfg,
      srgbPointQuads,
      images: {
        three: png(expected),
        native: png(mine),
        nativeLinear: png(mineLinear),
        diff: png(diffImage(expected, mine)),
        diffLinear: png(diffImage(expected, mineLinear)),
        ...(pointQuadImage ? { pointQuads: png(pointQuadImage), diffPointQuads: png(diffImage(expected, pointQuadImage)) } : {}),
      },
    });
  }
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  raw.log.push(`GL renderer: ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`);
  return { results, log: raw.log };
}

(window as any).harness = { keys, run };
