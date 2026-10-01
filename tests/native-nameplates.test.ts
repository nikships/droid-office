// The headset app floats no name, state, light or pitch over anyone: a worker wears no antenna, its
// name and engine are engraved on a brass plate on a wooden block on its desk (or on its chair's
// back) beside a status lamp, its laptop's title bar says its state and task, a teammate wears a
// name badge, and a board agent's kiosk shows only its nameplate, on a screen set into its front,
// until you greet it. Its signs are printed plates on boards, fixed to walls and shelves. Desktop
// and WebXR keep their tags and labels.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { floatingTagsShown, worldNotice } from '../src/client/native/mode.js';
import { Nameplate, paintEngraved, paintPlate, type PlateText } from '../src/client/world/nameplate.js';
import { Person, Worker, workerPlate, type WorkerPlateState } from '../src/client/world/character.js';
import { buildOffice } from '../src/client/world/office.js';
import { buildBookshelf } from '../src/client/world/bookshelf.js';
import { BoardTexture, QueueBoardTexture, ServicesBoardTexture } from '../src/client/world/boards.js';
import { buildElevator } from '../src/client/world/elevator.js';
import { Laptop } from '../src/client/world/laptop.js';
import { enamel, plainLabel, textPlane } from '../src/client/world/toon.js';
import { BOARDS, BOOKSHELF, DESK_SIZE, ELEVATOR, ELEVATOR_FRONT, KIOSK, WALL_HEIGHT } from '../src/shared/layout.js';
import type { GhIssue, GhState } from '../src/shared/protocol.js';

/** Stands in for any canvas member the painters reach for: callable, and every member is itself. */
const anything: unknown = new Proxy(() => {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : anything), apply: () => anything });

/** A page with `search` as its query and canvases that record every line of text drawn on them. */
function page(t: TestContext, search: string): string[] {
  const drawn: string[] = [];
  const restore = (key: 'document' | 'location', value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key)));
  };
  restore('location', { search });
  restore('document', {
    fonts: { ready: new Promise(() => {}), load: () => new Promise(() => {}), addEventListener: () => {} },
    addEventListener: () => {},
    createElement: () => {
      const canvas = { width: 1, height: 1, getContext: () => context };
      const context: object = new Proxy({ canvas, measureText: (text: string) => ({ width: text.length * 12 }), fillText: (text: string) => drawn.push(text) }, { get: (target, key) => Reflect.get(target, key) ?? anything });
      return canvas;
    },
  });
  return drawn;
}

/** Every sprite (a billboard that turns to face you) under `root`. */
function sprites(root: THREE.Object3D): THREE.Sprite[] {
  const out: THREE.Sprite[] = [];
  root.traverse((o) => {
    if ((o as THREE.Sprite).isSprite) out.push(o as THREE.Sprite);
  });
  return out;
}

/** How high (meters, in its own space) anything a worker wears or carries reaches: its own sprites aside. */
function topOf(worker: Worker): number {
  worker.root.updateMatrixWorld(true);
  let top = -Infinity;
  worker.root.traverse((o) => {
    const m = o as THREE.Mesh;
    let shown = true;
    for (let p: THREE.Object3D | null = o; p && p !== worker.root; p = p.parent) shown &&= p.visible;
    if (!m.isMesh || !shown) return;
    m.geometry.computeBoundingBox();
    top = Math.max(top, m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).max.y);
  });
  return top;
}

/** The lit dome of a nameplate's status lamp: the one half sphere under its root. */
function lampOf(plate: Nameplate): THREE.Mesh {
  const domes: THREE.Mesh[] = [];
  plate.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry instanceof THREE.SphereGeometry) domes.push(m);
  });
  assert.equal(domes.length, 1);
  return domes[0];
}

const RESTING: WorkerPlateState = { name: 'Pixel 🐚', role: 'Shell', color: '#8d99ae', status: 'idle', bounce: false, lost: false, out: false };

test('characters wear floating tags on the desktop and in WebXR, never in the headset app', () => {
  assert.equal(floatingTagsShown(''), true);
  assert.equal(floatingTagsShown('?native=0'), true);
  assert.equal(floatingTagsShown('?native=1'), false);
  assert.equal(floatingTagsShown(), true, 'no page (a test, a worker) is not the headset app');
});

