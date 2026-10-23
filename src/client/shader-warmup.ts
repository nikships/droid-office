/**
 * Compiles the shaders a session can ask for while the loading screen is up, and keeps the materials that
 * hold them. three.js drops a program when the last material using it is disposed, so the stand-ins stay
 * alive for the page. The browser stores the compiled shaders itself (nothing here writes a binary cache;
 * WebGL does not hand the program back), and the next launch compiles them again only as far as that cache
 * misses, still during loading rather than when the wand comes out.
 *
 * No DOM or WebGL at import time, so tests can load it in Node.
 */
import * as THREE from 'three';
import { LightProbeGridWebGL } from 'three/examples/jsm/lighting/LightProbeGridWebGL.js';
import { casualtyMarkers } from './world/casualties';
import { toonifyProp } from './world/factory-props';
import { BloodSpray, Muzzle, Puff, magnum } from './world/gun';
import { toonUnique } from './world/toon';
import { surfaceFinish } from './world/surface';
import { teamKitStandIn } from './world/team-kit';
import { SpellBolt, SpellImpact, Sparkles, TipTrail, Wand } from './world/wand';

/**
 * Point lights the office shaders are compiled for: the wand's light, which stays in the scene, plus three
 * heavenly beams. A dismissal past that still compiles, and it is the rare case.
 */
export const WORLD_POINT_LIGHTS = 4;

/** Where a draw lands, as far as the shader key cares. `canvas` and `srgb` compile to the same program. */
export type DrawPipeline = 'canvas' | 'float' | 'srgb';

export interface OfficeCombo {
  lights: number;
  pipeline: DrawPipeline;
  grid: boolean;
}

export interface HandsCombo {
  lights: 0 | 1;
  toneMapping: THREE.ToneMapping;
}

/** Tone maps the Remastered renderer can put on the hands, plus classic's none. */
export const HAND_TONE_MAPS: readonly THREE.ToneMapping[] = [THREE.NoToneMapping, THREE.LinearToneMapping, THREE.ReinhardToneMapping, THREE.CineonToneMapping, THREE.ACESFilmicToneMapping, THREE.AgXToneMapping, THREE.NeutralToneMapping];

/**
 * Every world lighting and target combination, with the one the first frame will use last, so each
 * material's current program is that one.
 */
export function officeCombos(input: { pipelines: readonly DrawPipeline[]; grid: boolean; active: { pipeline: DrawPipeline; grid: boolean } }): OfficeCombo[] {
  const pipelines = input.pipelines.includes(input.active.pipeline) ? input.pipelines : [...input.pipelines, input.active.pipeline];
  const grids = input.grid ? [false, true] : [false];
  const activeGrid = input.grid && input.active.grid;
  const combos: OfficeCombo[] = [];
  for (const pipeline of pipelines) for (const grid of grids) for (let lights = 1; lights <= WORLD_POINT_LIGHTS; lights++) combos.push({ lights, pipeline, grid });
  const index = combos.findIndex((combo) => combo.lights === 1 && combo.pipeline === input.active.pipeline && combo.grid === activeGrid);
  if (index >= 0) combos.push(combos.splice(index, 1)[0]);
  return combos;
}

/** Hands lighting and tone-mapping combinations. The first frame's (no wand light, the renderer's current map) is last. */
export function handsCombos(active: THREE.ToneMapping): HandsCombo[] {
  const tones = HAND_TONE_MAPS.includes(active) ? HAND_TONE_MAPS : [...HAND_TONE_MAPS, active];
  const combos: HandsCombo[] = [];
  for (const toneMapping of tones) combos.push({ lights: 1, toneMapping }, { lights: 0, toneMapping });
  const index = combos.findIndex((combo) => combo.lights === 0 && combo.toneMapping === active);
  if (index >= 0) combos.push(combos.splice(index, 1)[0]);
  return combos;
}

/** A sorted feature list for the materials under `root`, so a test can see that a stand-in covers a shader. */
export function materialFeatures(root: THREE.Object3D): string[] {
  const found = new Set<string>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const material = mesh.material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    const normals = mesh.isMesh === true && !!mesh.geometry?.getAttribute('normal');
    for (const entry of list) {
      const bits = [entry.type];
      if (entry.transparent) bits.push('transparent');
      if ('map' in entry && (entry as THREE.MeshBasicMaterial).map) bits.push('map');
      if ('normalMap' in entry && (entry as THREE.MeshToonMaterial).normalMap) bits.push('normal');
      if ('gradientMap' in entry && (entry as THREE.MeshToonMaterial).gradientMap) bits.push('gradient');
      if ('vertexColors' in entry && (entry as THREE.MeshBasicMaterial).vertexColors) bits.push('vertexColors');
      if (surfaceFinish(entry)) bits.push('surface');
      if (entry.userData.floorContact === true) bits.push('contact');
      if (entry.userData.wallContact === true) bits.push('wallContact');
      if (entry.blending === THREE.AdditiveBlending) bits.push('additive');
      if (entry.side === THREE.DoubleSide) bits.push('double');
      if (mesh.isMesh === true && mesh.geometry && !normals) bits.push('noNormals');
      found.add(bits.join('|'));
    }
  });
  return [...found].sort();
}

