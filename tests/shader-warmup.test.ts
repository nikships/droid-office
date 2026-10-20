import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { HAND_TONE_MAPS, WORLD_POINT_LIGHTS, handsCombos, materialFeatures, officeCombos, retainedStandIns, spellStandIns, warmOfficeShaders, warmOutlines, type ShaderCompiler } from '../src/client/shader-warmup.js';
import { casualtyMarkers } from '../src/client/world/casualties.js';

test('office combinations end on the first frame: one point light, its pipeline and its grid', () => {
  const combos = officeCombos({ pipelines: ['canvas', 'float', 'srgb'], grid: true, active: { pipeline: 'srgb', grid: false } });
  assert.equal(combos.length, 3 * 2 * WORLD_POINT_LIGHTS);
  assert.deepEqual(combos.at(-1), { lights: 1, pipeline: 'srgb', grid: false });
  assert.ok(combos.some((combo) => combo.lights === WORLD_POINT_LIGHTS && combo.grid && combo.pipeline === 'float'));
  const classic = officeCombos({ pipelines: ['canvas'], grid: false, active: { pipeline: 'canvas', grid: true } });
  assert.ok(classic.every((combo) => !combo.grid));
  assert.equal(classic.at(-1)?.lights, 1);
});

test('hand combinations end on no point light and the tone map the renderer already has', () => {
  const combos = handsCombos(THREE.NeutralToneMapping);
  assert.equal(combos.length, HAND_TONE_MAPS.length * 2);
  assert.deepEqual(combos.at(-1), { lights: 0, toneMapping: THREE.NeutralToneMapping });
  assert.ok(combos.some((combo) => combo.lights === 1 && combo.toneMapping === THREE.NoToneMapping));
  const custom = 99 as THREE.ToneMapping;
  assert.deepEqual(handsCombos(custom).at(-1), { lights: 0, toneMapping: custom });
});

test('spell stand-ins cover the wand, the gun and the effects that are built when they happen', () => {
  const { world, hands } = spellStandIns();
  const features = new Set([...materialFeatures(world), ...materialFeatures(hands)]);
  for (const feature of [
    'MeshBasicMaterial|transparent|additive',
    'MeshBasicMaterial|transparent|additive|double',
    'MeshBasicMaterial|transparent|map',
    'SpriteMaterial|transparent|map|additive',
    'PointsMaterial|transparent|map|vertexColors|additive',
    'MeshToonMaterial|map|gradient',
    'MeshToonMaterial|map|gradient|double|noNormals',
    'LineBasicMaterial',
  ])
    assert.ok(features.has(feature), feature);
  const markers = casualtyMarkers();
  let light = false;
  markers.traverse((object) => {
    if ((object as THREE.Light).isLight === true) light = true;
  });
  assert.equal(light, false);
  world.traverse((object) => {
    if (object.name === 'casualty-markers') {
      object.traverse((child) => {
        if ((child as THREE.Light).isLight === true) light = true;
      });
    }
  });
  assert.equal(light, false);
});

interface Stub {
  renderer: ShaderCompiler;
  office: { spares: number; grid: boolean; tone: THREE.ToneMapping }[];
  handsLit: boolean[];
  outlined: string[];
  sawStandard: boolean;
  sawFloatPass: boolean;
  hiddenWhile: boolean;
  shownUnculled: boolean;
  target: () => THREE.WebGLRenderTarget | null;
  tone: () => THREE.ToneMapping;
}

