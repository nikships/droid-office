import test from 'node:test';
import assert from 'node:assert/strict';
import { GLASS_ROOM, GLASS_ROOM_CHAIRS, GLASS_ROOM_TABLE, MISSION_HEAD } from '../src/shared/layout.js';
import { ORCHESTRATOR_COLOR, ORCHESTRATOR_ID, type MissionAgent, type MissionControlState } from '../src/shared/mission-control.js';
import { walkable } from '../src/shared/nav.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import {
  ORCHESTRATOR_SPOT,
  botChairs,
  chairSpot,
  lastUsedWords,
  missionAgents,
  missionBadge,
  missionLinks,
  missionStand,
  missionTeamBadge,
  missionTeamLine,
  missionView,
  orchestratorAwake,
  orchestratorPhase,
  orchestratorWaiting,
} from '../src/client/mission-office.js';

const worker = (over: Partial<WorkerInfo>): WorkerInfo =>
  ({ id: ORCHESTRATOR_ID, kind: 'agent', name: 'Orchestrator', color: '#ee6018', deskId: '', status: 'idle', acked: true, createdBy: '', createdAt: 0, cols: 120, rows: 40, open: true, ...over }) as WorkerInfo;
const bot = (id: string, over: Partial<MissionAgent> = {}): MissionAgent => ({ worker: worker({ id, name: id, color: '#33aaff', remote: true, status: 'working' }), team: [], ...over });
// As the server sends it: `team` is the session's team while there is one.
const state = (over: Partial<MissionControlState['orchestrator']> = {}, bots: MissionAgent[] = []): MissionControlState => ({ orchestrator: { settings: { on: true }, team: over.agent?.team ?? [], ...over }, bots });
const forward = (rotY: number) => ({ x: Math.sin(rotY), z: Math.cos(rotY) });
const inside = (p: { x: number; z: number }) => p.x > GLASS_ROOM.minX && p.x < GLASS_ROOM.maxX && p.z > GLASS_ROOM.minZ && p.z < GLASS_ROOM.maxZ;

test('the Orchestrator stands on its plinth facing down the table, and each bot sits facing the table', () => {
  assert.deepEqual([ORCHESTRATOR_SPOT.x, ORCHESTRATOR_SPOT.z], [MISSION_HEAD.x, MISSION_HEAD.z]);
  const f = forward(ORCHESTRATOR_SPOT.rotY);
  assert.ok(f.x > 0.99, 'it looks +x, along the table');
  for (let i = 0; i < GLASS_ROOM_CHAIRS.length; i++) {
    const s = chairSpot(i)!;
    const toTable = { x: GLASS_ROOM_TABLE.x - s.x, z: GLASS_ROOM_TABLE.z - s.z };
    const d = forward(s.rotY);
    assert.ok(d.x * toTable.x + d.z * toTable.z > 0, `chair ${i} faces the table`);
    assert.ok(inside(s), `chair ${i} is in the room`);
  }
  assert.equal(chairSpot(GLASS_ROOM_CHAIRS.length), undefined);
});

test('you stand inside the glass, on open floor, within reach of whom you talk to', () => {
  const o = missionStand({ kind: 'orchestrator', ...ORCHESTRATOR_SPOT });
  assert.ok(inside(o.at) && walkable(o.at.x, o.at.z), 'beside the Orchestrator');
  assert.ok(Math.hypot(o.at.x - ORCHESTRATOR_SPOT.x, o.at.z - ORCHESTRATOR_SPOT.z) < 1.8, 'within its 1.8 m');
  const ahead = forward(ORCHESTRATOR_SPOT.rotY);
  assert.ok((o.at.x - ORCHESTRATOR_SPOT.x) * ahead.x + (o.at.z - ORCHESTRATOR_SPOT.z) * ahead.z > 0, 'in front of it, where its face is');
  assert.ok(o.face.y > MISSION_HEAD.height + 0.8, 'looking up at its face on the plinth');
  for (let i = 0; i < GLASS_ROOM_CHAIRS.length; i++) {
    const s = chairSpot(i)!;
    const b = missionStand({ kind: 'bot', x: s.x, z: s.z });
    assert.ok(inside(b.at) && walkable(b.at.x, b.at.z), `behind chair ${i}`);
    assert.ok(Math.hypot(b.at.x - s.x, b.at.z - s.z) < 0.9, `within bot ${i}'s 0.9 m`);
  }
});

test('the Orchestrator is in the room while it is on; bots take the chairs in the order they were added', () => {
  const agent = { worker: worker({ status: 'working' }), team: [] };
  const bots = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => bot(id));
  assert.deepEqual(
    missionAgents(state({ agent }, bots.slice(0, 1))).map((a) => a.worker.id),
    [ORCHESTRATOR_ID, 'a'],
  );
  assert.deepEqual(
    missionAgents(state({ settings: { on: false }, agent }, bots.slice(0, 1))).map((a) => a.worker.id),
    ['a'],
    'off, it is not',
  );
  assert.deepEqual(
    missionAgents(state()).map((a) => [a.worker.id, a.worker.color, a.team.length]),
    [[ORCHESTRATOR_ID, ORCHESTRATOR_COLOR, 0]],
    'before its first prompt and after a new conversation, its stand-in',
  );
  assert.deepEqual(missionAgents(undefined), []);
  const chairs = botChairs(state({}, bots));
  assert.deepEqual(
    [...chairs],
    [
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
      ['e', 4],
    ],
    'the sixth bot is on the roster only',
  );
});

