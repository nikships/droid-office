// Mission Control in the 3D office: which of the building's agents (shared/mission-control.ts) are in the
// room and where, what its wall screens say, and the team dashes from the room to their subagents' desks on
// the floor you're on. Pure: tests/mission-office.test.ts loads it in Node. What the office and the
// companion share is mission.ts.

import { GLASS_ROOM, GLASS_ROOM_CHAIRS, MISSION_HEAD, deskSeat } from '../shared/layout';
import { ORCHESTRATOR_COLOR, ORCHESTRATOR_ID, ORCHESTRATOR_NAME, orchestratorNeedsOwner, type MissionAgent, type MissionControlState, type MissionTeamMember } from '../shared/mission-control';
import type { TeamBadge, WorkerInfo, WorkerStatus } from '../shared/protocol';
import { isAsleep } from '../shared/status';
import { teamCounts } from '../shared/team';
import { buildingAgent } from './mission';
import type { TeamLink } from './world/team-lines';

/** Where a building agent is in the room: its feet, and its heading (`Object3D.rotation.y`, forward +z). */
export interface MissionSpot {
  x: number;
  z: number;
  rotY: number;
}

/** The Orchestrator, at the head of the table on its plinth. */
export const ORCHESTRATOR_SPOT: MissionSpot = { x: MISSION_HEAD.x, z: MISSION_HEAD.z, rotY: MISSION_HEAD.rotY };

/** Bot `i`'s chair: where it sits on it (as a worker sits at a desk, just behind the chair's middle), facing the table. */
export function chairSpot(i: number): MissionSpot | undefined {
  const def = GLASS_ROOM_CHAIRS[i];
  if (!def) return undefined;
  const at = deskSeat(def, 0.88);
  return { x: at.x, z: at.z, rotY: def.rotY + Math.PI };
}

/** Where you stand to talk to a building agent, and the face you look at. */
export interface MissionStand {
  at: { x: number; y: number; z: number };
  face: { x: number; y: number; z: number };
}

/** Keeps a standing spot this far inside Mission Control's glass. */
const WALL_GAP = 0.4;
/** Where you stand from the Orchestrator's feet: ahead of it (+x) and to its left (-z), past the table's near corner and inside its 1.8 m reach. */
const ORCHESTRATOR_STAND = { x: 0.7, z: -1.45 };
/** The Orchestrator's face above its plinth's top, where you look. */
const ORCHESTRATOR_FACE = 1.1;
/** How far behind a bot's chair and to its side you stand: clear of the chair back, inside its 0.9 m reach. */
const BOT_STAND = 0.6;
/** A seated bot's face above the floor, where you look. */
const BOT_FACE = 1.05;

/**
 * Where to stand at a building agent at (x, z): in front of the Orchestrator and to its left, by the
 * table's corner on the doorway's side, looking up at it on its plinth; behind a bot's chair and to one side, looking down at it.
 */
export function missionStand(it: { kind: 'orchestrator' | 'bot'; x: number; z: number }): MissionStand {
  if (it.kind === 'orchestrator') {
    return {
      at: { x: ORCHESTRATOR_SPOT.x + ORCHESTRATOR_STAND.x, y: 0, z: ORCHESTRATOR_SPOT.z + ORCHESTRATOR_STAND.z },
      face: { x: ORCHESTRATOR_SPOT.x, y: MISSION_HEAD.height + ORCHESTRATOR_FACE, z: ORCHESTRATOR_SPOT.z },
    };
  }
  const spot = GLASS_ROOM_CHAIRS.map((_, i) => chairSpot(i)!).reduce((a, b) => (Math.hypot(b.x - it.x, b.z - it.z) < Math.hypot(a.x - it.x, a.z - it.z) ? b : a));
  const back = { x: -Math.sin(spot.rotY), z: -Math.cos(spot.rotY) };
  const side = { x: Math.cos(spot.rotY), z: -Math.sin(spot.rotY) };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo + WALL_GAP, Math.min(hi - WALL_GAP, v));
  const x = clamp(it.x + (back.x + side.x) * BOT_STAND, GLASS_ROOM.minX, GLASS_ROOM.maxX);
  const z = clamp(it.z + (back.z + side.z) * BOT_STAND, GLASS_ROOM.minZ, GLASS_ROOM.maxZ);
  return { at: { x, y: 0, z }, face: { x: it.x, y: BOT_FACE, z: it.z } };
}

/** What the Orchestrator is up to, as the room shows it: off, can't start, never prompted, or its session's status. */
export type OrchestratorPhase = 'off' | 'blocked' | 'fresh' | WorkerStatus;

