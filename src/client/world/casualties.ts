import * as THREE from 'three';
import { ELEVATOR, ELEVATOR_FRONT } from '../../shared/layout';
import type { Worker } from './character';
import type { Laptop } from './laptop';
import type { DeskView } from './office';
import { mesh, toon } from './toon';

const FEET = 0.07;
const FALL_SECONDS = 0.72;
const REVIVE_SECONDS = 0.72;
const LOAD_SECONDS = 1.5;
const FADE_SECONDS = 0.6;
const CREW_PACE = 2.7;

export type CasualtyPhase = 'fall' | 'preview' | 'revive' | 'approach' | 'load' | 'carry' | 'fade' | 'done';
const DURATION: Partial<Record<CasualtyPhase, number>> = { fall: FALL_SECONDS, revive: REVIVE_SECONDS, load: LOAD_SECONDS, fade: FADE_SECONDS };

/** A small deterministic clock used by the visual sequence and its Node-loadable timeline tests. */
export class CasualtyClock {
  elapsed = 0;

  constructor(public phase: CasualtyPhase) {}

  enter(phase: CasualtyPhase) {
    this.phase = phase;
    this.elapsed = 0;
  }

  tick(dt: number): { progress: number; complete: boolean } {
    this.elapsed += Math.max(0, dt);
    const duration = DURATION[this.phase];
    if (duration === undefined) return { progress: 0, complete: false };
    const progress = THREE.MathUtils.clamp(this.elapsed / duration, 0, 1);
    return { progress, complete: progress >= 1 };
  }
}

interface Incident {
  id: string;
  model: Worker;
  deskId: string;
  parent: THREE.Object3D;
  localPosition: THREE.Vector3;
  localQuaternion: THREE.Quaternion;
  localScale: THREE.Vector3;
  start: THREE.Vector3;
  startRotation: THREE.Quaternion;
  floorY: number;
  corpse: THREE.Vector3;
  deadRotation: THREE.Quaternion;
  motionStart: THREE.Vector3;
  motionRotation: THREE.Quaternion;
  clock: CasualtyClock;
  pool: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  crew: THREE.Group | null;
  stretcher: THREE.Group | null;
  laptop: Laptop | null;
  laptopGone: number;
}

export interface CasualtySounds {
  thud(at: THREE.Vector3): void;
  medic(at: THREE.Vector3): void;
}

/**
 * Local-only visual preview for a shot worker. Confirmed removals dispatch medics from the elevator;
 * a revive restores the original seat parent and exact local transform without touching worker state.
 */
export class Casualties {
  private incidents = new Map<string, Incident>();

  constructor(
    private parent: THREE.Object3D,
    /** Top of the floor, desk, or prop beneath a point. */
    private ground: (x: number, z: number, y: number) => number,
    private onRevived: (deskId: string) => void,
    private sounds: CasualtySounds,
  ) {}

