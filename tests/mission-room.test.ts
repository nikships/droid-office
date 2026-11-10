import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ORCHESTRATOR_ID, type MissionControlState } from '../src/shared/mission-control.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { ORCHESTRATOR_COLOR } from '../src/client/mission.js';
import { missionView } from '../src/client/mission-office.js';
import { Worker } from '../src/client/world/character.js';
import { MissionRoom } from '../src/client/world/mission-control.js';
import { DESK_BY_ID, FLOOR, GLASS_ROOM, GLASS_ROOM_BOARD, GLASS_ROOM_CHAIRS, GLASS_ROOM_TABLE, LOFT, MISSION_HEAD, MISSION_ROSTER } from '../src/shared/layout.js';
import { PROMPT_IDS } from '../src/shared/prompts.js';
import type { MissionView } from '../src/client/mission-office.js';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Mission Control keeps the glass room’s footprint and furnishings, and none of its seats is a desk', () => {
  assert.equal(GLASS_ROOM.minX, LOFT.minX + 0.15);
  assert.equal(GLASS_ROOM.minZ, LOFT.minZ + 0.15);
  assert.deepEqual(GLASS_ROOM.door, { x0: 10, x1: 11.4 });
  assert.deepEqual(GLASS_ROOM_TABLE, { x: 13.7, z: 10.55, width: 3.6, depth: 1.2, height: 0.76 });
  assert.equal(GLASS_ROOM_CHAIRS.length, 5);
  assert.equal(GLASS_ROOM_BOARD.width, 3.6);
  for (let i = 1; i <= 5; i++) assert.equal(DESK_BY_ID.has(`meeting-${i}`), false);
  // The plinth stands clear of the table's west end and inside the glass; the roster screen hangs on the east wall.
  assert.ok(MISSION_HEAD.x + MISSION_HEAD.radius < GLASS_ROOM_TABLE.x - GLASS_ROOM_TABLE.width / 2);
  assert.ok(MISSION_HEAD.x - MISSION_HEAD.radius > GLASS_ROOM.minX);
  assert.equal(MISSION_HEAD.z, GLASS_ROOM_TABLE.z);
  assert.ok(Math.abs(MISSION_ROSTER.x - FLOOR.maxX) < 0.1);
});

test('meeting runtime, commands, menus, state, prompts and styles stay removed, and so does the glass room’s scenery module', () => {
  for (const file of ['src/server/meetings.ts', 'src/shared/meetings.ts', 'src/client/ui/meeting.ts', 'src/client/world/meeting.ts', 'src/client/world/glass-room.ts'])
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false, file);
  for (const file of [
    'src/shared/protocol.ts',
    'src/server/server.ts',
    'src/server/floor.ts',
    'src/client/main.ts',
    'src/client/state.ts',
    'src/client/automation.ts',
    'src/client/ui/boards.ts',
    'src/client/ui/pull.ts',
    'src/client/ui/menu.ts',
    'src/client/style.css',
  ])
    assert.doesNotMatch(source(file), /meeting|Meeting|MEETING|Review panel|pull\.panel/, file);
  assert.ok(PROMPT_IDS.every((id) => !id.includes('meeting') && id !== 'pull.panel'));
  const room = source('src/client/world/office.ts').split('function buildGlassRoom(')[1].split('/** The materials')[0];
  // The room is glass, furniture and screen frames: who is in it, and what E does there, is world/mission-control.ts's.
  assert.doesNotMatch(room, /interact|DeskView|laptopAnchor|seatAnchor|stage|vacancy/);
  assert.match(room, /doors\.push/);
  assert.match(room, /MISSION CONTROL/);
});

