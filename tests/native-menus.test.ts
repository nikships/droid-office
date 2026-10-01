// The headset app's two menus (native/menus.ts): settings from the left Menu button, and hire at an
// empty desk. Each floats where it opened, world-anchored and sized like an object; a controller ray
// on it hovers and presses its rows instead of the world behind it; it closes with ✕, B, the button
// that opened it, or by walking away. Half-Life: Alyx's pause and options panels are the bar.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NativeControls, type NativeHooks } from '../src/client/native/controls.js';
import type { NativeHand, NativeInputFrame, Pose7 } from '../src/client/native/input.js';
import { DEFAULT_NATIVE_GRAPHICS, type NativeGraphicsSettings } from '../src/client/native/graphics-settings.js';
import { layoutMenu, menuHeight, type MenuModel } from '../src/client/native/menu-panel.js';
import { NativeMenus, hireModel, settingsModel, stepWorldDetail, type NativeHireHooks, type NativeMenuInput, type NativeSettingsHooks } from '../src/client/native/menus.js';
import { PlayerController } from '../src/client/player.js';
import { loadSettings } from '../src/client/state.js';
import type { Collider } from '../src/client/world/office.js';
import { FLOOR, SLAB } from '../src/shared/layout.js';

/** Stands in for any canvas member a painter reaches for: callable, and every member is itself. */
const anything: unknown = new Proxy(() => {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : anything), apply: () => anything });

/** Just enough page for canvases: WorldPanel paints into a 2D context that ignores what it's told. */
function page(t: TestContext) {
  const context = new Proxy({ measureText: (s: string) => ({ width: s.length * 10 }) }, { get: (target, key) => Reflect.get(target, key) ?? anything, set: () => true });
  for (const [name, value] of [
    ['window', Object.assign(new EventTarget(), { devicePixelRatio: 1 })],
    ['document', Object.assign(new EventTarget(), { createElement: () => ({ width: 0, height: 0, getContext: () => context }) })],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
  }
}

// ---- Layout ----

test('every row of a menu gets targets big enough for a controller ray, inside the panel', () => {
  const model: MenuModel = {
    title: 'Settings',
    rows: [
      { kind: 'value', id: 'a', label: 'A', value: '1', dec: () => {}, inc: null },
      { kind: 'toggle', id: 'b', label: 'B', on: true, toggle: () => {} },
      { kind: 'toggle', id: 'c', label: 'C', on: false, toggle: null },
      {
        kind: 'buttons',
        id: 'd',
        buttons: [
          { id: 'x', label: 'X', run() {} },
          { id: 'y', label: 'Y', run() {}, disabled: true },
        ],
      },
      { kind: 'note', id: 'e', text: 'What is so' },
    ],
  };
  const width = 0.42;
  const height = menuHeight(model.rows.map((r) => r.kind));
  const layout = layoutMenu(model, width, height);
  assert.deepEqual(
    layout.targets.map((t) => t.id),
    ['close', 'a:dec', 'b', 'd:x'],
    'a step at its end, a fixed toggle and a disabled button take no press',
  );
  for (const t of layout.targets) {
    const { x, y, w, h } = t.rect;
    assert.ok(x >= 0 && y >= 0 && x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9, `${t.id} lies on the panel`);
    assert.ok(w * width >= 0.045 && h * height >= 0.035, `${t.id} is at least 4.5 x 3.5 cm`);
  }
  const rows = layout.rows.map((r) => r.rect);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].y >= rows[i - 1].y + rows[i - 1].h - 1e-9, 'rows stack without overlapping');
  assert.ok(rows[rows.length - 1].y + rows[rows.length - 1].h <= 1 + 1e-9, 'the last row fits');
});

// ---- Settings ----

