import * as THREE from 'three';
import { MISSION_HEAD } from '../../shared/layout';
import { ORCHESTRATOR_COLOR, ORCHESTRATOR_ID, ORCHESTRATOR_NAME, type MissionControlState } from '../../shared/mission-control';
import type { WorkerInfo } from '../../shared/protocol';
import { ORCHESTRATOR_SPOT, botChairs, chairSpot, missionBadge, orchestratorPhase, type MissionSpot, type MissionView, type OrchestratorPhase } from '../mission-office';
import { Worker } from './character';
import { MissionScreens, phaseColor } from './mission-screens';
import type { Interactable, MissionMounts } from './office';
import { mesh, toonUnique } from './toon';

// Who is in Mission Control (src/client/mission-office.ts says who and where): the Orchestrator on its plinth at
// the head of the table while it's on, and each external bot in a chair, as worker droids. The room itself
// (glass, table, chairs, plinth, screen frames) is office.ts's; this paints its screens and lights the ring
// round the plinth in the Orchestrator's status colour.

/** A building agent in the room. */
export interface MissionAgentView {
  id: string;
  model: Worker;
  it: Interactable;
  /** What main.ts last painted, so it dings once when the Orchestrator starts waiting on you. */
  status: string;
  acked: boolean;
  /** The colour its body was made in; a new one makes a new body. */
  color: string;
  /** The name on its tag. */
  name: string;
  /** The chair it's in, for a bot. */
  chair?: number;
}

/** Standing on its plinth, it's a little bigger than a worker sitting at a desk. */
const ORCHESTRATOR_SCALE = 0.95;
/** A bot in a chair sits like a worker at a desk. */
const SEATED = { y: 0.4, scale: 0.82 };

export class MissionRoom {
  /** Everyone in the room, and the plinth's ring: hidden while the bounce light bakes, like a floor's workers. */
  readonly group = new THREE.Group();
  readonly screens = new MissionScreens();
  /** The Orchestrator, and its screen over the table: E at either opens it, on or off. */
  readonly orchestratorSpot: Interactable = { kind: 'orchestrator', x: ORCHESTRATOR_SPOT.x, z: ORCHESTRATOR_SPOT.z, radius: 1.8, agentId: ORCHESTRATOR_ID };
  /** The Orchestrator and the seated bots, by worker id. */
  readonly views = new Map<string, MissionAgentView>();
  private ringMat = toonUnique(ORCHESTRATOR_COLOR);
  private phase: OrchestratorPhase = 'off';
  private pulseT = 0;

  constructor(
    mounts: MissionMounts,
    private interactables: Interactable[],
  ) {
    this.group.name = 'mission-control';
    mounts.board.material.map = this.screens.board;
    mounts.roster.material.map = this.screens.roster;
    mounts.sign.material.map = this.screens.sign;
    for (const m of [mounts.board, mounts.roster, mounts.sign]) m.material.needsUpdate = true;
    mounts.board.userData.interact = this.orchestratorSpot;
    interactables.push(this.orchestratorSpot);
    this.ringMat.emissive = new THREE.Color(ORCHESTRATOR_COLOR).multiplyScalar(0.7);
    const ring = mesh(new THREE.TorusGeometry(MISSION_HEAD.radius - 0.015, 0.016, 6, 40).rotateX(Math.PI / 2), this.ringMat, MISSION_HEAD.x, MISSION_HEAD.height, MISSION_HEAD.z);
    ring.name = 'mission-ring';
    this.group.add(ring);
    this.paintRing();
  }

  /** The Orchestrator's view, while it's in the room. */
  get orchestrator(): MissionAgentView | undefined {
    return this.views.get(ORCHESTRATOR_ID);
  }

  /** Someone in the room is moving, or the ring is pulsing: the frame can't be skipped. */
  get animating(): boolean {
    if (this.phase === 'needs_input') return true;
    for (const v of this.views.values()) if (v.model.animating) return true;
    return false;
  }