test('its phase: off, blocked, fresh, or its session’s status', () => {
  assert.equal(orchestratorPhase(undefined), 'off');
  assert.equal(orchestratorPhase(state({ settings: { on: false } })), 'off');
  assert.equal(orchestratorPhase(state()), 'fresh');
  assert.equal(orchestratorPhase(state({ blocked: 'Droid is signed out' })), 'blocked');
  assert.equal(orchestratorPhase(state({ blocked: 'x', agent: { worker: worker({ status: 'working' }), team: [] } })), 'working', 'a running turn carries on');
  assert.equal(orchestratorPhase(state({ blocked: 'x', agent: { worker: worker({ status: 'exited' }), team: [] } })), 'blocked');
  assert.equal(orchestratorPhase(state({ agent: { worker: worker({ status: 'needs_input' }), team: [] } })), 'needs_input');
  assert.equal(orchestratorWaiting(state({ agent: { worker: worker({ status: 'needs_input' }), team: [] } }))?.id, ORCHESTRATOR_ID);
  assert.equal(orchestratorWaiting(state({ agent: { worker: worker({ status: 'working' }), team: [] } })), undefined);
});

test('its terminal opens only while it has a session that is awake; otherwise its prompt box stands in', () => {
  const at = (status: WorkerInfo['status']) => state({ agent: { worker: worker({ status }), team: [] } });
  assert.equal(orchestratorAwake(undefined), undefined);
  assert.equal(orchestratorAwake(state()), undefined, 'never prompted');
  assert.equal(orchestratorAwake(state({ settings: { on: false }, agent: { worker: worker({ status: 'working' }), team: [] } })), undefined, 'off');
  for (const status of ['exited', 'offline'] as const) assert.equal(orchestratorAwake(at(status)), undefined, status);
  for (const status of ['starting', 'idle', 'working', 'needs_input', 'done'] as const) assert.equal(orchestratorAwake(at(status))?.id, ORCHESTRATOR_ID, status);
});

test('a building agent wears its own lead badge, else its subagents’, else a team of its own colour', () => {
  const o = worker({});
  const own = missionBadge(o, []);
  assert.deepEqual(own, { id: ORCHESTRATOR_ID, role: 'lead', accent: ORCHESTRATOR_COLOR, emblem: 'star', leadName: 'Orchestrator' });
  const sub = worker({ id: 'w-1', deskId: 'desk-1', lead: ORCHESTRATOR_ID, team: { id: 't-9', role: 'member', accent: '#00ff00', emblem: 'bolt', leadName: 'Orchestrator' } as WorkerInfo['team'] });
  assert.deepEqual(missionBadge(o, [sub]), { id: 't-9', role: 'lead', accent: ORCHESTRATOR_COLOR, emblem: 'bolt', leadName: 'Orchestrator' });
  assert.deepEqual(missionTeamBadge(sub), { ...sub.team, accent: ORCHESTRATOR_COLOR }, 'member markings use the same accent, even from an old session');
  assert.equal(sub.team?.accent, '#00ff00', 'painting does not mutate the saved session');
  assert.equal(missionBadge({ ...o, team: { ...sub.team!, role: 'lead' } }, []).accent, ORCHESTRATOR_COLOR, 'an existing lead badge is orange too');
  assert.equal(missionTeamBadge({ ...sub, lead: 'claw' }), sub.team, 'bots keep their own team accents');
  const b = bot('claw').worker;
  assert.deepEqual(missionBadge(b, []), { id: 'claw', role: 'lead', accent: '#33aaff', emblem: 'hex', leadName: 'claw' });
});