test("a board's problem says what is wrong in the headset app, never what to type", (t) => {
  const remote = 'This project has no GitHub remote yet. Push it to GitHub (git remote add origin <url>) to fill the boards.';
  assert.equal(worldNotice(remote), remote, 'the desktop board keeps the whole message');
  page(t, '?native=1');
  assert.equal(worldNotice(remote), 'This project has no GitHub remote yet.');
  assert.equal(worldNotice("gh isn't logged in on the server — run `gh auth login`"), "gh isn't logged in on the server");
  assert.equal(worldNotice("glab can't find this project on GitLab (check the remote and access)"), "glab can't find this project on GitLab");
  assert.equal(worldNotice('GitHub CLI (gh) is not installed on the server'), 'GitHub CLI is not installed on the server');
  assert.equal(worldNotice("Couldn't load PROJ-1 from Jira: 401 Unauthorized"), "Couldn't load PROJ-1 from Jira: 401 Unauthorized");
  assert.equal(worldNotice('Bad credentials'), 'Bad credentials');
});

test("a worker's nameplate shows what its tags would: name, engine, state, task and lamp", () => {
  assert.deepEqual(workerPlate(RESTING), { name: 'Pixel 🐚', role: 'Shell', state: ['READY', '#5aa9e6'], line: '', color: '#8d99ae', lamp: '#5aa9e6', pulse: 'steady' });
  const working = workerPlate({ ...RESTING, status: 'working', task: { name: 'Fix the login page', summary: 'Reading the form' } });
  assert.deepEqual(working.state, ['WORKING', '#f2b84b'], 'a word in its status color, as a status light reads, not a pill');
  assert.equal(working.line, 'Fix the login page');
  assert.equal(working.pulse, 'busy', 'its lamp breathes while it works');
  assert.equal(workerPlate({ ...RESTING, status: 'needs_input' }).pulse, 'call', 'and blinks while it waits on you');
  assert.equal(workerPlate({ ...RESTING, status: 'done', bounce: true }).pulse, 'call');
  assert.equal(workerPlate({ ...RESTING, status: 'done' }).pulse, 'steady', 'once someone has looked, a finished one rests');
  assert.equal(workerPlate({ ...RESTING, out: true }).lamp, null, 'shot or leaving: the lamp is out');
  assert.deepEqual(workerPlate({ ...RESTING, lost: true }).state, ['WORKTREE DELETED', '#ffb703']);
  assert.deepEqual(workerPlate({ ...RESTING, pr: { state: 'merged', label: '🎉 PR #12 merged' } }).state, ['PR #12 MERGED', '#9d4edd']);
  assert.equal(workerPlate({ ...RESTING, status: 'working', pr: { state: 'open', label: 'PR #12' } }).state[0], 'WORKING', 'working comes before its PR');
});

test('a nameplate paints its name and state, and a pitch only once it has one', (t) => {
  const drawn = page(t, '?native=1');
  const text: PlateText = { ...workerPlate({ ...RESTING, name: 'Issues agent', role: 'Issues board' }) };
  paintPlate(document.createElement('canvas').getContext('2d')!, 900, 360, text, null);
  assert.deepEqual(drawn, ['Issues agent', 'Issues board', 'READY']);
  assert.equal(
    drawn.some((s) => /ask me/i.test(s)),
    false,
  );
  drawn.length = 0;
  paintPlate(document.createElement('canvas').getContext('2d')!, 900, 360, text, { heading: '📌 Issues agent', title: 'Ask me about issues', body: 'I file, find, triage, label and close them' });
  assert.ok(drawn.includes('Ask me about issues'), drawn.join(' | '));
});

test("in the headset app a shot worker's heartbeat flashes its seat's lamp red, and revival gives the lamp its status back", (t) => {
  page(t, '?native=1');
  const plate = new Nameplate({ shape: 'block', width: 0.3, height: 0.11 });
  const byte = new Worker('Byte 🐚', '#8d99ae');
  byte.setStatus('idle', false);
  byte.setPlate(plate);
  const dome = lampOf(plate);
  const color = (dome.material as THREE.MeshBasicMaterial).color;
  const idle = color.getHex();
  byte.pulse(1, 1);
  assert.equal(color.getHex(), idle, 'nothing while it is up');
  byte.die();
  byte.pulse(1, 1);
  plate.update(0.016);
  assert.ok(color.r > 0.8 && color.g < 0.2, `red at the beat (${color.getHexString()})`);
  assert.ok(dome.scale.x > 1.3, 'the dome swells with the beat');
  assert.equal(dome.visible, true);
  byte.pulse(0, 0.5);
  plate.update(0.016);
  assert.ok(color.r < 0.35 && color.r > color.b * 0.9, `an ember between beats (${color.getHexString()})`);
  assert.equal(dome.scale.x, 1);
  byte.pulse(0, 0);
  assert.equal(color.getHex(), new THREE.Color('#2b2d42').getHex(), 'out once its heart stops');
  byte.revive();
  assert.equal(color.getHex(), new THREE.Color(plate.showing.text?.lamp ?? '#000').getHex(), 'its status color again');
  assert.notEqual(plate.showing.text?.lamp, null);
  byte.setPlate(null);
  byte.dispose();
});