/** Stands a canvas in for `document`, keeping what each screen paints. */
function fakeCanvas(t: { after(fn: () => void): void }): string[] {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const text: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 0, height: 0, getContext: () => context };
        const context = new Proxy({ canvas, fillText: (s: string) => text.push(s), measureText: (s: string) => ({ width: s.length * 10 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
        return canvas;
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  return text;
}

test('Mission Control pins the Orchestrator’s body colour and keeps compact, fading nameplates through redraws', (t) => {
  fakeCanvas(t);
  const mount = () => new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  const room = new MissionRoom({ board: mount(), roster: mount(), sign: mount() }, []);
  const worker = (id: string, color: string): WorkerInfo => ({ id, color, name: id, kind: 'agent', status: 'idle', deskId: '', acked: true, createdBy: '', createdAt: 0, cols: 0, rows: 0, open: false }) as WorkerInfo;
  const state: MissionControlState = {
    orchestrator: { settings: { on: true }, agent: { worker: worker(ORCHESTRATOR_ID, '#00ff00'), team: [] } },
    bots: [{ worker: worker('Proof Bot', '#33aaff'), team: [] }],
  };
  const sync = () => room.sync(state, [], missionView(state, [], { model: () => undefined, activity: () => undefined }), () => {});
  sync();
  const original = room.orchestrator!;
  assert.equal(original.color, ORCHESTRATOR_COLOR);
  assert.equal(room.views.get('Proof Bot')!.color, '#33aaff');
  const nameplate = (model: Worker) => model.root.children.find((c): c is THREE.Sprite => c instanceof THREE.Sprite && c.position.y === 1.55)!;
  const ordinary = new Worker(ORCHESTRATOR_ID, ORCHESTRATOR_COLOR);
  t.after(() => ordinary.dispose());
  const ordinaryWidth = nameplate(ordinary).scale.x;
  assert.equal(nameplate(original.model).scale.x, ordinaryWidth * 0.5);
  original.model.setTeam({ id: ORCHESTRATOR_ID, role: 'lead', accent: ORCHESTRATOR_COLOR, emblem: 'star', leadName: 'Orchestrator' });
  assert.equal(nameplate(original.model).scale.x, ordinaryWidth * 0.5, 'a team redraw preserves the compact scale');
  original.model.seenFrom(1);
  original.model.update(0, 0);
  assert.equal(nameplate(original.model).material.opacity, 0, 'names disappear close up, just like desk-worker names');
  original.model.seenFrom(7);
  original.model.update(0, 0);
  assert.equal(nameplate(original.model).material.opacity, 1);
  state.orchestrator.agent!.worker.color = '#ff00ff';
  state.bots[0].worker.color = '#4455ff';
  sync();
  assert.equal(room.orchestrator, original, 'a session colour change does not replace the Orchestrator');
  assert.equal(room.views.get('Proof Bot')!.color, '#4455ff', 'bots keep their own reported colours');
  state.orchestrator.settings.on = false;
  state.bots = [];
  sync();
  assert.equal(room.views.size, 0);
});

test('the screens say what the Orchestrator is doing and who is on each building agent’s team, and repaint only on a change', async (t) => {
  const text = fakeCanvas(t);
  const { MissionScreens } = await import('../src/client/world/mission-screens.js');
  const screens = new MissionScreens();
  assert.deepEqual([screens.board.image.width, screens.board.image.height], [1500, 500]);
  assert.deepEqual([screens.roster.image.width, screens.roster.image.height], [1400, 800]);
  assert.deepEqual([screens.sign.image.width, screens.sign.image.height], [500, 800]);
  const view: MissionView = {
    phase: 'working',
    title: 'Get CI green',
    activity: 'Hiring a worker on web-app',
    todos: { done: 2, total: 5, current: 'Fix the flaky test' },
    model: 'Opus 4.5 · High',
    teamLine: '🧭 2 subagents on 2 floors · 2 working',
    agents: [
      { id: 'orchestrator', name: 'Orchestrator', kind: 'orchestrator', status: 'working', accent: '#ee6018', team: [{ name: 'Byte', floor: 'web-app', status: 'working' }] },
      { id: 'bot-claw', name: 'OpenClaw', kind: 'bot', status: 'offline', accent: '#33aaff', team: [] },
    ],
  };
  screens.render(view);
  for (const s of ['MISSION CONTROL', 'Get CI green', 'WORKING', '2 of 5 · Fix the flaky test', 'Byte', 'web-app', 'OpenClaw', 'BOT', 'no team', '1 bot at the table'])
    assert.ok(
      text.some((x) => x.includes(s)),
      s,
    );
  const before = text.length;
  screens.render({ ...view });
  assert.equal(text.length, before, 'the same view paints nothing');
  screens.render({ ...view, phase: 'off', title: undefined, activity: undefined, todos: undefined, agents: view.agents.slice(1) });
  assert.ok(text.slice(before).includes('The Orchestrator is off'));
  screens.render({ ...view, phase: 'blocked', blocked: 'Droid is signed out', agents: [] });
  assert.ok(text.includes("The Orchestrator can't start"));
  assert.ok(text.some((x) => x.includes('Droid is signed out')));
  assert.ok(text.includes('Nobody here yet'));
});