function settingsHooks(over: Partial<NativeSettingsHooks> = {}) {
  const state = {
    cm: 175,
    offset: 0,
    eyes: 1.64 as number | null,
    graphics: { ...DEFAULT_NATIVE_GRAPHICS } as NativeGraphicsSettings,
    metrics: { worldRecommendedWidth: 1000, worldRecommendedHeight: 1000, worldMaxWidth: 1500, worldMaxHeight: 1500, foveationSupported: true } as Record<string, unknown>,
  };
  const hooks: NativeSettingsHooks = {
    heightCm: () => state.cm,
    setHeightCm: (cm) => (state.cm = cm),
    calibrate: () => {
      if (state.eyes === null) return false;
      state.offset = 1.5;
      return true;
    },
    resetFloor: () => (state.offset = 0),
    eyes: () => state.eyes,
    floorOffset: () => state.offset,
    graphics: () => state.graphics,
    setGraphics: (patch) => (state.graphics = { ...state.graphics, ...patch }),
    metrics: () => state.metrics,
    ...over,
  };
  return { state, hooks };
}

const run = (model: MenuModel, id: string) => {
  const layout = layoutMenu(model, 0.42, 0.42);
  const t = layout.targets.find((x) => x.id === id) ?? assert.fail(`no target ${id} in ${layout.targets.map((x) => x.id)}`);
  t.run();
};

test('the settings menu sets your height, calibrates the floor, and changes graphics', () => {
  const { state, hooks } = settingsHooks();
  const rows = () => settingsModel(hooks).rows;
  assert.deepEqual(
    rows().map((r) => r.id),
    ['height', 'floor', 'eyes', 'detail', 'foveation', 'sharp', 'fps', 'perf'],
  );
  run(settingsModel(hooks), 'height:inc');
  assert.equal(state.cm, 176);
  run(settingsModel(hooks), 'height:dec');
  run(settingsModel(hooks), 'height:dec');
  assert.equal(state.cm, 174);
  state.cm = 220;
  assert.ok(!layoutMenu(settingsModel(hooks), 0.42, 0.42).targets.some((t) => t.id === 'height:inc'), 'no taller than 220 cm');
  assert.ok(!layoutMenu(settingsModel(hooks), 0.42, 0.42).targets.some((t) => t.id === 'floor:reset'), 'nothing to reset on the headset floor');
  run(settingsModel(hooks), 'floor:calibrate');
  assert.equal(state.offset, 1.5);
  const eyes = rows().find((r) => r.id === 'eyes');
  assert.ok(eyes?.kind === 'note' && /1\.64 m above the floor · floor corrected 1\.50 m/.test(eyes.text));
  run(settingsModel(hooks), 'floor:reset');
  assert.equal(state.offset, 0);
  state.eyes = null;
  assert.ok(!layoutMenu(settingsModel(hooks), 0.42, 0.42).targets.some((t) => t.id === 'floor:calibrate'), 'no calibration while the head is untracked');

  run(settingsModel(hooks), 'foveation:inc');
  assert.equal(state.graphics.foveation, 'clarity');
  run(settingsModel(hooks), 'foveation:inc');
  assert.equal(state.graphics.foveation, 'off', 'the levels cycle round');
  run(settingsModel(hooks), 'sharp');
  assert.equal(state.graphics.sharpScreens, false);
  run(settingsModel(hooks), 'fps');
  assert.equal(state.graphics.fps, true);
  state.metrics.foveationSupported = false;
  const fov = rows().find((r) => r.id === 'foveation');
  assert.ok(fov?.kind === 'value' && fov.value === 'Off' && !fov.dec && !fov.inc, 'without runtime foveation there is only Off');
});

test('world detail steps in 5% stops, up to the exact runtime limit', () => {
  assert.equal(stepWorldDetail(1.16, 1, 1.5), 1.2);
  assert.equal(stepWorldDetail(1.16, -1, 1.5), 1.15);
  assert.equal(stepWorldDetail(1.2, -1, 1.5), 1.15);
  assert.equal(stepWorldDetail(1.48, 1, 1.4729), 1.4729);
  assert.equal(stepWorldDetail(0.75, -1, 1.5), 0.75);
  const { state, hooks } = settingsHooks();
  state.graphics.renderScale = 1.16;
  run(settingsModel(hooks), 'detail:inc');
  assert.equal(state.graphics.renderScale, 1.2);
  state.graphics.renderScale = 1.5;
  assert.ok(!layoutMenu(settingsModel(hooks), 0.42, 0.42).targets.some((t) => t.id === 'detail:inc'), 'nothing past the runtime maximum');
});