test('in the headset app a worker floats nothing over its head; its seat nameplate carries it all', (t) => {
  page(t, '?native=1');
  const plate = new Nameplate({ shape: 'block', width: 0.3, height: 0.11 });
  const pixel = new Worker('Pixel 🐚', '#8d99ae');
  pixel.setRole('Shell');
  pixel.setStatus('working', false);
  pixel.setTask({ name: 'Fix the login page', summary: 'Reading the form' });
  pixel.setPr({ state: 'open', label: 'PR #12' });
  assert.deepEqual(sprites(pixel.root), [], 'no name tag, bubble or task card');
  assert.ok(topOf(pixel) < 1.1, `no antenna or bulb sticks up over its headset band (top ${topOf(pixel).toFixed(2)} m)`);
  assert.equal(plate.root.visible, false, 'a seat nobody has sat in shows no plate');

  pixel.setPlate(plate);
  assert.equal(plate.root.visible, true);
  assert.deepEqual(
    { name: plate.showing.text?.name, role: plate.showing.text?.role, state: plate.showing.text?.state[0], line: plate.showing.text?.line, pulse: plate.showing.text?.pulse },
    { name: 'Pixel 🐚', role: 'Shell', state: 'WORKING', line: 'Fix the login page', pulse: 'busy' },
  );
  pixel.setStatus('needs_input', true);
  assert.equal(plate.showing.text?.pulse, 'call');
  pixel.die();
  assert.equal(plate.showing.text?.lamp, null, 'shot: the lamp goes out');
  pixel.revive();
  assert.equal(plate.showing.text?.lamp, '#ef4444');
  pixel.leave('Bye!');
  assert.deepEqual(sprites(pixel.root), [], 'no farewell over its head either');
  assert.equal(plate.showing.text?.lamp, null);
  pixel.setPlate(null);
  assert.equal(plate.root.visible, false, 'gone from its seat: the plate goes blank and out of sight');
});

test("a kiosk's display passes from the agent waiting there to the one hired there and back", (t) => {
  page(t, '?native=1');
  const display = new Nameplate({ shape: 'screen', width: 0.48, height: 0.24 });
  const waiting = new Worker('Issues agent', '#ef476f');
  waiting.setStatus('idle', false);
  waiting.setRole('Issues board');
  waiting.setPlate(display);
  assert.equal(display.showing.text?.state[0], 'READY');

  // Greeted: its pitch, until you walk off or ask it something.
  display.pitch({ heading: '📌 Issues agent', title: 'Ask me about issues', body: 'I file, find, triage, label and close them' });
  assert.equal(display.showing.pitch?.title, 'Ask me about issues');
  display.pitch(null);
  assert.equal(display.showing.pitch, null);

  const hired = new Worker('Issues agent', '#ef476f');
  hired.setRole('Issues board · Opus 4.1 · High');
  hired.setStatus('working', false);
  hired.setPlate(display);
  waiting.setPlate(null);
  assert.equal(display.root.visible, true, 'the agent waiting there letting go does not blank the hired one');
  assert.equal(display.showing.text?.role, 'Issues board · Opus 4.1 · High');
  waiting.setStatus('idle', false);
  assert.equal(display.showing.text?.state[0], 'WORKING', 'only whoever claimed it last can change it');

  hired.setPlate(null);
  assert.equal(display.root.visible, false);
  waiting.setPlate(display);
  assert.equal(display.showing.text?.state[0], 'READY');
});

test('on the desktop a worker still wears its name tag, status card and antenna bulb, and fills no nameplate', (t) => {
  page(t, '');
  const pixel = new Worker('Pixel 🐚', '#8d99ae');
  pixel.setStatus('working', false);
  pixel.setTask({ name: 'Fix the login page', summary: 'Reading the form' });
  assert.equal(sprites(pixel.root).length, 2, 'its name tag and its task card');
  assert.ok(topOf(pixel) > 1.2, 'the bulb on its antenna shows its status across the room');
});

test('in the headset app a teammate wears a name badge on their shirt, not a tag over their head', (t) => {
  page(t, '?native=1');
  const ada = new Person('Ada', '#e63946', { skin: 0, hair: 0, style: 0 });
  ada.setLabel('Ada', false);
  ada.setDoing('💻 in Pixel’s terminal');
  ada.setVoiceLevel(1);
  assert.deepEqual(sprites(ada.root), []);
  const badges: THREE.Object3D[] = [];
  ada.root.traverse((o) => o.name === 'name-badge' && badges.push(o));
  assert.equal(badges.length, 1);
  const [badge] = badges;
  assert.equal(badge.visible, true);
  ada.showLabel(false);
  ada.setLabel('Ada L.', null);
  const renamed: THREE.Object3D[] = [];
  ada.root.traverse((o) => o.name === 'name-badge' && renamed.push(o));
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].visible, false, 'a new name keeps the badge hidden where it was hidden');
});