function stub(t: TestContext, fail?: 'compile' | 'draw'): Stub {
  let toneMapping: THREE.ToneMapping = THREE.ACESFilmicToneMapping;
  let target: THREE.WebGLRenderTarget | null = null;
  const programs: { isReady: () => boolean; getUniforms: () => void }[] = [];
  const office: Stub['office'] = [];
  const handsLit: boolean[] = [];
  const outlined: string[] = [];
  let sawStandard = false;
  let sawFloatPass = false;
  let hiddenWhile = false;
  let shownUnculled = false;
  let compiles = 0;
  let draws = 0;
  const lightsOf = (scene: THREE.Object3D) => {
    let n = 0;
    let grid = false;
    scene.traverse((object) => {
      if (object.name === 'shader-warmup-light' && object.visible) n++;
      if ((object as { isLightProbeGrid?: boolean }).isLightProbeGrid && object.visible) grid = true;
      if (object.name === 'hidden-probe' && object.visible) hiddenWhile = true;
      if (object.name === 'shown-probe' && !object.frustumCulled) shownUnculled = true;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.type === 'MeshStandardMaterial') sawStandard = true;
      if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.name === 'grade-pass' && target?.texture.type === THREE.HalfFloatType) sawFloatPass = true;
    });
    return { spares: n, grid, tone: toneMapping };
  };
  const renderer: ShaderCompiler = {
    async compileAsync(scene) {
      compiles++;
      if (fail === 'compile' && compiles === 2) throw new Error('compile failed');
      const snap = lightsOf(scene);
      if (scene.name === 'office') office.push(snap);
      if (scene.name === 'hands') handsLit.push(snap.spares > 0);
      programs.push({
        isReady: () => true,
        getUniforms() {
          /* bound once the program is linked */
        },
      });
    },
    render(scene) {
      draws++;
      lightsOf(scene);
      if (fail === 'draw' && draws === 1) throw new Error('draw failed');
    },
    setRenderTarget(next) {
      target = next;
    },
    get toneMapping() {
      return toneMapping;
    },
    set toneMapping(value) {
      toneMapping = value;
    },
    debug: { checkShaderErrors: true },
    info: { programs },
  };
  if (fail === 'draw') {
    const warn = console.warn;
    console.warn = () => {};
    t.after(() => {
      console.warn = warn;
    });
  }
  return {
    renderer,
    office,
    handsLit,
    outlined,
    get sawStandard() {
      return sawStandard;
    },
    get sawFloatPass() {
      return sawFloatPass;
    },
    get hiddenWhile() {
      return hiddenWhile;
    },
    get shownUnculled() {
      return shownUnculled;
    },
    target: () => target,
    tone: () => toneMapping,
  };
}

function officeScene() {
  const scene = new THREE.Scene();
  scene.name = 'office';
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  hidden.name = 'hidden-probe';
  hidden.visible = false;
  hidden.frustumCulled = true;
  scene.add(hidden);
  const shown = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  shown.name = 'shown-probe';
  shown.frustumCulled = true;
  scene.add(shown);
  return { scene, hidden, shown };
}

test('warmup compiles the hidden office, the props and both grids, then puts the scene back', async (t) => {
  const held = retainedStandIns();
  const { scene, hidden, shown } = officeScene();
  const hands = new THREE.Scene();
  hands.name = 'hands';
  const camera = new THREE.PerspectiveCamera();
  const wandLight = new THREE.PointLight();
  wandLight.visible = false;
  scene.add(wandLight);
  const grid = new THREE.Object3D();
  (grid as { isLightProbeGrid: boolean }).isLightProbeGrid = true;
  grid.name = 'probe';
  grid.visible = false;
  scene.add(grid);
  const extra = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#888' }));
  extra.name = 'standard-prop';
  const pass = new THREE.ShaderMaterial();
  pass.name = 'grade-pass';
  const env = stub(t, 'draw');
  let pulses = 0;
  await warmOfficeShaders({
    renderer: env.renderer,
    outline(root) {
      env.outlined.push(root.name);
    },
    world: { scene, camera, wandLight },
    hands: { scene: hands, camera },
    grid,
    pipeline: 'float',
    passes: [{ material: pass, pipeline: 'float' }],
    extras: [extra],
    pulse: () => pulses++,
  });
  assert.equal(wandLight.visible, true);
  assert.equal(hidden.visible, false);
  assert.equal(hidden.frustumCulled, true);
  assert.equal(shown.frustumCulled, true);
  assert.equal(grid.visible, false);
  assert.equal(grid.parent, scene);
  assert.equal(extra.parent, null);
  assert.equal(env.target(), null);
  assert.equal(env.tone(), THREE.ACESFilmicToneMapping);
  assert.ok(env.hiddenWhile);
  assert.ok(env.shownUnculled);
  assert.ok(env.sawStandard);
  assert.ok(env.sawFloatPass);
  assert.ok(pulses > 0);
  assert.ok(env.outlined.includes('office'));
  assert.ok(env.outlined.includes('hands'));
  assert.equal(env.office.at(-1)?.spares, 0);
  assert.equal(env.office.at(-1)?.grid, false);
  assert.equal(env.office.at(-1)?.tone, THREE.ACESFilmicToneMapping);
  assert.ok(env.office.some((snap) => snap.tone === THREE.NoToneMapping));
  assert.ok(env.office.some((snap) => snap.grid && snap.spares > 0));
  assert.equal(env.handsLit.at(-1), false);
  assert.ok(env.handsLit.some((lit) => lit));
  assert.ok(retainedStandIns() > held);
  for (const root of [scene, hands]) {
    root.traverse((object) => {
      assert.notEqual(object.name, 'shader-warmup-stand-in');
      assert.notEqual(object.name, 'shader-warmup-light');
      assert.notEqual(object.name, 'shader-warmup-extra');
      assert.notEqual(object.name, 'shader-warmup-grid');
    });
  }
});