test('the words: a team across floors, and when a bot was last used', () => {
  assert.equal(missionTeamLine([]), undefined);
  assert.equal(
    missionTeamLine([
      { id: 'a', name: 'A', floor: 'f1', floorName: 'one', status: 'working' },
      { id: 'b', name: 'B', floor: 'f2', floorName: 'two', status: 'needs_input' },
    ]),
    '🧭 2 subagents on 2 floors · 1 working · 1 needs you',
  );
  assert.equal(missionTeamLine([{ id: 'a', name: 'A', floor: 'f1', floorName: 'one', status: 'idle' }]), '🧭 1 subagent');
  const now = 10_000_000_000;
  assert.equal(lastUsedWords(undefined, now), 'never');
  assert.equal(lastUsedWords(now - 5_000, now), 'just now');
  assert.equal(lastUsedWords(now - 12 * 60_000, now), '12 min ago');
  assert.equal(lastUsedWords(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(lastUsedWords(now - 86_400_000, now), '1 day ago');
});

test('team dashes leave Mission Control through its doorway, one lane per agent, then branch to each subagent here', () => {
  const desks: Record<string, { x: number; y: number; z: number }> = { 'desk-1': { x: 2, y: 0, z: 2 }, 'desk-2': { x: 5, y: 0, z: 3 }, 'desk-3': { x: 4, y: 0, z: 6 } };
  const seat = (id: string) => desks[id];
  const floor = [
    worker({ id: 'w-1', deskId: 'desk-1', lead: ORCHESTRATOR_ID, status: 'working' }),
    worker({ id: 'w-2', deskId: 'desk-2', lead: ORCHESTRATOR_ID, status: 'idle' }),
    worker({ id: 'w-3', deskId: 'desk-3', lead: 'claw', status: 'idle' }),
    worker({ id: 'w-4', deskId: 'elsewhere', lead: ORCHESTRATOR_ID }),
  ];
  const s = state({ agent: { worker: worker({}), team: [] } }, [bot('claw'), bot('lonely')]);
  const links = missionLinks(s, floor, seat);
  const trunks = links.filter((l) => l.via);
  assert.equal(trunks.length, 2, 'the lonely bot has nobody on this floor');
  assert.equal(links.length - trunks.length, 3, 'a branch to each subagent here, none for one on another floor');
  const [o, c] = trunks;
  assert.deepEqual([o.from.x, o.from.z], [ORCHESTRATOR_SPOT.x, ORCHESTRATOR_SPOT.z]);
  for (const t of trunks) {
    assert.ok(t.to.z < GLASS_ROOM.minZ && t.to.x > GLASS_ROOM.door.x0 && t.to.x < GLASS_ROOM.door.x1, 'out through the doorway');
    const last = t.via!.at(-1)!;
    assert.ok(last.z > GLASS_ROOM.minZ && Math.abs(last.x - t.to.x) < 1e-9, 'straight through it');
  }
  assert.notEqual(o.to.x, c.to.x, 'each in its own lane');
  assert.equal(o.moving, true, 'a working subagent marches the trunk');
  assert.equal(c.moving, false);
  const branches = links.filter((l) => !l.via && l.team === o.team);
  assert.deepEqual(
    branches.map((l) => [l.to.x, l.to.z]),
    [
      [2, 2],
      [5, 3],
    ],
  );
  assert.deepEqual(missionLinks(undefined, floor, seat), []);
  const reset = missionLinks(state({}, []), floor, seat);
  assert.deepEqual(
    reset.filter((l) => !l.via).map((l) => [l.to.x, l.to.z]),
    [
      [2, 2],
      [5, 3],
    ],
    'after a new conversation its team is still its team, and its dashes stay',
  );
  assert.equal(missionLinks(state({ settings: { on: false } }, []), floor, seat).length, 0, 'off, its team reports to nobody');
});

test('the screens’ view: the Orchestrator’s card and every building agent with its team', () => {
  const words = { model: (w: WorkerInfo) => w.model, activity: (w: WorkerInfo) => w.activity };
  const team = [{ id: 'w-1', name: 'Byte', floor: 'f1', floorName: 'web-app', status: 'working' as const }];
  const agent = { worker: worker({ status: 'working', model: 'opus', activity: 'Reading CI', task: { name: 'Get CI green' } as WorkerInfo['task'], todos: { done: 1, total: 3, current: 'Fix it' } as WorkerInfo['todos'] }), team };
  const v = missionView(state({ agent }, [bot('claw', { team })]), [], words);
  assert.equal(v.phase, 'working');
  assert.equal(v.title, 'Get CI green');
  assert.equal(v.activity, 'Reading CI');
  assert.equal(v.model, 'opus');
  assert.deepEqual(v.todos, { done: 1, total: 3, current: 'Fix it' });
  assert.equal(v.teamLine, '🧭 1 subagent · 1 working');
  assert.deepEqual(
    v.agents.map((a) => [a.id, a.kind, a.status, a.team.map((m) => `${m.name}@${m.floor}`)]),
    [
      [ORCHESTRATOR_ID, 'orchestrator', 'working', ['Byte@web-app']],
      ['claw', 'bot', 'working', ['Byte@web-app']],
    ],
  );
  const fresh = missionView(state(), [], words);
  assert.equal(fresh.phase, 'fresh');
  assert.deepEqual(
    fresh.agents.map((a) => [a.name, a.status]),
    [['Orchestrator', 'fresh']],
    'on before its first prompt, it is on the roster',
  );
  const off = missionView(state({ settings: { on: false }, agent }), [], words);
  assert.equal(off.phase, 'off');
  assert.equal(off.title, undefined);
  assert.deepEqual(off.agents, []);
  assert.equal(off.teamLine, undefined);
  const kept = missionView(state({ team }), [], words);
  assert.equal(kept.phase, 'fresh');
  assert.equal(kept.teamLine, '🧭 1 subagent · 1 working', 'after a new conversation its team is still on its card');
  assert.deepEqual(
    kept.agents.map((a) => [a.id, a.team.map((m) => m.name)]),
    [[ORCHESTRATOR_ID, ['Byte']]],
  );
});