test("a medic's red cross takes the place of their badge while they carry a stretcher", (t) => {
  page(t, '?native=1');
  const medic = new Person('Medic', '#f2f4f6', { skin: 0, hair: 0, style: 0 });
  const badge = () => {
    let found: THREE.Object3D | undefined;
    medic.root.traverse((o) => {
      if (o.name === 'name-badge') found = o;
    });
    return found;
  };
  medic.medicPose({ crouch: 0, stride: 0, left: new THREE.Vector3(-0.3, 0.9, 0.4), right: new THREE.Vector3(0.3, 0.9, 0.4) });
  assert.equal(badge()?.visible, false);
  medic.medicPose(null);
  assert.equal(badge()?.visible, true);
});

test('on the desktop the kiosks keep their "Ask me" signs', (t) => {
  const desktop = page(t, '');
  buildOffice();
  assert.deepEqual(
    desktop.filter((s) => /Ask me/.test(s)),
    ['📌 Ask me', '🔀 Ask me', '📋 Ask me'],
    'the desktop keeps its signs',
  );
});

test('the headset office paints no kiosk sign and mounts a nameplate on every seat', (t) => {
  const drawn = page(t, '?native=1');
  const office = buildOffice();
  assert.deepEqual(
    drawn.filter((s) => /Ask me/i.test(s)),
    [],
  );
  for (const [id, desk] of office.desks) {
    let mounted = false;
    for (let o: THREE.Object3D | null = desk.plate.anchor; o; o = o.parent) if (o === desk.group) mounted = true;
    assert.ok(mounted, `${id}: its nameplate hangs on the seat itself`);
    assert.ok(desk.plate.width >= 0.3 && desk.plate.height >= 0.11, `${id}: big enough to read`);
  }
  assert.equal(office.desks.get('station-issues')?.plate.shape, 'screen');
  assert.equal(office.desks.get('desk-1')?.plate.shape, 'block');
  assert.equal(office.desks.get('beanbag-1')?.plate.shape, 'plate');
});

test("a kiosk's nameplate is a screen set into its front, with its lamp standing on the counter", (t) => {
  page(t, '?native=1');
  const office = buildOffice();
  for (const id of ['station-issues', 'station-pulls', 'station-queue']) {
    const kiosk = office.desks.get(id)!;
    const plate = new Nameplate(kiosk.plate);
    kiosk.plate.anchor.add(plate.root);
    kiosk.group.updateMatrixWorld(true);
    const local = (o: THREE.Object3D) => kiosk.group.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    const screen = local(kiosk.plate.anchor);
    const facing = new THREE.Vector3(0, 0, 1).transformDirection(kiosk.plate.anchor.matrixWorld).applyQuaternion(kiosk.group.getWorldQuaternion(new THREE.Quaternion()).invert());
    assert.ok(screen.y + kiosk.plate.height / 2 < KIOSK.height - 0.1, `${id}: the screen sits below the counter, not standing on it (top ${(screen.y + kiosk.plate.height / 2).toFixed(2)} m)`);
    assert.ok(screen.z < -(KIOSK.depth - 0.12) / 2 && screen.z > -KIOSK.depth / 2, `${id}: in the kiosk's front face, under the counter's lip`);
    assert.ok(facing.z < -0.99, `${id}: facing out of the front, toward whoever walks up`);
    assert.ok(kiosk.plate.width <= KIOSK.width - 0.16 - 2 * 0.06 - 0.03, `${id}: the screen and its bezel fit the front's flat face`);
    const lamp = local(lampOf(plate));
    assert.ok(Math.abs(lamp.y - KIOSK.height) < 0.03, `${id}: the lamp stands on the counter (${lamp.y.toFixed(3)} m)`);
    assert.ok(lamp.z < 0 && lamp.z > -KIOSK.depth / 2 && Math.abs(lamp.x) < KIOSK.width / 2 - 0.05, `${id}: on the counter's front, not over the agent standing behind it`);
  }
});

/** `root`'s world-space bounds, counting only what's shown (its own `visible` and its parents'). */
function shownBounds(root: THREE.Object3D, skip: (o: THREE.Object3D) => boolean = () => false): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || skip(m)) return;
    for (let p: THREE.Object3D | null = m; p; p = p.parent) if (!p.visible) return;
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
  });
  return box;
}