// ---- Hire ----

function hireHooks(over: Partial<NativeHireHooks> = {}) {
  const log = { hired: [] as unknown[][], shells: [] as string[], engine: 'claude', worktree: false, blocked: null as string | null };
  const marker = new THREE.Object3D();
  marker.position.set(2, 1.3, -3);
  const hooks: NativeHireHooks = {
    desk: (id) => (id === 'desk-7' ? { label: 'Desk 7', marker } : null),
    engines: () => [
      { id: 'claude', label: 'Claude Code · Opus' },
      { id: 'droid', label: 'Droid' },
    ],
    engine: () => log.engine,
    setEngine: (_d, e) => (log.engine = e),
    worktree: () => ({ offered: true, on: log.worktree }),
    setWorktree: (on) => (log.worktree = on),
    blocked: () => log.blocked,
    pressure: () => null,
    hire: (...args) => log.hired.push(args),
    shell: (d) => log.shells.push(d),
    ...over,
  };
  return { log, hooks, marker };
}

test('the hire menu picks an engine and a worktree, hires through the office, and folds away', () => {
  const { log, hooks } = hireHooks();
  let done = 0;
  const model = () => hireModel(hooks, 'desk-7', 'Desk 7', () => done++);
  assert.equal(model().title, 'Hire at Desk 7');
  run(model(), 'engine:inc');
  assert.equal(log.engine, 'droid');
  run(model(), 'worktree');
  assert.equal(log.worktree, true);
  run(model(), 'go:hire');
  assert.deepEqual(log.hired, [['desk-7', 'droid', true]]);
  assert.equal(done, 1);
  run(model(), 'go:shell');
  assert.deepEqual(log.shells, ['desk-7']);
  log.blocked = 'The office is at its limit of 6 workers';
  const ids = layoutMenu(model(), 0.46, 0.3).targets.map((t) => t.id);
  assert.ok(!ids.includes('go:hire') && !ids.includes('go:shell'), 'a full office hires nobody');
  const note = model().rows.find((r) => r.id === 'note');
  assert.ok(note?.kind === 'note' && note.tone === 'warn' && note.text === log.blocked, 'and the menu says why');
});

// ---- The menus in the world ----

function menus(t: TestContext) {
  page(t);
  const scene = new THREE.Scene();
  const head = { pos: new THREE.Vector3(0, 1.6, 0), dir: new THREE.Vector3(0, 0, -1) };
  const settings = settingsHooks();
  const hire = hireHooks();
  scene.add(hire.marker);
  const feedback: string[] = [];
  const m = new NativeMenus(scene, { head: () => head, settings: settings.hooks, hire: hire.hooks, feedback: (k) => feedback.push(k) });
  return { scene, head, settings, hire, m, feedback };
}

/** A ray from `from` to the middle of target `id` of the open menu. */
function rayTo(m: NativeMenus, menu: 'settings' | 'hire', id: string, from: THREE.Vector3): THREE.Ray {
  const vr = m[menu];
  const panel = vr.panel;
  const t = layoutMenu(settingsOrHire(vr), panel.width, panel.height).targets.find((x) => x.id === id) ?? assert.fail(`no ${id}`);
  const at = new THREE.Vector3((t.rect.x + t.rect.w / 2 - 0.5) * panel.width, (0.5 - (t.rect.y + t.rect.h / 2)) * panel.height, 0);
  panel.mesh.updateMatrixWorld(true);
  panel.mesh.localToWorld(at);
  return new THREE.Ray(from.clone(), at.sub(from).normalize());
}

/** The model a VrMenu shows now, read back through its targets (the layout is pure in its model). */
function settingsOrHire(menu: NativeMenus['settings']): MenuModel {
  return (menu as unknown as { model: MenuModel }).model;
}