const retained: THREE.Object3D[] = [];

/** How many stand-ins and prop clones are held so their shader programs stay compiled. */
export function retainedStandIns(): number {
  return retained.length;
}

/** Effects that are built when they happen, parented off to the side, with their own lights switched off. */
export function spellStandIns(): { world: THREE.Group; hands: THREE.Group } {
  const at = new THREE.Vector3(0, -40, 0);
  const world = new THREE.Group();
  const hands = new THREE.Group();
  world.name = 'shader-warmup-stand-in';
  hands.name = 'shader-warmup-stand-in';
  world.add(new Sparkles(at, null, { count: 1 }).group);
  world.add(new SpellBolt(at, new THREE.Vector3(0, -40, 1)).group);
  world.add(new SpellImpact(at, new THREE.Vector3(0, 1, 0), false).group);
  world.add(new SpellBolt(at, new THREE.Vector3(0, -40, 1), undefined, true).group);
  world.add(new SpellImpact(at, new THREE.Vector3(0, 1, 0), true, true).group);
  world.add(new TipTrail().points);
  world.add(new Puff(at, new THREE.Vector3(0, 1, 0)).group);
  world.add(new BloodSpray(at, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)).group);
  world.add(casualtyMarkers());
  world.add(smokeWisp(), pageLeaf(false), pageLeaf(true), cord(), teamKitStandIn(dotTexture()));
  const superMuzzle = new Muzzle();
  superMuzzle.fire(true);
  hands.add(new Wand().group, magnum(), new Muzzle().group, superMuzzle.group, pageLeaf(true));
  for (const root of [world, hands]) {
    hideLights(root);
    root.traverse((object) => {
      if (isDrawable(object)) object.frustumCulled = false;
    });
  }
  return { world, hands };
}

function dotTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** A printed page. `turning` is the curled leaf: a map on both sides and no vertex normals, which the office's other toon meshes have. */
function pageLeaf(turning: boolean): THREE.Mesh {
  const material = toonUnique('#ffffff');
  material.map = dotTexture();
  if (turning) material.side = THREE.DoubleSide;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  if (!turning) geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setIndex([0, 1, 2]);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = turning ? 'shader-warmup-leaf' : 'shader-warmup-page';
  return mesh;
}

/** The soft puff of muzzle smoke, a basic material with a map. */
function smokeWisp(): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ map: dotTexture(), color: '#dde2e8', transparent: true, depthWrite: false, opacity: 0 });
  material.userData.outlineParameters = { visible: false };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.name = 'shader-warmup-smoke';
  return mesh;
}

/** The cord a departure draws, an opaque line. */
function cord(): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3));
  const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#2b2d42' }));
  line.name = 'shader-warmup-cord';
  return line;
}

function hideLights(root: THREE.Object3D) {
  root.traverse((object) => {
    if ((object as THREE.Light).isLight === true) object.visible = false;
  });
}

function isDrawable(object: THREE.Object3D): boolean {
  const drawable = object as THREE.Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
  return drawable.isMesh === true || drawable.isPoints === true || drawable.isLine === true || drawable.isSprite === true;
}

/**
 * Lights and probe grids are left as the combo set them. Everything else hidden is shown for the pass.
 * Outlines are compiled by a real draw, which skips whatever sits outside the camera, and the camera has
 * not been placed yet, so every drawable is drawn for this pass and then put back.
 */
function reveal(root: THREE.Object3D): () => void {
  const shown: THREE.Object3D[] = [];
  const culled: { object: THREE.Object3D; frustumCulled: boolean }[] = [];
  const seen = new Set<THREE.Object3D>();
  const skip = (object: THREE.Object3D) => (object as THREE.Light).isLight === true || (object as { isLightProbeGrid?: boolean }).isLightProbeGrid === true;
  const unculled = (object: THREE.Object3D) => {
    if (!isDrawable(object) || seen.has(object)) return;
    seen.add(object);
    culled.push({ object, frustumCulled: object.frustumCulled });
    object.frustumCulled = false;
  };
  root.traverse((object) => {
    if (skip(object)) return;
    if (!object.visible) {
      shown.push(object);
      object.visible = true;
    }
    unculled(object);
  });
  return () => {
    for (const entry of culled) entry.object.frustumCulled = entry.frustumCulled;
    for (const object of shown) object.visible = false;
  };
}