test("a desk's nameplate is a wooden name block lying on the desk, beside the laptop, with its lamp on the desk", (t) => {
  page(t, '?native=1');
  const office = buildOffice();
  for (const id of ['desk-1', 'desk-4', 'desk-16']) {
    const desk = office.desks.get(id)!;
    const plate = new Nameplate(desk.plate);
    desk.plate.anchor.add(plate.root);
    const worker = new Worker('Byte 🐚', '#8d99ae');
    worker.setRole('Shell');
    worker.setStatus('idle', false);
    worker.setPlate(plate);
    const laptop = new Laptop();
    desk.laptopAnchor.add(laptop.root);
    // In the desk's own space, so its turn doesn't matter.
    const inDesk = (box: THREE.Box3) => box.applyMatrix4(desk.group.matrixWorld.clone().invert());
    const block = inDesk(shownBounds(plate.root));
    const lamp = inDesk(shownBounds(lampOf(plate)));
    const top = DESK_SIZE.height;
    assert.ok(Math.abs(block.min.y - top) < 0.003, `${id}: it rests on the desk, not over it (foot ${(block.min.y - top).toFixed(3)} m)`);
    assert.ok(block.max.y - top < 0.15, `${id}: a desk object's height, not a card standing up (${(block.max.y - top).toFixed(2)} m)`);
    const half = { x: (DESK_SIZE.width - 0.06) / 2, z: (DESK_SIZE.depth - 0.04) / 2 };
    assert.ok(block.min.x > -half.x && block.max.x < half.x && block.min.z > -half.z && block.max.z < half.z, `${id}: all of it on the desk top`);
    assert.ok(lamp.min.y > top + 0.005 && lamp.min.y < top + 0.03, `${id}: the lamp's dome sits in its collar on the desk`);
    const computer = inDesk(shownBounds(laptop.root));
    assert.ok(!computer.intersectsBox(block), `${id}: clear of the laptop`);
  }
});

test('an engraved plate is lit by the room and says who sits there without emoji; its lamp shows how it is doing', (t) => {
  const drawn = page(t, '?native=1');
  paintEngraved(document.createElement('canvas').getContext('2d')!, 720, 264, workerPlate(RESTING));
  assert.deepEqual(drawn, ['Pixel', 'Shell'], 'its name and engine, and no state word: a plate does not change its words');

  drawn.length = 0;
  const plate = new Nameplate({ shape: 'block', width: 0.3, height: 0.11 });
  const faces: THREE.Mesh[] = [];
  plate.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry instanceof THREE.PlaneGeometry) faces.push(m);
  });
  assert.equal(faces.length, 2, 'a plate on each sloped face of the block');
  for (const face of faces) {
    const mat = face.material as THREE.MeshToonMaterial;
    assert.ok(mat.isMeshToonMaterial && mat.map, 'brass lit by the room like the desk, not a screen that lights itself');
    assert.ok(mat.emissiveIntensity < 0.5, 'with only a little light of its own');
  }
  assert.deepEqual(sprites(plate.root), []);
  const pixel = new Worker('Pixel 🐚', '#8d99ae');
  pixel.setRole('Shell');
  pixel.setStatus('idle', false);
  pixel.setPlate(plate);
  const lamp = lampOf(plate).material as THREE.MeshBasicMaterial;
  assert.equal(`#${lamp.color.getHexString()}`, '#5aa9e6', 'its lamp in its status color');
  drawn.length = 0;
  pixel.setStatus('working', false);
  pixel.setTask({ name: 'Fix the login page', summary: 'Reading the form' });
  assert.deepEqual(drawn, [], 'the plate keeps its words while the worker gets busy');
  assert.equal(`#${lamp.color.getHexString()}`, '#f2b84b');
  assert.equal(plate.showing.text?.pulse, 'busy');
});

test("in the headset app a worker's laptop screen has a title bar with its name, engine, state and task", (t) => {
  const drawn = page(t, '?native=1');
  const pixel = new Worker('Pixel 🐚', '#8d99ae');
  pixel.setRole('Shell');
  pixel.setStatus('working', false);
  pixel.setTask({ name: 'Fix the login page', summary: 'Reading the form' });
  const laptop = new Laptop();
  drawn.length = 0;
  laptop.setTitle(pixel.plateText);
  laptop.update(0.016, undefined, 1);
  for (const s of ['Pixel 🐚', 'Shell', 'WORKING', 'Fix the login page']) assert.ok(drawn.includes(s), `${s} in ${drawn.join(' | ')}`);
  assert.ok(drawn.includes('booting…'), 'and the terminal (here its placeholder) below the bar');
  drawn.length = 0;
  laptop.setTitle(pixel.plateText);
  laptop.update(0.016, undefined, 1);
  assert.deepEqual(drawn, [], 'the same title paints nothing new');
});

test('on the desktop a laptop screen has no title bar: its worker wears its tags', (t) => {
  const drawn = page(t, '');
  const pixel = new Worker('Pixel 🐚', '#8d99ae');
  pixel.setStatus('working', false);
  assert.equal(pixel.plateText, null);
  const laptop = new Laptop();
  drawn.length = 0;
  laptop.setTitle(pixel.plateText);
  laptop.update(0.016, undefined, 1);
  assert.equal(drawn.includes('WORKING'), false);
});