test('settings open ahead of you, below your eyes, facing you, and stay put when you move', (t) => {
  const { m, head, feedback } = menus(t);
  assert.equal(m.toggleSettings(), true);
  assert.equal(m.open, 'settings');
  const root = m.settings.root;
  const at = root.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(at.x) < 1e-6 && Math.abs(at.z + 0.62) < 1e-6, `an arm's length ahead: ${at.toArray()}`);
  assert.ok(at.y < head.pos.y && at.y > head.pos.y - 0.3, 'a little below the eyes');
  const facing = new THREE.Vector3(0, 0, 1).transformDirection(root.matrixWorld);
  assert.ok(facing.dot(head.pos.clone().sub(at).normalize()) > 0.999, 'its face looks at your eyes');
  head.pos.set(0.3, 1.5, 0.2);
  head.dir.set(1, 0, 0);
  m.update(1 / 30);
  assert.deepEqual(root.getWorldPosition(new THREE.Vector3()).toArray(), at.toArray(), 'it never follows the head');
  assert.equal(m.toggleSettings(), false, 'the same button puts it away');
  assert.equal(m.open, null);
  assert.deepEqual(feedback, ['open', 'close']);
});

test('a ray on a settings row hovers it, and a trigger press and release changes it', (t) => {
  const { m, settings } = menus(t);
  m.openSettings();
  const from = new THREE.Vector3(0.15, 1.25, -0.2);
  const ray = rayTo(m, 'settings', 'fps', from);
  const aim = m.aim(1, ray);
  assert.ok(aim, 'the ray meets the menu');
  assert.equal(aim.target, 'fps');
  assert.ok(aim.point.distanceTo(m.settings.root.getWorldPosition(new THREE.Vector3())) < 0.3);
  m.press(1, true);
  assert.equal(settings.state.graphics.fps, false, 'nothing changes until the trigger lets go');
  m.press(1, false);
  assert.equal(settings.state.graphics.fps, true);
  // Pressed on one row, released off it: nothing.
  m.aim(1, rayTo(m, 'settings', 'sharp', from));
  m.press(1, true);
  m.aim(1, new THREE.Ray(from, new THREE.Vector3(0, 1, 0)));
  m.press(1, false);
  assert.equal(settings.state.graphics.sharpScreens, true, 'sliding off cancels the press');
  assert.equal(m.aim(0, new THREE.Ray(from, new THREE.Vector3(0, -1, 0))), null, 'a ray that misses is not on the menu');
});

test('a held height step steps on, and letting go adds no extra step', (t) => {
  const { m, settings } = menus(t);
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  m.openSettings();
  m.aim(0, rayTo(m, 'settings', 'height:inc', new THREE.Vector3(-0.1, 1.3, -0.2)));
  m.press(0, true);
  for (let i = 0; i < 20; i++) {
    now += 50;
    m.update(0.05);
  }
  const held = settings.state.cm;
  assert.ok(held > 176, `holding steps on: ${held}`);
  m.press(0, false);
  assert.equal(settings.state.cm, held);
});

test('B, the ✕ and walking away each put the menu away', (t) => {
  const { m, head } = menus(t);
  assert.equal(m.back(), false, 'B with no menu does nothing here');
  m.openSettings();
  assert.equal(m.back(), true);
  assert.equal(m.open, null);
  m.openSettings();
  assert.equal(m.pressTarget('close'), true);
  assert.equal(m.open, null);
  m.openSettings();
  head.pos.set(0, 1.6, 3);
  m.update(1 / 30);
  assert.equal(m.open, null, 'walked away from it');
});

test('the hire menu floats at its desk over the "+", facing you, and goes when the desk is taken', (t) => {
  const { m, head, hire } = menus(t);
  head.pos.set(2, 1.6, -1.5);
  assert.equal(m.openHire('desk-9'), false, 'only an empty desk opens one');
  m.openSettings();
  assert.equal(m.openHire('desk-7'), true);
  assert.equal(m.open, 'hire', 'one menu at a time');
  assert.equal(m.settings.root.visible, false);
  const at = m.hire.root.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(at.x - 2) < 1e-6 && Math.abs(at.y - 1.3) < 1e-6 && at.z > -3 && at.z < -2.8, `in front of the "+", toward you: ${at.toArray()}`);
  assert.ok(m.hire.root.scale.x >= 1.4, 'sized to read from across the desk');
  const facing = new THREE.Vector3(0, 0, 1).transformDirection(m.hire.root.matrixWorld);
  assert.ok(facing.dot(head.pos.clone().sub(at).normalize()) > 0.999);
  head.pos.set(2.4, 1.6, -1.2);
  m.update(1 / 30);
  assert.deepEqual(m.hire.root.getWorldPosition(new THREE.Vector3()).toArray(), at.toArray(), 'world-anchored');
  assert.equal(m.pressTarget('go:hire'), true);
  assert.deepEqual(hire.log.hired, [['desk-7', 'claude', false]]);
  assert.equal(m.open, null, 'hiring folds it away: the new worker walks in');
  m.openHire('desk-7');
  hire.hooks.desk = () => null;
  m.update(1 / 30);
  assert.equal(m.open, null, 'someone else hired there first');
});