test('with no probe grid yet, a temporary one is compiled and not left in the scene', async (t) => {
  const scene = new THREE.Scene();
  scene.name = 'office';
  const wandLight = new THREE.PointLight();
  wandLight.visible = false;
  scene.add(wandLight);
  const hands = new THREE.Scene();
  hands.name = 'hands';
  const env = stub(t);
  await warmOfficeShaders({
    renderer: env.renderer,
    outline() {},
    world: { scene, camera: new THREE.PerspectiveCamera(), wandLight },
    hands: { scene: hands, camera: new THREE.PerspectiveCamera() },
    grid: null,
    pipeline: 'srgb',
  });
  assert.ok(env.office.some((snap) => snap.grid));
  assert.equal(env.office.at(-1)?.grid, false);
  assert.equal(env.office.at(-1)?.spares, 0);
  assert.equal(env.office.at(-1)?.tone, THREE.ACESFilmicToneMapping);
  assert.ok(env.office.some((snap) => snap.tone === THREE.NoToneMapping));
  assert.equal(wandLight.visible, true);
  scene.traverse((object) => assert.notEqual(object.name, 'shader-warmup-grid'));
});

test('a compile that fails puts the lights, the grid and the hidden mesh back', async (t) => {
  const { scene, hidden } = officeScene();
  const wandLight = new THREE.PointLight();
  wandLight.visible = false;
  scene.add(wandLight);
  const grid = new THREE.Object3D();
  (grid as { isLightProbeGrid: boolean }).isLightProbeGrid = true;
  grid.visible = true;
  scene.add(grid);
  const env = stub(t, 'compile');
  await assert.rejects(
    () =>
      warmOfficeShaders({
        renderer: env.renderer,
        outline() {},
        world: { scene, camera: new THREE.PerspectiveCamera(), wandLight },
        hands: { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() },
        grid,
        pipeline: 'canvas',
      }),
    /compile failed/,
  );
  assert.equal(wandLight.visible, true);
  assert.equal(hidden.visible, false);
  assert.equal(hidden.frustumCulled, true);
  assert.equal(grid.visible, true);
  assert.equal(env.tone(), THREE.ACESFilmicToneMapping);
  assert.equal(env.target(), null);
  scene.traverse((object) => {
    assert.notEqual(object.name, 'shader-warmup-light');
    assert.notEqual(object.name, 'shader-warmup-stand-in');
  });
});

test('a replacement outline effect compiles a hidden mesh and restores it', (t) => {
  const { scene, hidden } = officeScene();
  const env = stub(t);
  let saw = false;
  warmOutlines(
    env.renderer,
    (root) => {
      root.traverse((object) => {
        if (object.name === 'hidden-probe' && object.visible) saw = true;
      });
    },
    [{ scene, camera: new THREE.PerspectiveCamera(), pipeline: 'float' }],
  );
  assert.equal(saw, true);
  assert.equal(hidden.visible, false);
  assert.equal(hidden.frustumCulled, true);
  assert.equal(env.target(), null);
});
