// The headset app floats no name, state or pitch over anyone: a worker's name, engine and state are
// printed on its seat's nameplate with a status lamp, a teammate wears a name badge, and a board
// agent's kiosk shows only its nameplate until you greet it. Desktop and WebXR keep their tags.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { floatingTagsShown, worldNotice } from '../src/client/native/mode.js';
import { Nameplate, paintPlate, type PlateText } from '../src/client/world/nameplate.js';
import { Person, Worker, workerPlate, type WorkerPlateState } from '../src/client/world/character.js';
import { buildOffice } from '../src/client/world/office.js';

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

test("a worker's nameplate shows what its tags would: name, engine, state pill, task and lamp", () => {
  assert.deepEqual(workerPlate(RESTING), { name: 'Pixel 🐚', role: 'Shell', chip: ['💬 READY', '#5aa9e6', '#2b2d42'], line: '', color: '#8d99ae', lamp: '#5aa9e6', pulse: 'steady' });
  const working = workerPlate({ ...RESTING, status: 'working', task: { name: 'Fix the login page', summary: 'Reading the form' } });
  assert.equal(working.chip[0], '⌨️ WORKING');
  assert.equal(working.line, 'Fix the login page');
  assert.equal(working.pulse, 'busy', 'its lamp breathes while it works');
  assert.equal(workerPlate({ ...RESTING, status: 'needs_input' }).pulse, 'call', 'and blinks while it waits on you');
  assert.equal(workerPlate({ ...RESTING, status: 'done', bounce: true }).pulse, 'call');
  assert.equal(workerPlate({ ...RESTING, status: 'done' }).pulse, 'steady', 'once someone has looked, a finished one rests');
  assert.equal(workerPlate({ ...RESTING, out: true }).lamp, null, 'shot or leaving: the lamp is out');
  assert.deepEqual(workerPlate({ ...RESTING, lost: true }).chip, ['🌿 WORKTREE DELETED', '#ffb703', '#2b2d42']);
  assert.equal(workerPlate({ ...RESTING, pr: { state: 'merged', label: '🎉 PR #12 merged' } }).chip[0], '🎉 PR #12 MERGED');
  assert.equal(workerPlate({ ...RESTING, status: 'working', pr: { state: 'open', label: 'PR #12' } }).chip[0], '⌨️ WORKING', 'working comes before its PR');
});

test('a nameplate paints its name and state, and a pitch only once it has one', (t) => {
  const drawn = page(t, '?native=1');
  const text: PlateText = { ...workerPlate({ ...RESTING, name: 'Issues agent', role: 'Issues board' }) };
  paintPlate(document.createElement('canvas').getContext('2d')!, 900, 360, text, null);
  assert.deepEqual(drawn, ['Issues agent', 'Issues board', '💬 READY']);
  assert.equal(
    drawn.some((s) => /ask me/i.test(s)),
    false,
  );
  drawn.length = 0;
  paintPlate(document.createElement('canvas').getContext('2d')!, 900, 360, text, { heading: '📌 Issues agent', title: 'Ask me about issues', body: 'I file, find, triage, label and close them' });
  assert.ok(drawn.includes('Ask me about issues'), drawn.join(' | '));
});

test('in the headset app a worker floats nothing over its head; its seat nameplate carries it all', (t) => {
  page(t, '?native=1');
  const plate = new Nameplate({ shape: 'prism', width: 0.36, height: 0.2 });
  const pixel = new Worker('Pixel 🐚', '#8d99ae');
  pixel.setRole('Shell');
  pixel.setStatus('working', false);
  pixel.setTask({ name: 'Fix the login page', summary: 'Reading the form' });
  pixel.setPr({ state: 'open', label: 'PR #12' });
  assert.deepEqual(sprites(pixel.root), [], 'no name tag, bubble or task card');
  assert.equal(plate.root.visible, false, 'a seat nobody has sat in shows no plate');

  pixel.setPlate(plate);
  assert.equal(plate.root.visible, true);
  assert.deepEqual(
    { name: plate.showing.text?.name, role: plate.showing.text?.role, chip: plate.showing.text?.chip[0], line: plate.showing.text?.line, pulse: plate.showing.text?.pulse },
    { name: 'Pixel 🐚', role: 'Shell', chip: '⌨️ WORKING', line: 'Fix the login page', pulse: 'busy' },
  );
  pixel.setStatus('needs_input', true);
  assert.equal(plate.showing.text?.pulse, 'call');
  pixel.die();
  assert.equal(plate.showing.text?.lamp, null, 'shot: the lamp goes out with its antenna bulb');
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
  const display = new Nameplate({ shape: 'panel', width: 0.6, height: 0.24 });
  const waiting = new Worker('Issues agent', '#ef476f');
  waiting.setStatus('idle', false);
  waiting.setRole('Issues board');
  waiting.setPlate(display);
  assert.equal(display.showing.text?.chip[0], '💬 READY');

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
  assert.equal(display.showing.text?.chip[0], '⌨️ WORKING', 'only whoever claimed it last can change it');

  hired.setPlate(null);
  assert.equal(display.root.visible, false);
  waiting.setPlate(display);
  assert.equal(display.showing.text?.chip[0], '💬 READY');
});

test('on the desktop a worker still wears its name tag and status card, and fills no nameplate', (t) => {
  page(t, '');
  const pixel = new Worker('Pixel 🐚', '#8d99ae');
  pixel.setStatus('working', false);
  pixel.setTask({ name: 'Fix the login page', summary: 'Reading the form' });
  assert.equal(sprites(pixel.root).length, 2, 'its name tag and its task card');
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
    assert.ok(desk.plate.width > 0.3 && desk.plate.height >= 0.16, `${id}: big enough to read`);
  }
  assert.equal(office.desks.get('station-issues')?.plate.shape, 'panel');
  assert.equal(office.desks.get('desk-1')?.plate.shape, 'prism');
});