test('in the headset app a sign is a printed plate on a board, without emoji, lit by the room', (t) => {
  const drawn = page(t, '?native=1');
  const sign = textPlane('🪜 ⬆ floor-beta', { bg: '#0a0a0a', color: '#eeeeee', border: '#2f2f2f', size: 44 });
  assert.deepEqual(drawn, ['↑ floor-beta'], 'its words and a plain arrow');
  assert.ok((sign.material as THREE.MeshToonMaterial).isMeshToonMaterial, 'lit by the room like the wall it is on');
  assert.equal(sign.material.transparent, false, 'a whole plate, not a pill with see-through corners');
  const board = sign.getObjectByName('sign-board') as THREE.Mesh<THREE.BoxGeometry>;
  assert.ok(board, 'a board behind the face');
  board.updateMatrix();
  board.geometry.computeBoundingBox();
  const back = board.geometry.boundingBox!.clone().applyMatrix4(board.matrix);
  const { width, height } = sign.geometry.parameters;
  assert.ok(back.max.z < 0 && back.min.z < -0.025, 'reaching back to the wall behind it');
  assert.ok(back.max.x - back.min.x > width && back.max.y - back.min.y > height, 'its edge showing round the face');
  let freed = false;
  board.geometry.addEventListener('dispose', () => (freed = true));
  sign.geometry.dispose();
  assert.ok(freed, "disposing the sign's face frees its board too");

  assert.equal(plainLabel('📚 Docs'), 'Docs');
  assert.equal(plainLabel('🚒 ⬇ floor-alpha'), '↓ floor-alpha');
  const exit = textPlane('EXIT', { bg: '#2a9d4b', color: '#ffffff', glow: 1 });
  assert.equal((exit.material as THREE.MeshToonMaterial).emissiveIntensity, 1, 'an exit sign is lit from inside');
});

test('in the headset app a dark sign is white enamel on a steel board, its words in dark ink or their own color', (t) => {
  page(t, '?native=1');
  const tag = { bg: '#0a0a0a', color: '#eeeeee', border: '#2f2f2f', size: 44 };
  assert.deepEqual(enamel(tag), { ...tag, bg: '#e6e8ec', color: '#1d2027', border: '#59606c', board: '#8d99ae' });
  assert.equal(enamel({ ...tag, color: '#ef4444' }).color, '#ef4444', "a fire pole's red letters stay red");
  for (const lit of [{ bg: '#2a9d4b', color: '#ffffff' }, { bg: '#0d0e11', color: '#ffb347', glow: 1 }, { bg: '#c9a85a', board: '#8a6a32' }, { bg: '#ffd166' }, { color: '#171a20' }])
    assert.deepEqual(enamel(lit), lit, 'an exit sign, a floor indicator lit from inside, the Docs and BOSS plates and a key cap keep their colors');
  const sign = textPlane('📋 Task queue', tag);
  const board = sign.getObjectByName('sign-board') as THREE.Mesh<THREE.BoxGeometry, THREE.MeshToonMaterial>;
  assert.equal(`#${board.material.color.getHexString()}`, '#8d99ae');
});

test('on the desktop a sign stays a flat glowing label, emoji and all', (t) => {
  const drawn = page(t, '');
  const sign = textPlane('🪜 ⬆ floor-beta', { bg: '#0a0a0a', color: '#eeeeee', border: '#2f2f2f', size: 44 });
  assert.deepEqual(drawn, ['🪜 ⬆ floor-beta']);
  assert.ok((sign.material as THREE.MeshBasicMaterial).isMeshBasicMaterial);
  assert.equal(sign.children.length, 0);
});

test("in the headset app the Docs sign is a brass plaque on a rail across the bookshelf's top, and nothing stands over the case", (t) => {
  const drawn = page(t, '?native=1');
  const { group } = buildBookshelf();
  assert.deepEqual(drawn, ['Docs']);
  const signs: THREE.Object3D[] = [];
  group.traverse((o) => o.getObjectByName('sign-board')?.parent === o && signs.push(o));
  assert.equal(signs.length, 1);
  const plaque = shownBounds(signs[0]);
  const crown = BOOKSHELF.height;
  assert.ok(shownBounds(group).max.y <= crown + 0.07 + 1e-6, 'nothing of the shelf reaches over its crown');
  assert.ok(plaque.max.y < crown && plaque.min.y > crown - 0.12, `on the rail under the crown (${plaque.min.y.toFixed(3)} to ${plaque.max.y.toFixed(3)} m)`);
  // It stands against the south wall facing into the room (-z): the rail's face is flush with the case's front.
  const front = BOOKSHELF.z - BOOKSHELF.depth / 2;
  assert.ok(Math.abs(plaque.max.z - front) < 0.002, `its back on the rail's face (${plaque.max.z.toFixed(3)} against ${front.toFixed(3)})`);
  assert.ok(front - plaque.min.z < 0.012, 'a plaque screwed flat to the rail, not a board standing out from it');
  const face = (signs[0] as THREE.Mesh).material as THREE.MeshToonMaterial;
  assert.ok(face.isMeshToonMaterial && face.emissiveIntensity < 0.5, 'brass lit by the room like the wood');

  page(t, '');
  const desktop = buildBookshelf().group;
  let floating = 0;
  desktop.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry instanceof THREE.PlaneGeometry) floating = shownBounds(m).min.y;
  });
  assert.ok(floating > crown + 0.07 + 0.05, 'the desktop sign is unchanged, over the crown');
});

