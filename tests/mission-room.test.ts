import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ORCHESTRATOR_COLOR, ORCHESTRATOR_ID, type MissionControlState } from '../src/shared/mission-control.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { missionLinks, missionView, type RosterAgent } from '../src/client/mission-office.js';
import { TeamLines } from '../src/client/world/team-lines.js';
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

/** Stands a canvas in for `document`, keeping what each screen paints, and in `at` where each line's baseline is. */
function fakeCanvas(t: { after(fn: () => void): void }, at: { s: string; y: number }[] = []): string[] {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const text: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 0, height: 0, getContext: () => context };
        const context = new Proxy(
          {
            canvas,
            fillText: (s: string, _x: number, y: number) => {
              text.push(s);
              at.push({ s, y });
            },
            measureText: (s: string) => ({ width: s.length * 10 }),
          },
          { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
        );
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

test('Mission Control pins the Orchestrator’s body colour and keeps compact nameplates through redraws', (t) => {
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

test('the roster never draws past its footer, which counts every agent and subagent that did not fit', async (t) => {
  const at: { s: string; y: number }[] = [];
  fakeCanvas(t, at);
  const { MissionScreens } = await import('../src/client/world/mission-screens.js');
  const screens = new MissionScreens();
  screens.render({ phase: 'fresh', agents: [] });
  // The roster is 800 px tall: its footer sits 36 px off the bottom, and every other line a line (46 px) above it.
  const footerY = 800 - 36;
  for (const sizes of [[6, 6, 6], [2, 9], [1, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0], [3]]) {
    at.length = 0;
    // No bots, so the sign by the door stays as it is and only the roster repaints.
    const agents: RosterAgent[] = sizes.map((n, i) => ({
      id: `a${i}`,
      name: `Agent ${i}`,
      kind: 'orchestrator',
      status: 'working',
      accent: '#ee6018',
      team: Array.from({ length: n }, (_, j) => ({ name: `m${i}-${j}`, floor: 'web-app', status: 'working' as const })),
    }));
    screens.render({ phase: 'fresh', agents });
    const footer = at.filter((c) => /^\+ \d+ more$/.test(c.s));
    assert.ok(footer.length <= 1, `${sizes}: one footer at most`);
    for (const c of footer) assert.equal(c.y, footerY, `${sizes}: the footer sits at the bottom`);
    for (const c of at) if (!footer.includes(c)) assert.ok(c.y <= footerY - 46, `${sizes}: "${c.s}" at ${c.y} clears the footer`);
    const shown = at.filter((c) => /^(Agent \d+|m\d+-\d+)$/.test(c.s)).length;
    const total = agents.length + sizes.reduce((n, s) => n + s, 0);
    assert.equal(footer.length ? Number(/\d+/.exec(footer[0].s)![0]) : 0, total - shown, `${sizes}: the footer counts what was left out`);
  }
});

test('the sign counts only the bots that have a chair', async (t) => {
  const text = fakeCanvas(t);
  const { MissionScreens } = await import('../src/client/world/mission-screens.js');
  const bot = (i: number): RosterAgent => ({ id: `b${i}`, name: `Bot ${i}`, kind: 'bot', status: 'idle', accent: '#33aaff', team: [] });
  new MissionScreens().render({ phase: 'fresh', agents: Array.from({ length: GLASS_ROOM_CHAIRS.length + 2 }, (_, i) => bot(i)) });
  assert.ok(text.includes(`${GLASS_ROOM_CHAIRS.length} bots at the table`));
});

test('dashes keep their spacing on every leg of a team line routed out through the doorway', (t) => {
  fakeCanvas(t);
  const desk = (id: string) => ({ 'desk-1': { x: 2, y: 0, z: 2 } })[id];
  const sub = { id: 'w-1', name: 'Byte', kind: 'agent', deskId: 'desk-1', lead: ORCHESTRATOR_ID, status: 'idle', acked: true, color: '#33aaff', createdBy: '', createdAt: 0, cols: 0, rows: 0, open: false } as WorkerInfo;
  const state: MissionControlState = { orchestrator: { settings: { on: true } }, bots: [] };
  const lines = new TeamLines();
  lines.set([...missionLinks(state, [sub], desk), { from: { x: -8, y: 0, z: -4 }, to: { x: -2, y: 0, z: -4 }, color: '#ff0000', team: 'straight', moving: false }]);
  const legs = lines.group.children.filter((c): c is THREE.Mesh<THREE.PlaneGeometry> => c instanceof THREE.Mesh && c.geometry instanceof THREE.PlaneGeometry);
  assert.ok(legs.length >= 4, 'the trunk turns at least twice, then branches');
  // Repeats of the dash texture per metre along each leg: the same on a corner leg as on a straight link.
  const density = (m: THREE.Mesh<THREE.PlaneGeometry>) => Math.max(...(m.geometry.getAttribute('uv').array as Float32Array).filter((_, i) => i % 2 === 0)) / m.geometry.parameters.width;
  const straight = density(legs.find((m) => m.userData.team === 'straight')!);
  for (const m of legs) assert.ok(Math.abs(density(m) - straight) < 1e-6, `${m.userData.team}: ${density(m)} vs ${straight}`);
});