  /** Starts a local fall. Returns false when this worker is already being handled or lacks a parent. */
  preview(id: string, model: Worker, desk: DeskView): boolean {
    if (this.incidents.size > 0 || this.incidents.has(id) || !model.root.parent) return false;
    const root = model.root;
    root.updateWorldMatrix(true, false);
    const start = root.getWorldPosition(new THREE.Vector3());
    const startRotation = root.getWorldQuaternion(new THREE.Quaternion());
    const worldScale = root.getWorldScale(new THREE.Vector3());
    const parent = root.parent;
    if (!parent) return false;
    const localPosition = root.position.clone();
    const localQuaternion = root.quaternion.clone();
    const localScale = root.scale.clone();
    this.parent.attach(root);
    root.position.copy(start);
    root.quaternion.copy(startRotation);
    root.scale.copy(worldScale);

    const floorY = this.ground(start.x, start.z, start.y) - FEET;
    const corpse = new THREE.Vector3(start.x + 0.18, floorY, start.z + 0.08);
    const topple = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.25, 0, -0.9));
    const deadRotation = startRotation.clone().multiply(topple);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(0.54, 32), new THREE.MeshBasicMaterial({ color: '#7c1017', transparent: true, opacity: 0.78, depthWrite: false, side: THREE.DoubleSide }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(corpse.x, floorY + 0.014, corpse.z);
    pool.scale.set(0.01, 0.01, 1);
    this.parent.add(pool);
    model.stopDancing();
    model.walking = false;
    model.die();
    this.incidents.set(id, {
      id,
      model,
      deskId: desk.def.id,
      parent,
      localPosition,
      localQuaternion,
      localScale,
      start,
      startRotation,
      floorY,
      corpse,
      deadRotation,
      motionStart: start.clone(),
      motionRotation: startRotation.clone(),
      clock: new CasualtyClock('fall'),
      pool,
      crew: null,
      stretcher: null,
      laptop: null,
      laptopGone: 0,
    });
    return true;
  }

  /** Whether this id has any active preview or confirmed cleanup sequence. */
  has(id: string): boolean {
    return this.incidents.has(id);
  }

  /** The spec allows one body on this client's floor at a time. */
  busy(): boolean {
    return this.incidents.size > 0;
  }

  /** Keep a cleaned-up worker's desk reserved until the stretcher leaves. */
  seated(deskId: string): boolean {
    for (const incident of this.incidents.values()) if (incident.deskId === deskId) return true;
    return false;
  }

  /** Escape and the Revive button both begin the same stand-back-up transition. */
  revive(id: string): boolean {
    const incident = this.incidents.get(id);
    if (!incident || !['fall', 'preview'].includes(incident.clock.phase)) return false;
    incident.motionStart.copy(incident.model.root.position);
    incident.motionRotation.copy(incident.model.root.quaternion);
    incident.clock.enter('revive');
    return true;
  }

  /** Cancels an unconfirmed local preview when a worker disappears or the connection/floor changes. */
  cancel(id: string): boolean {
    const incident = this.incidents.get(id);
    if (!incident || !['fall', 'preview', 'revive'].includes(incident.clock.phase)) return false;
    this.restore(incident);
    this.incidents.delete(id);
    return true;
  }

  /** Starts medics only after the server's existing worker.remove arrives for a confirmed cleanup. */
  confirmedRemoval(id: string, laptop: Laptop): boolean {
    const incident = this.incidents.get(id);
    if (!incident || !['fall', 'preview'].includes(incident.clock.phase)) return false;
    incident.laptop = laptop;
    incident.crew = new THREE.Group();
    incident.stretcher = buildStretcher();
    incident.crew.add(incident.stretcher);
    const medics = [buildMedic(), buildMedic()];
    medics[0].position.x = -0.55;
    medics[1].position.x = 0.55;
    medics.forEach((m) => incident.crew!.add(m));
    const ex = ELEVATOR.x;
    const ez = ELEVATOR_FRONT + 0.35;
    incident.crew.position.set(ex, this.ground(ex, ez, incident.corpse.y) - FEET, ez);
    this.parent.add(incident.crew);
    incident.clock.enter('approach');
    this.sounds.medic(incident.corpse);
    return true;
  }

  /** Door animation can account for the fallen body and for the responding crew. */
  positions(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const incident of this.incidents.values()) {
      if (incident.clock.phase === 'fall' || incident.clock.phase === 'preview' || incident.clock.phase === 'revive') out.push(incident.model.root.position);
      if (incident.crew) out.push(incident.crew.position);
    }
    return out;
  }

  update(dt: number) {
    for (const [id, incident] of this.incidents) {
      const { model, pool, clock } = incident;
      if (['approach', 'load', 'carry', 'fade'].includes(clock.phase)) model.update(dt, 0);
      if (incident.laptop) {
        const shut = incident.laptop.shut(dt);
        if (shut) {
          incident.laptopGone = Math.min(1, incident.laptopGone + dt / 0.3);
          incident.laptop.root.scale.setScalar(Math.max(0.001, 1 - incident.laptopGone ** 2));
          if (incident.laptopGone >= 1) {
            incident.laptop.root.removeFromParent();
            incident.laptop.dispose();
            incident.laptop = null;
          }
        }
      }
      const { progress, complete } = clock.tick(dt);
      switch (clock.phase) {
        case 'fall': {
          const p = smooth(progress);
          model.root.position.lerpVectors(incident.start, incident.corpse, p);
          model.root.quaternion.slerpQuaternions(incident.startRotation, incident.deadRotation, p);
          pool.scale.setScalar(0.06 + p * 0.94);
          if (complete) {
            clock.enter('preview');
            this.sounds.thud(incident.corpse);
          }
          break;
        }
        case 'preview':
          pool.scale.setScalar(1);
          break;
        case 'revive': {
          const p = smooth(progress);
          model.root.position.lerpVectors(incident.motionStart, incident.start, p);
          model.root.quaternion.slerpQuaternions(incident.motionRotation, incident.startRotation, p);
          pool.scale.setScalar(Math.max(0.001, 1 - p));
          pool.material.opacity = 0.78 * (1 - p);
          if (complete) {
            const deskId = incident.deskId;
            this.restore(incident);
            this.incidents.delete(id);
            this.onRevived(deskId);
          }
          break;
        }
        case 'approach': {
          if (incident.crew && moveToward(incident.crew.position, incident.corpse, CREW_PACE * dt)) clock.enter('load');
          break;
        }
        case 'load': {
          const p = smooth(progress);
          const carry = incident.crew!.position.clone();
          carry.y += 0.39;
          model.root.position.lerpVectors(incident.corpse, carry, p);
          model.root.quaternion.slerpQuaternions(incident.deadRotation, incident.deadRotation, p);
          pool.scale.setScalar(Math.max(0.001, 1 - p));
          pool.material.opacity = 0.78 * (1 - p);
          if (complete) clock.enter('carry');
          break;
        }
        case 'carry': {
          const ex = ELEVATOR.x;
          const ez = ELEVATOR_FRONT + 0.35;
          const target = new THREE.Vector3(ex, this.ground(ex, ez, incident.corpse.y) - FEET, ez);
          if (incident.crew && moveToward(incident.crew.position, target, CREW_PACE * dt)) clock.enter('fade');
          if (incident.crew) {
            model.root.position.copy(incident.crew.position).y += 0.39;
            model.root.quaternion.copy(incident.deadRotation);
          }
          break;
        }
        case 'fade': {
          const scale = Math.max(0.001, 1 - progress * progress);
          model.root.scale.setScalar(scale);
          if (incident.crew) incident.crew.scale.setScalar(scale);
          if (complete) {
            incident.clock.enter('done');
            const deskId = incident.deskId;
            this.drop(incident);
            this.incidents.delete(id);
            this.onRevived(deskId);
          }
          break;
        }
        case 'done':
          this.drop(incident);
          this.incidents.delete(id);
          break;
      }
    }
  }

  /** Clears old-floor visuals; unconfirmed victims are restored for normal store reconciliation. */
  clear() {
    for (const [id, incident] of this.incidents) {
      if (['fall', 'preview', 'revive'].includes(incident.clock.phase)) this.restore(incident);
      else this.drop(incident);
      this.incidents.delete(id);
    }
  }

  private restore(incident: Incident) {
    const root = incident.model.root;
    root.removeFromParent();
    incident.parent.add(root);
    root.position.copy(incident.localPosition);
    root.quaternion.copy(incident.localQuaternion);
    root.scale.copy(incident.localScale);
    incident.model.revive();
    incident.pool.removeFromParent();
    incident.pool.geometry.dispose();
    incident.pool.material.dispose();
    if (incident.crew) disposeGroup(incident.crew);
  }

  private drop(incident: Incident) {
    incident.model.root.removeFromParent();
    incident.model.dispose();
    if (incident.laptop) {
      incident.laptop.root.removeFromParent();
      incident.laptop.dispose();
    }
    incident.pool.removeFromParent();
    incident.pool.geometry.dispose();
    incident.pool.material.dispose();
    if (incident.crew) disposeGroup(incident.crew);
  }
}