const ISSUES: GhState<GhIssue> = {
  items: [1, 2].map((n) => ({ number: n, title: `Issue ${n}`, state: 'OPEN', labels: [], url: '', author: '', createdAt: '', updatedAt: '' }) as unknown as GhIssue),
  fetchedAt: 1,
  loading: false,
};

test('in the headset app nothing hangs on the wall over a board: its title heads its own screen', (t) => {
  const text = page(t, '?native=1');
  const office = buildOffice();
  for (const label of ['Issues', 'Task queue', 'Pull Requests', 'Services']) assert.ok(!text.includes(label), `no "${label}" sign`);
  office.group.updateMatrixWorld(true);
  const over: string[] = [];
  for (const b of Object.values(BOARDS)) {
    if (b.rotY !== 0) continue;
    // The wall over the board, from just over its frame to the ceiling, and a hand's breadth out from it.
    const region = new THREE.Box3(new THREE.Vector3(b.x - b.width / 2, b.y + b.height / 2 + 0.16, b.z - 0.1), new THREE.Vector3(b.x + b.width / 2, WALL_HEIGHT - 0.05, b.z + 0.3));
    office.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !drawn(m)) return;
      m.geometry.computeBoundingBox();
      const box = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      const size = box.getSize(new THREE.Vector3());
      if (size.x < 3 && size.y < 3 && region.containsPoint(box.getCenter(new THREE.Vector3()))) over.push(`${b.label}: ${m.name || m.type}`);
    });
  }
  assert.deepEqual(over, []);

  text.length = 0;
  new BoardTexture('issues').render(ISSUES);
  assert.ok(text.includes('ISSUES') && text.includes('2 open'), text.join(' | '));
  text.length = 0;
  new BoardTexture('pulls').render({ items: [], fetchedAt: 1, loading: false });
  assert.ok(text.includes('PULL REQUESTS') && text.includes('No open PRs'), text.join(' | '));
  text.length = 0;
  new ServicesBoardTexture().render([], new Map());
  assert.ok(text.includes('SERVICES') && text.includes('No web servers running'), text.join(' | '));
  text.length = 0;
  new QueueBoardTexture().render({ tasks: [], maxWorkers: 3 } as never, new Map());
  assert.ok(text.includes('TASK QUEUE'));
});

test('on the desktop a board keeps its sign over it, and its screen no heading of its own', (t) => {
  const drawn = page(t, '');
  buildOffice();
  for (const label of ['Issues', '📋 Task queue', 'Pull Requests', '🌐 Services']) assert.ok(drawn.includes(label), `the "${label}" sign`);
  drawn.length = 0;
  new BoardTexture('issues').render(ISSUES);
  new ServicesBoardTexture().render([], new Map());
  assert.ok(!drawn.includes('ISSUES') && !drawn.includes('SERVICES'), drawn.join(' | '));
});

test("in the headset app the elevator's floor sign is its indicator: amber lit on a dark display in a housing on the door frame", (t) => {
  const drawn = page(t, '?native=1');
  const elevator = buildElevator();
  drawn.length = 0;
  elevator.setSign('🛗 floor-alpha');
  assert.deepEqual(drawn, ['floor-alpha']);
  const signs: THREE.Mesh[] = [];
  elevator.group.traverse((o) => o.getObjectByName('sign-board')?.parent === o && signs.push(o as THREE.Mesh));
  assert.equal(signs.length, 1, 'one indicator, replaced when the floor changes');
  const face = signs[0].material as THREE.MeshToonMaterial;
  assert.equal(face.emissiveIntensity, 1, 'lit from inside, as a display is');
  const housing = shownBounds(signs[0]);
  const frameTop = ELEVATOR.doorHeight + 0.08;
  assert.ok(Math.abs(housing.min.y - frameTop) < 0.002, `sitting on the door frame's head (${(housing.min.y - frameTop).toFixed(3)} m)`);
  assert.ok(housing.max.y - housing.min.y <= 0.241, 'an indicator, not a sign board');
  assert.ok(housing.max.x - housing.min.x <= ELEVATOR.doorWidth + 0.16, 'no wider than the door frame');
  assert.ok(Math.abs(housing.min.z - ELEVATOR_FRONT) < 0.002, 'its back against the shaft over the doors');
  elevator.setSign('🍸 Rooftop bar');
  const after: THREE.Object3D[] = [];
  elevator.group.traverse((o) => o.getObjectByName('sign-board')?.parent === o && after.push(o));
  assert.equal(after.length, 1);

  page(t, '');
  const desktop = buildElevator();
  desktop.setSign('🛗 floor-alpha');
  const label = desktop.group.children.at(-1) as THREE.Mesh;
  assert.ok(shownBounds(label).min.y > ELEVATOR.doorHeight + 0.2, 'the desktop sign is unchanged, high over the doors');
});