test('a floor correction moves the open settings menu with you', (t) => {
  const { m } = menus(t);
  m.openSettings();
  const y = m.settings.root.position.y;
  m.shift(-1.5);
  assert.ok(Math.abs(m.settings.root.position.y - (y - 1.5)) < 1e-9);
});

// ---- The controls hand a ray on a menu to the menu ----

const officeFloor: Collider = { ...FLOOR, bottom: -SLAB, top: 0 };
const IDENT: Pose7 = [0, 0, 0, 0, 0, 0, 1];
const off = (): NativeHand => ({ active: false, aim: [...IDENT], grip: [...IDENT], trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false });
const controller = (patch: Partial<NativeHand> = {}): NativeHand => ({
  active: true,
  aim: [0.2, 1.2, -0.3, 0, 0, 0, 1],
  grip: [0.2, 1.2, -0.3, 0, 0, 0, 1],
  trigger: 0,
  squeeze: 0,
  stick: [0, 0],
  a: false,
  b: false,
  menu: false,
  ui: false,
  ...patch,
});

function controlsWith(t: TestContext, menus: NativeMenuInput, extra: Partial<NativeHooks> = {}) {
  page(t);
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const camera = new THREE.PerspectiveCamera();
  const player = new PlayerController(camera, new EventTarget() as unknown as HTMLElement, [officeFloor]);
  const scene = new THREE.Scene();
  const calls = { e: 0, toggles: 0, back: 0 };
  // A wall ahead and behind: whichever way the rig faces, a controller's ray meets one.
  const box = new THREE.Group();
  for (const z of [-3, 3]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 0.2));
    wall.position.set(0, 1.2, z);
    box.add(wall);
  }
  scene.add(box);
  scene.updateMatrixWorld(true);
  const hooks: NativeHooks = {
    player,
    settings: loadSettings(),
    useE: () => calls.e++,
    pickFromRay: (ray) => {
      const hit = ray.intersectObject(box, true)[0];
      return hit ? { it: { kind: 'tv', x: 0, z: hit.point.z, radius: 2 }, near: true, hit } : null;
    },
    noteUnder: () => null,
    nextWaiting() {},
    putBack() {},
    carrying: () => null,
    modalOpen: () => false,
    toast() {},
    hudRefresh() {},
    reachOf: () => 5,
    reachAnim() {},
    onTarget() {},
    togglePanel: () => calls.toggles++,
    menus,
    ...extra,
  };
  const controls = new NativeControls(scene, camera, hooks);
  let time = 0;
  const frame = (right: NativeHand = off(), left: NativeHand = off()): NativeInputFrame => ({ time: (time += 11), head: [0, 1.6, 0, 0, 0, 0, 1], hands: [left, right] });
  const tick = (...frames: NativeInputFrame[]) => {
    controls.consume(frames);
    controls.update(1 / 30);
  };
  return { controls, camera, scene, calls, frame, tick, advance: (ms: number) => (clock += ms) };
}