export function orchestratorPhase(state: MissionControlState | null | undefined): OrchestratorPhase {
  const o = state?.orchestrator;
  if (!o?.settings.on) return 'off';
  const w = o.agent?.worker;
  if (o.blocked && (!w || isAsleep(w.status))) return 'blocked';
  return w ? w.status : 'fresh';
}

/** One word or two for each phase, as the status pills say them. */
export const PHASE_WORD: Record<OrchestratorPhase, string> = {
  off: 'off',
  blocked: "can't start",
  fresh: 'ready',
  starting: 'starting',
  idle: 'ready',
  working: 'working',
  needs_input: 'needs you',
  done: 'done',
  exited: 'asleep',
  offline: 'asleep',
};

/**
 * The building agents in the room: the Orchestrator while it's on (a stand-in before its first prompt and after
 * a new conversation, when its team is still its team), then the bots in the order they were added.
 */
export function missionAgents(state: MissionControlState | null | undefined): MissionAgent[] {
  if (!state) return [];
  const o = buildingAgent(state, ORCHESTRATOR_ID);
  return [...(o ? [o] : []), ...state.bots];
}

/** The Orchestrator's session while its terminal can open: started and awake. Otherwise its prompt box stands in, and a prompt wakes it. */
export function orchestratorAwake(state: MissionControlState | null | undefined): WorkerInfo | undefined {
  const w = state?.orchestrator.settings.on ? state.orchestrator.agent?.worker : undefined;
  return w && !isAsleep(w.status) ? w : undefined;
}

/** The bots that have a chair at the table, and which; the rest are on the roster screen only. */
export function botChairs(state: MissionControlState | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  (state?.bots ?? []).slice(0, GLASS_ROOM_CHAIRS.length).forEach((b, i) => out.set(b.worker.id, i));
  return out;
}

/** The Orchestrator, when it waits on the owner: a question, a permission, or a reply nobody has read. */
export function orchestratorWaiting(state: MissionControlState | null | undefined): WorkerInfo | undefined {
  return state && orchestratorNeedsOwner(state) ? state.orchestrator.agent?.worker : undefined;
}

/**
 * The lead markings a building agent wears: its own lead badge, else the one its subagents on this floor
 * wear, else a team of its own colour (Mission Control's, for the Orchestrator).
 */
export function missionBadge(w: Pick<WorkerInfo, 'id' | 'name' | 'color' | 'team' | 'lead'>, floorWorkers: Iterable<WorkerInfo>): TeamBadge {
  if (w.team?.role === 'lead') return missionTeamBadge(w)!;
  for (const m of floorWorkers) if (m.lead === w.id && m.team) return { ...missionTeamBadge(m)!, role: 'lead' };
  const orchestrator = w.id === ORCHESTRATOR_ID;
  return { id: w.id, role: 'lead', accent: orchestrator ? ORCHESTRATOR_COLOR : w.color, emblem: orchestrator ? 'star' : 'hex', leadName: w.name };
}

/**
 * A worker's team markings as the office paints them. The Orchestrator's team takes a look of its own on each
 * floor, like any team; its accent is painted in the Orchestrator's colour so its markings match the room's.
 */
export function missionTeamBadge(w: Pick<WorkerInfo, 'id' | 'lead' | 'team'>): TeamBadge | undefined {
  return w.team && (w.id === ORCHESTRATOR_ID || w.lead === ORCHESTRATOR_ID) ? { ...w.team, accent: ORCHESTRATOR_COLOR } : w.team;
}

/** "🧭 3 subagents on 2 floors · 2 working · 1 needs you", or undefined for an agent with no team. */
export function missionTeamLine(team: readonly MissionTeamMember[]): string | undefined {
  if (!team.length) return undefined;
  const floors = new Set(team.map((m) => m.floor)).size;
  const { working, attention } = teamCounts(team.map((m) => ({ status: m.status, acked: true, lead: 'x' })));
  return [`🧭 ${team.length} subagent${team.length === 1 ? '' : 's'}${floors > 1 ? ` on ${floors} floors` : ''}`, working && `${working} working`, attention && `${attention} need${attention === 1 ? 's' : ''} you`]
    .filter(Boolean)
    .join(' · ');
}