function buildMedic(): THREE.Group {
  const group = new THREE.Group();
  const uniform = toon('#f4f7fb');
  const trim = toon('#cc2739');
  const skin = toon('#efc5a5');
  group.add(mesh(new THREE.CapsuleGeometry(0.13, 0.27, 4, 8), uniform, 0, 0.62, 0));
  group.add(mesh(new THREE.SphereGeometry(0.14, 10, 8), skin, 0, 0.98, 0.015));
  group.add(mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.07, 10), uniform, 0, 1.12, 0));
  group.add(mesh(new THREE.BoxGeometry(0.055, 0.12, 0.018), trim, 0, 0.65, 0.126, false));
  for (const x of [-0.105, 0.105]) {
    const arm = mesh(new THREE.CapsuleGeometry(0.045, 0.2, 4, 7), uniform, x * 1.4, 0.59, 0.04);
    arm.rotation.z = x < 0 ? -0.3 : 0.3;
    group.add(arm);
    group.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.19, 8), toon('#243044'), x, 0.27, 0));
  }
  return group;
}

function buildStretcher(): THREE.Group {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#b8c2cc', metalness: 0.7, roughness: 0.35 });
  const mattress = toon('#e9eef3');
  group.add(mesh(new THREE.BoxGeometry(1.1, 0.09, 0.42), mattress, 0, 0.35, 0));
  group.add(mesh(new THREE.BoxGeometry(1.18, 0.035, 0.04), metal, 0, 0.41, 0.2, false));
  group.add(mesh(new THREE.BoxGeometry(1.18, 0.035, 0.04), metal, 0, 0.41, -0.2, false));
  for (const x of [-0.42, 0.42]) {
    group.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.36, 8), metal, x, 0.17, 0));
    for (const z of [-0.16, 0.16]) {
      const wheel = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.045, 10), toon('#29313d'), x, 0.06, z, false);
      wheel.rotation.z = Math.PI / 2;
      group.add(wheel);
    }
  }
  return group;
}

function disposeGroup(group: THREE.Group) {
  group.removeFromParent();
  group.traverse((o) => {
    const object = o as THREE.Mesh;
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((m) => m.dispose());
    else if (object.material && object.material.type !== 'MeshToonMaterial') object.material.dispose();
  });
}

function moveToward(from: THREE.Vector3, to: THREE.Vector3, distance: number): boolean {
  const delta = to.clone().sub(from);
  const length = delta.length();
  if (length <= distance || length < 0.01) {
    from.copy(to);
    return true;
  }
  from.addScaledVector(delta, distance / length);
  return false;
}

function smooth(p: number): number {
  return p * p * (3 - 2 * p);
}