/** What `warmOfficeShaders` needs from a renderer. A `WebGLRenderer` satisfies it. */
export interface ShaderCompiler {
  compileAsync(scene: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Scene | null): Promise<unknown>;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  toneMapping: THREE.ToneMapping;
  debug: { checkShaderErrors: boolean };
  info: { programs: Array<{ isReady?: () => boolean; getUniforms?: () => unknown }> | null };
}

export interface ShaderPass {
  material: THREE.Material;
  pipeline: DrawPipeline;
}

export interface WarmOptions {
  renderer: ShaderCompiler;
  /** Draws one scene's outlines. The office passes `effect.renderOutline`. */
  outline(scene: THREE.Scene, camera: THREE.Camera): void;
  world: { scene: THREE.Scene; camera: THREE.Camera; wandLight: THREE.PointLight };
  hands: { scene: THREE.Scene; camera: THREE.Camera };
  /** The bounce-light grid, when Remastered has one. Both counts are compiled either way. */
  grid: THREE.Object3D | null;
  /** The target the first frame draws the office to. */
  pipeline: DrawPipeline;
  passes?: readonly ShaderPass[];
  /** Prop scenes (the cached GLBs). Cloned, not reparented, including the toon copies the factory props swap in. */
  extras?: readonly THREE.Object3D[];
  /** Called between combinations so a long compile keeps the loading screen up. */
  pulse?: () => void;
}

interface Targets {
  /** An sRGB target marked like the upscaler's, which compiles to the same program as the canvas. */
  screen: THREE.WebGLRenderTarget;
  float: THREE.WebGLRenderTarget;
}