/** When a bot's key was last used: "just now", "12 min ago", "3 h ago", "2 days ago", or "never". */
export function lastUsedWords(at: number | undefined, now: number): string {
  if (!at) return 'never';
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

type Point = { x: number; y: number; z: number };

/** The doorway's middle on the room's side, and on the office's: every team's dashes leave the room through it. */
const DOOR_X = (GLASS_ROOM.door.x0 + GLASS_ROOM.door.x1) / 2;
const DOOR_IN = GLASS_ROOM.minZ + 0.5;
const DOOR_OUT = GLASS_ROOM.minZ - 0.7;
/** Each agent's dashes take a lane of their own through the doorway, this far from the next. */
const LANE = 0.16;
/** West of the plinth, where dashes from the chairs meet before heading for the door. */
const HUB = { x: MISSION_HEAD.x - 0.75, z: MISSION_HEAD.z };

/**
 * The dashes from Mission Control to each building agent's subagents on this floor: one trunk per agent
 * from its spot out through the doorway, then one branch to each subagent's desk. `seat` is where a desk's
 * worker sits on this floor, undefined for a desk that isn't here.
 */
export function missionLinks(state: MissionControlState | null | undefined, floorWorkers: readonly WorkerInfo[], seat: (deskId: string) => Point | undefined): TeamLink[] {
  const agents = missionAgents(state);
  const chairs = botChairs(state);
  const teams = agents
    .map((a) => {
      const w = a.worker;
      const spot = w.id === ORCHESTRATOR_ID ? ORCHESTRATOR_SPOT : chairs.has(w.id) ? chairSpot(chairs.get(w.id)!) : undefined;
      const members = floorWorkers.flatMap((m) => {
        const at = m.lead === w.id ? seat(m.deskId) : undefined;
        return at ? [{ m, at }] : [];
      });
      return { w, spot, members };
    })
    .filter((t) => t.spot && t.members.length);
  const out: TeamLink[] = [];
  teams.forEach(({ w, spot, members }, i) => {
    const badge = missionBadge(w, floorWorkers);
    const lane = (i - (teams.length - 1) / 2) * LANE;
    const y = members[0].at.y;
    const junction = { x: DOOR_X + lane, y, z: DOOR_OUT };
    const moving = members.some(({ m }) => m.status === 'working');
    const from = { x: spot!.x, y, z: spot!.z };
    const via = [...(w.id === ORCHESTRATOR_ID ? [] : [{ x: HUB.x + lane, y, z: HUB.z }]), { x: DOOR_X + lane, y, z: DOOR_IN }];
    out.push({ from, to: junction, via, color: badge.accent, team: badge.id, moving });
    for (const { m, at } of members) out.push({ from: junction, to: at, color: badge.accent, team: badge.id, moving: m.status === 'working' });
  });
  return out;
}

/** One building agent as the roster screen lists it. */
export interface RosterAgent {
  id: string;
  name: string;
  kind: 'orchestrator' | 'bot';
  status: OrchestratorPhase;
  accent: string;
  team: { name: string; floor: string; status: WorkerStatus }[];
}

/** What Mission Control's screens show. Compared as JSON, so a screen is painted again only when it changes. */
export interface MissionView {
  phase: OrchestratorPhase;
  /** The Orchestrator's card: its task, what it's doing, its todos and its model. */
  title?: string;
  activity?: string;
  todos?: { done: number; total: number; current?: string };
  model?: string;
  blocked?: string;
  teamLine?: string;
  /** Every building agent, the Orchestrator first (even before its first prompt, while it's on). */
  agents: RosterAgent[];
}

/**
 * The screens' view of the state. `model` names a model id for the screen ("Opus 5.5 · High"), and
 * `activity` is the line a worker's card would show (shared/status.ts workerActivity).
 */
export function missionView(state: MissionControlState | null | undefined, floorWorkers: readonly WorkerInfo[], words: { model(w: WorkerInfo): string | undefined; activity(w: WorkerInfo): string | undefined }): MissionView {
  const phase = orchestratorPhase(state);
  const o = state?.orchestrator;
  const w = o?.settings.on ? o.agent?.worker : undefined;
  const roster: RosterAgent[] = [];
  if (o?.settings.on) {
    const team = o.team;
    roster.push({
      id: ORCHESTRATOR_ID,
      name: w?.name ?? ORCHESTRATOR_NAME,
      kind: 'orchestrator',
      status: phase,
      accent: w ? missionBadge(w, floorWorkers).accent : ORCHESTRATOR_COLOR,
      team: team.map((m) => ({ name: m.name, floor: m.floorName, status: m.status })),
    });
  }
  for (const b of state?.bots ?? []) {
    roster.push({
      id: b.worker.id,
      name: b.worker.name,
      kind: 'bot',
      status: b.worker.status,
      accent: missionBadge(b.worker, floorWorkers).accent,
      team: b.team.map((m) => ({ name: m.name, floor: m.floorName, status: m.status })),
    });
  }
  const t = w?.todos;
  return {
    phase,
    title: w?.task?.name,
    activity: w ? words.activity(w) : undefined,
    todos: t?.total ? { done: t.done, total: t.total, ...(t.current ? { current: t.current } : {}) } : undefined,
    model: w ? words.model(w) : undefined,
    blocked: o?.blocked,
    teamLine: missionTeamLine(o?.settings.on ? o.team : []),
    agents: roster,
  };
}