test('a trigger on a menu presses the menu and never the world behind it; B puts it away', (t) => {
  const log: string[] = [];
  let onMenu = true;
  const menu: NativeMenuInput = {
    aim: (hand, ray) => (ray && onMenu ? { point: new THREE.Vector3(0, 1.3, -0.6), target: `row${hand}` } : null),
    press: (hand, down) => log.push(`${hand}:${down ? 'down' : 'up'}`),
    cancel: (hand) => log.push(`${hand}:cancel`),
    back: () => {
      log.push('back');
      return true;
    },
  };
  const r = controlsWith(t, menu);
  r.controls.start();
  r.tick(r.frame(controller()));
  const hover = r.controls.state().hands[1].hover;
  assert.deepEqual(hover, { point: [0, 1.3, -0.6], near: true }, 'the ray ends on the menu, lit');
  r.tick(r.frame(controller({ trigger: 1 })));
  r.tick(r.frame(controller({ trigger: 0 })));
  assert.deepEqual(log, ['1:down', '1:up']);
  assert.equal(r.calls.e, 0, 'the board behind the menu was not used');
  r.tick(r.frame(controller({ b: true })));
  assert.deepEqual(log.slice(-1), ['back']);
  onMenu = false;
  r.tick(r.frame(controller()));
  r.tick(r.frame(controller({ trigger: 1 })));
  assert.equal(r.calls.e, 1, 'off the menu, the trigger uses the world again');
  r.tick(r.frame(controller({ trigger: 0 })));
  onMenu = true;
  r.tick(r.frame(controller()));
  r.tick(r.frame(controller({ trigger: 1 })));
  r.tick(r.frame(off()));
  r.advance(1000);
  r.tick(r.frame(off()), r.frame(off()));
  assert.ok(log.includes('1:cancel'), 'a controller that drops out mid-press cancels it');
  // A controller that connects with Menu held is not a press: connect them first.
  r.tick(r.frame(controller(), controller()));
  r.tick(r.frame(controller({ menu: true }), controller({ menu: true })));
  assert.equal(r.calls.toggles, 1, 'only the left Menu button toggles the settings menu');
});

test('end to end: the left Menu opens settings ahead of the eyes, and the right controller flips a row', (t) => {
  let menusRef: NativeMenus | null = null;
  const settings = settingsHooks();
  const input: NativeMenuInput = {
    aim: (h, ray) => menusRef!.aim(h, ray),
    press: (h, d) => menusRef!.press(h, d),
    cancel: (h) => menusRef!.cancel(h),
    back: () => menusRef!.back(),
  };
  const r = controlsWith(t, input, { togglePanel: () => menusRef?.toggleSettings() });
  const hire = hireHooks();
  menusRef = new NativeMenus(r.scene, {
    head: () => ({ pos: r.camera.getWorldPosition(new THREE.Vector3()), dir: r.controls.lookDir(new THREE.Vector3()) }),
    settings: settings.hooks,
    hire: hire.hooks,
  });
  const m = menusRef;
  r.controls.start();
  r.tick(r.frame(controller(), controller()));
  r.tick(r.frame(controller(), controller({ menu: true })));
  assert.equal(m.open, 'settings');
  // Aim the right controller at the FPS row: a native LOCAL_FLOOR pose, through the rig.
  const eye = r.camera.getWorldPosition(new THREE.Vector3());
  const from = eye.clone().add(new THREE.Vector3(0.12, -0.3, 0).applyQuaternion(r.camera.quaternion));
  const ray = rayTo(m, 'settings', 'fps', from);
  const toLocal = r.controls.rig.matrixWorld.clone().invert();
  const origin = from.clone().applyMatrix4(toLocal);
  const dir = ray.direction.clone().transformDirection(toLocal);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  const aim: Pose7 = [origin.x, origin.y, origin.z, q.x, q.y, q.z, q.w];
  r.tick(r.frame(controller({ aim, grip: aim }), controller()));
  r.tick(r.frame(controller({ aim, grip: aim, trigger: 1 }), controller()));
  r.tick(r.frame(controller({ aim, grip: aim }), controller()));
  assert.equal(settings.state.graphics.fps, true, 'the FPS counter is on');
  assert.equal(r.calls.e, 0);
  r.tick(r.frame(controller({ aim, grip: aim }), controller({ menu: true })));
  r.tick(r.frame(controller({ aim, grip: aim }), controller()));
  assert.equal(m.open, null, 'Menu again puts it away');
});