  /**
   * Puts the building agents in `state` in their places and paints the screens with `view`. `dress` paints
   * an agent's status, card and markings the way a floor's worker's are; the room then puts its lead
   * markings on (a building agent leads its team from here, whatever its own record says).
   */
  sync(state: MissionControlState | undefined, floorWorkers: readonly WorkerInfo[], view: MissionView, dress: (v: MissionAgentView, w: WorkerInfo) => void) {
    this.phase = orchestratorPhase(state);
    this.paintRing();
    this.screens.render(view);
    const want = new Map<string, { w: WorkerInfo | undefined; color: string; spot: MissionSpot; chair?: number }>();
    const o = state?.orchestrator;
    if (o?.settings.on) want.set(ORCHESTRATOR_ID, { w: o.agent?.worker, color: ORCHESTRATOR_COLOR, spot: ORCHESTRATOR_SPOT });
    const chairs = botChairs(state);
    for (const b of state?.bots ?? []) {
      const chair = chairs.get(b.worker.id);
      const spot = chair === undefined ? undefined : chairSpot(chair);
      if (spot) want.set(b.worker.id, { w: b.worker, color: b.worker.color, spot, chair });
    }
    for (const [id, v] of this.views) {
      const next = want.get(id);
      if (next && v.color === next.color) continue;
      this.remove(id);
    }
    for (const [id, { w, color, spot, chair }] of want) {
      let v = this.views.get(id);
      v ??= this.add(id, w?.name ?? ORCHESTRATOR_NAME, color, chair);
      if (v.chair !== chair || !v.model.root.parent) this.place(v, spot, chair);
      if (w) dress(v, w);
      else {
        // On, but never prompted (or starting over): ready, or asleep while something stops it starting.
        v.model.setStatus(this.phase === 'blocked' ? 'offline' : 'idle', false);
        v.model.setTask(undefined);
        v.model.setTodos(undefined);
        v.model.setAction(undefined);
        v.status = '';
      }
      const name = w?.name ?? ORCHESTRATOR_NAME;
      if (v.name !== name) {
        v.name = name;
        v.model.setName(name);
      }
      v.model.setTeam(missionBadge(w ?? { id, name: ORCHESTRATOR_NAME, color: ORCHESTRATOR_COLOR }, floorWorkers));
    }
  }

  /** The ring's pulse while the Orchestrator waits on you. */
  update(dt: number) {
    if (this.phase !== 'needs_input') return;
    this.pulseT += dt;
    const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.pulseT * 5));
    this.ringMat.emissive.set(phaseColor(this.phase)).multiplyScalar(k);
  }

  private paintRing() {
    const c = phaseColor(this.phase);
    this.ringMat.color.set(c);
    this.ringMat.emissive.set(c).multiplyScalar(this.phase === 'off' ? 0 : 0.7);
  }

  private add(id: string, name: string, color: string, chair: number | undefined): MissionAgentView {
    const model = new Worker(name, color, 0.5);
    const orchestrator = id === ORCHESTRATOR_ID;
    const it: Interactable = orchestrator ? this.orchestratorSpot : { kind: 'bot', x: 0, z: 0, radius: 0.9, agentId: id };
    if (!orchestrator) this.interactables.push(it);
    model.root.userData.interact = it;
    // Its globe, when it browses, floats beside it rather than over the table.
    model.setPropSpot(new THREE.Vector3(orchestrator ? -0.62 : -0.7, 1.1, orchestrator ? 0.2 : 0.5));
    const v: MissionAgentView = { id, model, it, status: '', acked: true, color, name, chair };
    this.views.set(id, v);
    return v;
  }

  private place(v: MissionAgentView, spot: MissionSpot, chair: number | undefined) {
    const orchestrator = v.id === ORCHESTRATOR_ID;
    const root = v.model.root;
    root.position.set(spot.x, orchestrator ? MISSION_HEAD.height : SEATED.y, spot.z);
    root.rotation.y = spot.rotY;
    root.scale.setScalar(orchestrator ? ORCHESTRATOR_SCALE : SEATED.scale);
    v.chair = chair;
    v.it.x = spot.x;
    v.it.z = spot.z;
    this.group.add(root);
  }

  private remove(id: string) {
    const v = this.views.get(id);
    if (!v) return;
    v.model.root.removeFromParent();
    v.model.dispose();
    if (v.it !== this.orchestratorSpot) {
      const i = this.interactables.indexOf(v.it);
      if (i >= 0) this.interactables.splice(i, 1);
    }
    this.views.delete(id);
  }
}