function makeTargets(): Targets {
  const screen = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
  (screen as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  const float = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
  return { screen, float };
}

function targetFor(targets: Targets, pipeline: DrawPipeline): THREE.WebGLRenderTarget {
  return pipeline === 'float' ? targets.float : targets.screen;
}

async function settle(renderer: ShaderCompiler) {
  const pending = () => (renderer.info.programs ?? []).filter((program) => program.isReady && !program.isReady());
  const started = Date.now();
  while (pending().length > 0 && Date.now() - started < 8000) await new Promise((resolve) => setTimeout(resolve, 10));
  for (const program of renderer.info.programs ?? []) program.getUniforms?.();
}

async function beat(pulse?: () => void) {
  pulse?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function compileView(renderer: ShaderCompiler, scene: THREE.Scene, camera: THREE.Camera, outline: WarmOptions['outline'], draw: boolean) {
  const restore = reveal(scene);
  try {
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    await renderer.compileAsync(scene, camera);
    await settle(renderer);
    // The grid is only gathered by a real draw, and the active combination's uniforms are bound here too.
    if (draw) {
      try {
        renderer.render(scene, camera);
      } catch (err) {
        console.warn('office: a shader warmup draw failed', err);
      }
    }
    outline(scene, camera);
  } finally {
    restore();
  }
}

/**
 * Compiles the office, the hands, the spell and gun effects, the prop models and the full-screen passes
 * for the light counts, targets, probe-grid counts and tone maps a session uses, including the office canvas
 * with tone mapping off. The wand's light is left
 * visible so a later glow does not change the count.
 */
export async function warmOfficeShaders(opts: WarmOptions): Promise<void> {
  const { renderer, world, hands } = opts;
  const toneWas = renderer.toneMapping;
  const gridWas = opts.grid?.visible ?? false;
  world.wandLight.visible = true;
  const targets = makeTargets();
  const spares: THREE.PointLight[] = [];
  const extras: THREE.Object3D[] = [];
  let stand: { world: THREE.Group; hands: THREE.Group } | null = null;
  let probe: THREE.Object3D | null = opts.grid;
  let temporary = false;
  const handsLight = new THREE.PointLight('#ffffff', 0, 1, 2);
  handsLight.name = 'shader-warmup-light';
  handsLight.visible = false;
  try {
    stand = spellStandIns();
    retained.push(stand.world, stand.hands);
    for (const src of opts.extras ?? []) {
      const raw = src.clone(true);
      raw.name = 'shader-warmup-extra';
      hideLights(raw);
      const tooned = src.clone(true);
      toonifyProp(tooned);
      tooned.name = 'shader-warmup-extra';
      hideLights(tooned);
      extras.push(raw, tooned);
    }
    retained.push(...extras);
    if (!probe) {
      probe = new LightProbeGridWebGL(1, 1, 1, 2, 2, 2);
      probe.name = 'shader-warmup-grid';
      probe.visible = false;
      temporary = true;
      world.scene.add(probe);
    }
    for (let i = 0; i < WORLD_POINT_LIGHTS - 1; i++) {
      const light = new THREE.PointLight('#fff2cc', 0, 4, 2);
      light.name = 'shader-warmup-light';
      light.visible = false;
      world.scene.add(light);
      spares.push(light);
    }
    world.scene.add(stand.world, ...extras);
    // The upscaler's target matches the canvas, so `srgb` is the canvas combination. A float target forces tone
    // mapping off and is compiled once. The canvas is compiled at no tone mapping and at the map in use now, so
    // switching between Classic and Remastered does not compile the office again.
    const worldCombos = officeCombos({
      pipelines: ['canvas', 'float'],
      grid: true,
      active: { pipeline: opts.pipeline === 'srgb' ? 'canvas' : opts.pipeline, grid: opts.grid ? gridWas : false },
    });
    const screenTones = toneWas === THREE.NoToneMapping ? [toneWas] : [THREE.NoToneMapping, toneWas];
    for (let pass = 0; pass < screenTones.length; pass++) {
      const tone = screenTones[pass];
      const lastPass = pass === screenTones.length - 1;
      for (let i = 0; i < worldCombos.length; i++) {
        const combo = worldCombos[i];
        if (!lastPass && combo.pipeline === 'float') continue;
        for (let n = 0; n < spares.length; n++) spares[n].visible = n < combo.lights - 1;
        probe.visible = combo.grid;
        renderer.toneMapping = combo.pipeline === 'float' ? toneWas : tone;
        renderer.setRenderTarget(targetFor(targets, combo.pipeline));
        await compileView(renderer, world.scene, world.camera, opts.outline, combo.grid || (lastPass && i === worldCombos.length - 1));
        await beat(opts.pulse);
      }
    }

    hands.scene.add(stand.hands);
    const handCombos = handsCombos(toneWas);
    for (let i = 0; i < handCombos.length; i++) {
      const combo = handCombos[i];
      renderer.toneMapping = combo.toneMapping;
      handsLight.visible = combo.lights === 1;
      if (combo.lights === 1) hands.scene.add(handsLight);
      else handsLight.removeFromParent();
      renderer.setRenderTarget(targets.screen);
      await compileView(renderer, hands.scene, hands.camera, opts.outline, i === handCombos.length - 1);
      await beat(opts.pulse);
    }

    const passScene = new THREE.Scene();
    const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const passMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    passMesh.frustumCulled = false;
    passScene.add(passMesh);
    try {
      for (const pass of opts.passes ?? []) {
        passMesh.material = pass.material;
        renderer.setRenderTarget(targetFor(targets, pass.pipeline));
        await renderer.compileAsync(passScene, passCamera);
        await settle(renderer);
        await beat(opts.pulse);
      }
    } finally {
      passMesh.geometry.dispose();
    }
  } finally {
    renderer.toneMapping = toneWas;
    world.wandLight.visible = true;
    for (const light of spares) light.removeFromParent();
    handsLight.removeFromParent();
    stand?.world.removeFromParent();
    stand?.hands.removeFromParent();
    for (const extra of extras) extra.removeFromParent();
    if (temporary) probe?.removeFromParent();
    else if (opts.grid) opts.grid.visible = gridWas;
    renderer.setRenderTarget(null);
    targets.float.dispose();
    targets.screen.dispose();
  }
}

export interface OutlineView {
  scene: THREE.Scene;
  camera: THREE.Camera;
  pipeline: DrawPipeline;
}

/**
 * Compiles outlines for a replacement outline effect (a thickness or opacity change builds a new one).
 * The light counts and tone map are whatever the office is using now; load time already covered the rest
 * on the effect it started with.
 */
export function warmOutlines(renderer: ShaderCompiler, outline: WarmOptions['outline'], views: readonly OutlineView[]) {
  const targets = makeTargets();
  try {
    for (const view of views) {
      renderer.setRenderTarget(targetFor(targets, view.pipeline));
      const restore = reveal(view.scene);
      try {
        view.scene.updateMatrixWorld(true);
        view.camera.updateMatrixWorld(true);
        outline(view.scene, view.camera);
      } finally {
        restore();
      }
    }
  } finally {
    renderer.setRenderTarget(null);
    targets.float.dispose();
    targets.screen.dispose();
  }
}