test('the headset office prints no emoji on its signs', (t) => {
  const drawn = page(t, '?native=1');
  const office = buildOffice();
  office.stack.set({ index: 0, count: 2, up: 'floor-beta' });
  const signs = drawn.filter((s) => /\p{Extended_Pictographic}/u.test(s));
  assert.deepEqual(signs, []);
  assert.ok(drawn.includes('↑ floor-beta'), 'the ladder sign says where it goes');
});

/** Whether `o` is drawn: it and every parent visible, with a material that draws. */
function drawn(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  return !!m && (Array.isArray(m) ? m : [m]).some((x) => x.visible && x.colorWrite && x.opacity > 0.05);
}

test('in the headset app every sign is fixed to something: a wall, shelf, beam, post or rail behind it, or the top it stands on', (t) => {
  page(t, '?native=1');
  const office = buildOffice();
  // A middle floor: the ladder's signs up and down, and the fire pole's sign down.
  office.stack.set({ index: 1, count: 3, up: 'floor-gamma', down: 'floor-alpha' });
  office.group.updateMatrixWorld(true);
  const signs: THREE.Mesh[] = [];
  const solid: THREE.Mesh[] = [];
  office.group.traverse((o) => {
    if (o.getObjectByName('sign-board')?.parent === o) signs.push(o as THREE.Mesh);
    else if ((o as THREE.Mesh).isMesh && o.name !== 'sign-board' && drawn(o)) solid.push(o as THREE.Mesh);
  });
  assert.ok(signs.filter(drawn).length >= 13, `the office's signs (${signs.filter(drawn).length})`);
  const ray = new THREE.Raycaster();
  const loose: string[] = [];
  for (const sign of signs.filter(drawn)) {
    const board = sign.getObjectByName('sign-board') as THREE.Mesh<THREE.BoxGeometry>;
    const { width, height, depth } = board.geometry.parameters;
    const scale = board.getWorldScale(new THREE.Vector3());
    board.geometry.computeBoundingBox();
    const near = board.geometry.boundingBox!.clone().applyMatrix4(board.matrixWorld).expandByScalar(0.03);
    const around = solid.filter((m) => {
      m.geometry.computeBoundingBox();
      return m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).intersectsBox(near);
    });
    /** Whether anything else is within `reach` meters of `from` (board space) along `dir`. */
    const touches = (from: THREE.Vector3, dir: THREE.Vector3, reach: number) => {
      ray.set(board.localToWorld(from), dir.transformDirection(board.matrixWorld));
      ray.far = reach;
      return ray.intersectObjects(around, false).length > 0;
    };
    // Every 4 cm across the board: from just in front of the face, back through the board to 1.5 cm
    // past its back; and from inside its foot, 1 cm down.
    const cols = Math.max(2, Math.ceil((width * scale.x) / 0.04));
    const rows = Math.max(2, Math.ceil((height * scale.y) / 0.04));
    let fixed = false;
    for (let i = 0; i <= cols && !fixed; i++) {
      const x = (i / cols - 0.5) * width * 0.98;
      fixed = touches(new THREE.Vector3(x, -height / 2 + 0.005, 0), new THREE.Vector3(0, -1, 0), 0.005 * scale.y + 0.01);
      for (let j = 0; j <= rows && !fixed; j++) {
        const y = (j / rows - 0.5) * height * 0.98;
        fixed = touches(new THREE.Vector3(x, y, depth / 2 + 0.01), new THREE.Vector3(0, 0, -1), (depth + 0.01) * scale.z + 0.015);
      }
    }
    const at = sign.getWorldPosition(new THREE.Vector3());
    if (!fixed) loose.push(`${at.x.toFixed(2)}, ${at.y.toFixed(2)}, ${at.z.toFixed(2)}`);
  }
  assert.deepEqual(loose, [], 'no sign hangs in the air');
});
