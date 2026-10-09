import * as THREE from 'three';
import { ELEVATOR, ELEVATOR_FRONT } from '../../shared/layout';
import { nearestWalkable, route, type Pt } from '../../shared/nav';
import type { MedicPose } from './character';

/**
 * Workers shot with the .44 Magnum, or put to sleep by the wand. The server owns their revival
 * deadlines; this class renders the shared downed state and the medic pickup after dismissal.
 *
 * One shot, one scene: the worker tumbles out of its chair onto the floor with a thud, and a blood
 * pool spreads under it while its session keeps running (see shoot). A spell (CasualtyLook) puts
 * it to sleep on a glowing spell circle instead, eyes shut, stars circling. Pressing E nearby
 * stands it back up in its seat with its session untouched, or expiry calls in two
 * paramedics with a stretcher (see confirm): they walk in from the elevator, lower and open the scoop
 * stretcher, support and settle the body, close the bed and lift together, then carry it back to the elevator and fade, and the laptop shuts and
 * shrinks as on a send-home. Every client on the floor sees the same lifecycle.
 *
 * No DOM or WebGL at import time, so tests can load this in Node.
 */

/** Seconds tumbling out of the chair onto the floor. */
export const FALL_TIME = 0.75;
/** Seconds for the blood pool to spread to full size under the body. */
export const BLEED_TIME = 6;
/** Seconds for the spell circle to open to full size: a spell takes hold at once, blood takes its time. */
export const SPELL_TIME = 1.2;
/** How wide the blood pool gets, in meters. */
export const POOL_R = 0.9;
/** Seconds lowering, stabilizing, loading and lifting together. */
export const LOAD_TIME = 4.8;
/** How fast the medics walk the stretcher in and out, in m/s. */
export const MEDIC_PACE = 1.6;
/** Seconds fading away at the elevator with the body. */
export const FADE_TIME = 0.7;
/** Seconds for the team to appear at full size at the elevator. */
const TEAM_IN = 0.65;
/** Seconds for a shut laptop to shrink away. */
const LAPTOP_GONE = 0.3;
/** A worker's feet are this far above its origin. */
const FEET = 0.07;
/** How high the stretcher's bed is. */
const BED_Y = 0.72;
const LOW_BED = 0.16;
const HANDLE_Z = 1.04;
const MEDIC_Z = 1.3;
const LOWER_END = 0.85;
const SUPPORT_END = 1.8;
const SETTLE_END = 2.9;
const LIFT_END = 4.3;
/** How far out of its seat the shot worker lands. */
const TUMBLE = 0.65;

/** Where the medics come from: out of the elevator, on every floor. */
const MEDIC_FROM: Pt = [ELEVATOR.x, ELEVATOR_FRONT + 0.5];

/** Falling, bled out waiting for revival, medics on the way, loading, carrying out, gone. */
export type CasualtyPhase = 'fall' | 'bled' | 'fetch' | 'load' | 'carry' | 'fade';

/**
 * How a downed worker looks: shot with the Magnum (a blood pool, face slack) or hit by the wand
 * (asleep on a glowing spell circle with stars circling over it). The lifecycle is the same.
 */
export type CasualtyLook = 'blood' | 'spell';

/** What a casualty needs of a worker's model (see world/character.ts Worker). */
export interface CasualtyModel {
  readonly root: THREE.Group;
  update(dt: number, t: number): void;
  /** Light out, face slack (or eyes shut, `asleep`), bubble gone. */
  die(asleep?: boolean): void;
  /** Back on its feet: light and bubble as its status says. */
  revive(): void;
  dispose(): void;
}

/** What a casualty needs of a medic (see world/character.ts Person). */
export interface Medic {
  readonly root: THREE.Group;
  update(dt: number, t: number, moving: boolean, airborne: boolean): void;
  dispose(): void;
  /** Optional articulated contact pose, applied after ordinary character animation. */
  medicPose?(pose: MedicPose | null): void;
}

/** What a casualty needs of a laptop (see world/laptop.ts Laptop). */
export interface CasualtyLaptop {
  readonly root: THREE.Object3D;
  /** Shuts the lid; true once it's shut. */
  shut(dt: number): boolean;
  dispose(): void;
}

export interface CasualtyHooks {
  /** A paramedic in whites, by name. */
  spawnMedic(name: string): Medic;
  /** The thud as the body lands (or it dozes off, for a spell), and the siren sting as the medics come in. */
  onLand(at: THREE.Vector3, look: CasualtyLook): void;
  onSiren(at: THREE.Vector3): void;
}

let poolGeo: THREE.CircleGeometry | null = null;
let poolMat: THREE.MeshBasicMaterial | null = null;
let poolDark: THREE.MeshBasicMaterial | null = null;

/** The blood pool: a spreading circle, darker at its heart, with a lobe off to one side. */
function bloodPool(): THREE.Group {
  poolGeo ??= new THREE.CircleGeometry(1, 28);
  poolMat ??= new THREE.MeshBasicMaterial({ color: '#a31621', transparent: true, opacity: 0.88, depthWrite: false });
  poolDark ??= new THREE.MeshBasicMaterial({ color: '#630d14', transparent: true, opacity: 0.92, depthWrite: false });
  const pool = new THREE.Group();
  const main = new THREE.Mesh(poolGeo, poolMat);
  main.rotation.x = -Math.PI / 2;
  pool.add(main);
  const heart = new THREE.Mesh(poolGeo, poolDark);
  heart.rotation.x = -Math.PI / 2;
  heart.position.y = 0.001;
  heart.scale.setScalar(0.55);
  pool.add(heart);
  const lobe = new THREE.Mesh(poolGeo, poolMat);
  lobe.rotation.x = -Math.PI / 2;
  lobe.position.set(0.55, 0.001, 0.35);
  lobe.scale.setScalar(0.55);
  pool.add(lobe);
  pool.scale.setScalar(0.05);
  return pool;
}

let spellGeo: { disc: THREE.CircleGeometry; rim: THREE.RingGeometry; inner: THREE.RingGeometry; rune: THREE.CircleGeometry; star: THREE.OctahedronGeometry } | null = null;
let spellMat: { disc: THREE.MeshBasicMaterial; rim: THREE.MeshBasicMaterial; inner: THREE.MeshBasicMaterial; rune: THREE.MeshBasicMaterial; star: THREE.MeshBasicMaterial } | null = null;
/** How many stars circle over a sleeping worker, and how high (in units of the circle's radius). */
const SPELL_STARS = 4;
const STAR_Y = 0.55;

/**
 * The spell circle: a soft violet glow on the floor in a bright rim, a mint ring of runes inside
 * it, and stars circling over the sleeper. It turns slowly while the spell holds (see step).
 */
function spellCircle(): THREE.Group {
  spellGeo ??= {
    disc: new THREE.CircleGeometry(1, 40),
    rim: new THREE.RingGeometry(0.88, 1, 48),
    inner: new THREE.RingGeometry(0.56, 0.61, 40),
    rune: new THREE.CircleGeometry(0.07, 4),
    star: new THREE.OctahedronGeometry(0.07, 0),
  };
  const glow = (color: string, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  spellMat ??= { disc: glow('#7b2ff7', 0.32), rim: glow('#c77dff', 0.9), inner: glow('#80ffdb', 0.75), rune: glow('#fff3b0', 0.9), star: glow('#ffe680', 1) };
  const g = spellGeo;
  const m = spellMat;
  const circle = new THREE.Group();
  circle.name = 'spell-circle';
  const flat = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    circle.add(mesh);
    return mesh;
  };
  flat(g.disc, m.disc, 0);
  flat(g.rim, m.rim, 0.001);
  flat(g.inner, m.inner, 0.001);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    flat(g.rune, m.rune, 0.002).position.set(Math.cos(a) * 0.74, 0.002, Math.sin(a) * 0.74);
  }
  for (let i = 0; i < SPELL_STARS; i++) {
    const star = new THREE.Mesh(g.star, m.star);
    star.name = 'spell-star';
    const a = (i / SPELL_STARS) * Math.PI * 2;
    star.position.set(Math.cos(a) * 0.4, STAR_Y, Math.sin(a) * 0.4);
    star.userData.phase = a;
    circle.add(star);
  }
  circle.scale.setScalar(0.05);
  return circle;
}

/** A split scoop bed with padded head support and handles the medics can actually hold. */
function stretcher(): { root: THREE.Group; halves: THREE.Group[]; geometries: THREE.BufferGeometry[] } {
  const root = new THREE.Group();
  root.name = 'medic-stretcher';
  const box = new THREE.BoxGeometry(1, 1, 1);
  const pole = new THREE.CylinderGeometry(0.025, 0.025, 2.18, 8).rotateX(Math.PI / 2);
  const steel = new THREE.MeshToonMaterial({ color: '#ced9df' });
  const canvas = new THREE.MeshToonMaterial({ color: '#ed833b' });
  const cushion = new THREE.MeshToonMaterial({ color: '#163b50' });
  const halves = [-1, 1].map((side) => {
    const half = new THREE.Group();
    half.name = side < 0 ? 'stretcher-left' : 'stretcher-right';
    const rail = new THREE.Mesh(pole, steel);
    rail.position.x = side * 0.35;
    half.add(rail);
    const bed = new THREE.Mesh(box, canvas);
    bed.scale.set(0.34, 0.055, 1.65);
    bed.position.x = side * 0.17;
    bed.castShadow = bed.receiveShadow = true;
    half.add(bed);
    const pad = new THREE.Mesh(box, cushion);
    pad.scale.set(0.32, 0.07, 0.3);
    pad.position.set(side * 0.17, 0.055, -0.38);
    pad.receiveShadow = true;
    half.add(pad);
    root.add(half);
    return half;
  });
  root.position.y = BED_Y;
  return { root, halves, geometries: [box, pole] };
}

interface Team {
  group: THREE.Group;
  medics: Medic[];
  bed: ReturnType<typeof stretcher>;
  /** Only private material copies fade; character and worker materials may be shared elsewhere. */
  materials: Map<THREE.Material, THREE.Material>;
  way: Pt[];
  next: number;
  heading: number;
  pickupHeading: number;
  speed: number;
  moving: boolean;
  stride: number;
  left: THREE.Vector3;
  right: THREE.Vector3;
  pose: { left: THREE.Vector3; right: THREE.Vector3; crouch: number; stride: number };
  pickupAt: THREE.Vector3;
  withdrawal: THREE.Vector3;
  bodyFrom: THREE.Vector3;
  bodyRotation: THREE.Quaternion;
  bodyTo: THREE.Vector3;
  bodyTargetRotation: THREE.Quaternion;
  scratch: THREE.Vector3;
  inverse: THREE.Quaternion;
}

interface Casualty {
  model: CasualtyModel;
  look: CasualtyLook;
  /** The seat anchor it fell out of (and goes back to on Revive). */
  seat: THREE.Object3D;
  scale: number;
  phase: CasualtyPhase;
  /** Seconds into the phase. */
  t: number;
  /** 0 → 1 as the pool spreads. */
  bleed: number;
  /** Where it sat, and the way it faced. */
  from: THREE.Vector3;
  yaw: number;
  /** Which way it tips over, and how far. */
  tip: number;
  lean: number;
  /** Which side it sprawls out on. */
  side: number;
  /** Where it lands on the floor. */
  floor: THREE.Vector3;
  pool: THREE.Group;
  laptop: CasualtyLaptop | null;
  /** 0 → 1 as the shut laptop shrinks away. */
  lgone: number;
  team: Team | null;
  /** Confirmed: the model and laptop are this class's to dispose. Before that they're the office's. */
  owned: boolean;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
const smooth = (p: number) => {
  const u = THREE.MathUtils.clamp(p, 0, 1);
  return u * u * (3 - 2 * u);
};
const SUPINE = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

export class Casualties {
  private all = new Map<string, Casualty>();

  constructor(
    private parent: THREE.Object3D,
    /** The top of whatever is underfoot at (x, z) for feet at `y`. */
    private ground: (x: number, z: number, y: number) => number,
    private hooks: CasualtyHooks,
  ) {}

  /** Whether `id` is down on the floor and can still be revived. */
  dying(id: string): boolean {
    const c = this.all.get(id);
    return !!c && (c.phase === 'fall' || c.phase === 'bled');
  }

  /** The closest revivable body within walking reach, on this storey. */
  nearby(at: { x: number; y: number; z: number }, radius = 2.4): string | null {
    let nearest: string | null = null;
    let distance = radius;
    for (const [id, c] of this.all) {
      if (!this.dying(id) || Math.abs(c.floor.y + FEET - at.y) > 1.5) continue;
      const d = Math.hypot(c.floor.x - at.x, c.floor.z - at.z);
      if (d < distance) {
        nearest = id;
        distance = d;
      }
    }
    return nearest;
  }

  /** The phase `id` is in, if it has a scene running. */
  phaseOf(id: string): CasualtyPhase | null {
    return this.all.get(id)?.phase ?? null;
  }

  /** How `id` went down, if it has a scene running. */
  lookOf(id: string): CasualtyLook | null {
    return this.all.get(id)?.look ?? null;
  }

  /**
   * Shoots the worker: it tumbles out of `seat` onto the floor, landing with a thud, and bleeds
   * out under a spreading pool. A `spell` puts it to sleep there instead, on a spreading spell
   * circle. False when it already has a scene running.
   */
  shoot(id: string, model: CasualtyModel, seat: THREE.Object3D, look: CasualtyLook = 'blood'): boolean {
    if (this.all.has(id)) return false;
    // Off the desk first if it was up there dancing: it falls out of its seat.
    model.die(look === 'spell');
    const from = model.root.getWorldPosition(new THREE.Vector3());
    const quat = model.root.getWorldQuaternion(new THREE.Quaternion());
    const yaw = new THREE.Euler().setFromQuaternion(quat, 'YXZ').y;
    const scale = model.root.getWorldScale(new THREE.Vector3()).x;
    const local = model.root.scale.x;
    this.parent.add(model.root);
    model.root.position.copy(from);
    model.root.quaternion.copy(quat);
    model.root.scale.setScalar(scale);
    // Sideways out of the chair, into the open: forward would put it under the desk.
    const side = Math.random() < 0.5 ? -1 : 1;
    const floor = new THREE.Vector3(from.x + Math.cos(yaw) * side * TUMBLE, 0, from.z - Math.sin(yaw) * side * TUMBLE);
    // No collider under the landing spot (or none it can stand on from this height) reads as
    // -Infinity, which would drop the body through the floor: fall back to the seat's own ground.
    let top = this.ground(floor.x, floor.z, from.y);
    if (!Number.isFinite(top)) top = this.ground(from.x, from.z, from.y);
    if (!Number.isFinite(top)) top = from.y + FEET;
    floor.y = top - FEET;
    const pool = look === 'spell' ? spellCircle() : bloodPool();
    // On top of whatever is underfoot, not at the body's origin (feet are FEET above it, and the
    // rugs under the desks stand 0.021 proud of the floorboards).
    pool.position.set(floor.x, floor.y + FEET + 0.03, floor.z);
    pool.rotation.y = Math.random() * Math.PI * 2;
    this.parent.add(pool);
    this.all.set(id, {
      model,
      look,
      seat,
      scale: local,
      phase: 'fall',
      t: 0,
      bleed: 0,
      from,
      yaw,
      tip: (Math.random() < 0.5 ? -1 : 1) * (1.35 + Math.random() * 0.25),
      lean: (Math.random() - 0.5) * 0.5,
      side,
      floor,
      pool,
      laptop: null,
      lgone: 0,
      team: null,
      owned: false,
    });
    return true;
  }

  /**
   * Revive stands the worker back up in its seat with its session untouched, blood gone. False
   * when there's nothing (left) to revive.
   */
  revive(id: string): boolean {
    const c = this.all.get(id);
    if (!c || (c.phase !== 'fall' && c.phase !== 'bled')) return false;
    this.reseat(c);
    this.dropPool(c);
    this.all.delete(id);
    return true;
  }

  /**
   * Confirms the kill: two paramedics walk in from the elevator with a stretcher, load the body
   * with a supported scoop pickup, carry it back to the elevator and fade. The laptop
   * shuts and shrinks as on a send-home. False when there's no body to collect.
   */
  confirm(id: string, laptop: CasualtyLaptop): boolean {
    const c = this.all.get(id);
    if (!c || (c.phase !== 'fall' && c.phase !== 'bled')) return false;
    if (c.phase === 'fall') this.land(c);
    c.owned = true;
    c.laptop = laptop;
    c.phase = 'fetch';
    c.t = 0;
    const group = new THREE.Group();
    group.name = 'medic-team';
    const medics = [this.hooks.spawnMedic('🚑 Medic'), this.hooks.spawnMedic('🚑 Medic')];
    const bed = stretcher();
    const left = new THREE.Vector3(-0.35, BED_Y, 0.26);
    const right = new THREE.Vector3(0.35, BED_Y, 0.26);
    const pose = { left, right, crouch: 0, stride: 0 };
    medics.forEach((medic, i) => {
      medic.root.position.set(0, 0, i ? -MEDIC_Z : MEDIC_Z);
      medic.root.rotation.y = i ? 0 : Math.PI;
      medic.medicPose?.(pose);
      group.add(medic.root);
    });
    group.add(bed.root);
    this.parent.add(group);
    // The worker origin is at its feet. Approach the torso center, not the chair-side origin.
    const torso = c.model.root.localToWorld(new THREE.Vector3(0, 0.55, 0));
    const body: Pt = [torso.x, torso.z];
    const way = route(MEDIC_FROM, nearestWalkable(body));
    way.push(body);
    group.position.set(way[0][0], this.ground(way[0][0], way[0][1], c.floor.y) - FEET, way[0][1]);
    const heading = way.length > 1 ? Math.atan2(way[1][0] - way[0][0], way[1][1] - way[0][1]) : c.yaw;
    group.rotation.y = heading;
    const team: Team = {
      group,
      medics,
      bed,
      materials: new Map(),
      way,
      next: 1,
      heading,
      pickupHeading: Math.atan2(c.floor.x - torso.x, c.floor.z - torso.z),
      speed: 0,
      moving: false,
      stride: 0,
      left,
      right,
      pose,
      pickupAt: new THREE.Vector3(),
      withdrawal: new THREE.Vector3(c.floor.x - c.from.x, 0, c.floor.z - c.from.z).normalize().multiplyScalar(0.55),
      bodyFrom: new THREE.Vector3(),
      bodyRotation: new THREE.Quaternion(),
      bodyTo: new THREE.Vector3(),
      bodyTargetRotation: new THREE.Quaternion(),
      scratch: new THREE.Vector3(),
      inverse: new THREE.Quaternion(),
    };
    c.team = team;
    this.copyMaterials(team, group);
    this.opacity(team, 0);
    c.model.root.traverse((object) => {
      if ((object as THREE.Sprite).isSprite) object.visible = false;
    });
    this.hooks.onSiren(group.position);
    return true;
  }

  /** Off to another floor, or gone: every scene ends, models back in their seats unless collected. */
  clear() {
    for (const c of this.all.values()) {
      if (c.owned) {
        this.dropModel(c);
      } else this.reseat(c);
      this.dropTeam(c);
      this.dropPool(c);
      this.dropLaptop(c);
    }
    this.all.clear();
  }

  /** Where the medic teams are, for the doors to open. */
  positions(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const c of this.all.values()) if (c.team) out.push(c.team.group.position);
    return out;
  }

  update(dt: number, t: number) {
    for (const [id, c] of this.all) {
      this.step(c, dt);
      c.model.update(dt, t);
      if (c.team) this.poseTeam(c, dt, t);
      if (c.laptop && !this.closeLaptop(c, dt)) c.laptop = null;
      if (c.phase === 'fade' && c.t >= FADE_TIME) {
        this.dropTeam(c);
        this.dropPool(c);
        this.dropLaptop(c);
        this.dropModel(c);
        this.all.delete(id);
      }
    }
  }

  private step(c: Casualty, dt: number) {
    c.t += dt;
    const { root } = c.model;
    switch (c.phase) {
      case 'fall': {
        const p = Math.min(1, c.t / FALL_TIME);
        const e = easeOut(p);
        root.position.set(THREE.MathUtils.lerp(c.from.x, c.floor.x, e), THREE.MathUtils.lerp(c.from.y, c.floor.y, e) + Math.sin(p * Math.PI) * 0.3, THREE.MathUtils.lerp(c.from.z, c.floor.z, e));
        root.rotation.set(c.tip * e, c.yaw + (c.lean + c.side * 0.9) * e, (c.lean * 0.6 + c.side * 0.35) * e);
        if (p >= 1) this.land(c);
        return;
      }
      case 'bled':
        c.bleed = Math.min(1, c.bleed + dt / (c.look === 'spell' ? SPELL_TIME : BLEED_TIME));
        c.pool.scale.setScalar(Math.max(0.05, POOL_R * easeOut(c.bleed)));
        if (c.look === 'spell') this.twinkle(c, dt);
        return;
      case 'fetch': {
        const team = c.team!;
        this.opacity(team, smooth(c.t / TEAM_IN));
        if (this.walk(team, dt, team.pickupHeading)) {
          c.phase = 'load';
          c.t = 0;
          team.pickupAt.copy(team.group.position);
          team.bodyFrom.copy(root.position);
          team.bodyRotation.copy(root.quaternion);
          team.bodyTargetRotation.copy(team.group.quaternion).multiply(SUPINE);
          team.scratch.set(0, LOW_BED + 0.31 * root.scale.x, 0.58 * root.scale.x);
          team.group.localToWorld(team.scratch);
          team.bodyTo.copy(team.scratch);
          team.moving = false;
        }
        return;
      }
      case 'load': {
        const team = c.team!;
        const lower = smooth(c.t / LOWER_END);
        const settle = smooth((c.t - LOWER_END) / (SETTLE_END - LOWER_END));
        const lift = smooth((c.t - SETTLE_END) / (LIFT_END - SETTLE_END));
        // Split the scoop around the body while lowering. Support it before closing the bed.
        const open = lower * (1 - smooth((c.t - SUPPORT_END) / (SETTLE_END - SUPPORT_END)));
        team.bed.halves[0].position.x = -open * 0.2;
        team.bed.halves[1].position.x = open * 0.2;
        team.bed.root.position.y = THREE.MathUtils.lerp(BED_Y, LOW_BED, lower) + (BED_Y - LOW_BED) * lift;
        if (root.parent !== team.group) {
          root.position.lerpVectors(team.bodyFrom, team.bodyTo, settle);
          root.position.y += (BED_Y - LOW_BED) * lift;
          root.quaternion.slerpQuaternions(team.bodyRotation, team.bodyTargetRotation, settle);
          if (settle >= 1) {
            // Keep the body fixed to its support during the shared rise and withdrawal.
            team.group.attach(root);
            this.copyMaterials(team, root);
          }
        }
        if (root.parent === team.group) root.position.y = team.bed.root.position.y + 0.31 * root.scale.x;
        const withdraw = smooth((c.t - LIFT_END) / (LOAD_TIME - LIFT_END));
        const x = team.pickupAt.x + team.withdrawal.x * withdraw;
        const z = team.pickupAt.z + team.withdrawal.z * withdraw;
        const move = Math.hypot(x - team.group.position.x, z - team.group.position.z);
        team.group.position.x = x;
        team.group.position.z = z;
        team.moving = move > 1e-5;
        team.stride += move * 7;
        c.pool.scale.setScalar(Math.max(0.001, Math.max(0.05, POOL_R * easeOut(c.bleed)) * (1 - settle)));
        if (c.t < LOAD_TIME) return;
        const here: Pt = [team.group.position.x, team.group.position.z];
        team.way = [here, ...route(nearestWalkable(here), MEDIC_FROM)];
        team.next = 1;
        team.speed = 0;
        c.phase = 'carry';
        c.t = 0;
        return;
      }
      case 'carry':
        if (this.walk(c.team!, dt)) {
          c.phase = 'fade';
          c.t = 0;
        }
        return;
      case 'fade':
        this.opacity(c.team!, 1 - smooth(c.t / FADE_TIME));
        return;
    }
  }

  /** Down: it lands with a thud and starts bleeding out. */
  private land(c: Casualty) {
    c.model.root.position.copy(c.floor);
    c.model.root.rotation.set(c.tip, c.yaw + c.lean + c.side * 0.9, c.lean * 0.6 + c.side * 0.35);
    c.phase = 'bled';
    c.t = 0;
    this.hooks.onLand(c.floor, c.look);
  }

  /** The spell circle turning slowly, its stars bobbing as they circle. */
  private twinkle(c: Casualty, dt: number) {
    c.pool.rotation.y += dt * 0.7;
    for (const star of c.pool.children) {
      if (star.name !== 'spell-star') continue;
      const phase = star.userData.phase as number;
      star.position.y = STAR_Y + Math.sin(c.t * 2.4 + phase) * 0.06;
      star.rotation.y += dt * 3;
    }
  }

  /** Slows for corners and arrival, turns before stepping, and accelerates without a lurch. */
  private walk(team: Team, dt: number, arrivalHeading?: number): boolean {
    const pos = team.group.position;
    while (team.next < team.way.length && Math.hypot(team.way[team.next][0] - pos.x, team.way[team.next][1] - pos.z) < 0.015) team.next++;
    if (team.next >= team.way.length) {
      team.speed = 0;
      team.moving = false;
      if (arrivalHeading === undefined) return true;
      const turn = wrap(arrivalHeading - team.group.rotation.y);
      team.group.rotation.y += THREE.MathUtils.clamp(turn, -dt * 1.6, dt * 1.6);
      return Math.abs(turn) < 0.01;
    }
    const [x, z] = team.way[team.next];
    const dx = x - pos.x;
    const dz = z - pos.z;
    const distance = Math.hypot(dx, dz);
    team.heading = Math.atan2(dx, dz);
    const turn = wrap(team.heading - team.group.rotation.y);
    team.group.rotation.y += THREE.MathUtils.clamp(turn, -dt * 1.6, dt * 1.6);
    const target = MEDIC_PACE * Math.max(0, 1 - Math.abs(turn) / 1.2) * Math.min(1, Math.sqrt(distance / 0.7));
    team.speed += THREE.MathUtils.clamp(target - team.speed, -dt * 3.5, dt * 2.4);
    const move = Math.min(distance, team.speed * dt);
    pos.x += (dx / distance) * move;
    pos.z += (dz / distance) * move;
    const g = this.ground(pos.x, pos.z, pos.y + FEET) - FEET;
    pos.y += (g - pos.y) * Math.min(1, dt * 14);
    team.moving = move > 1e-5;
    team.stride += move * 7;
    return false;
  }

  /** Hands change between handles and support points; the endpoint meshes follow those targets. */
  private poseTeam(c: Casualty, dt: number, t: number) {
    const team = c.team!;
    const loading = c.phase === 'load';
    const lower = loading ? smooth(c.t / LOWER_END) : 0;
    const lift = loading ? smooth((c.t - SETTLE_END) / (LIFT_END - SETTLE_END)) : 1;
    const support = loading ? smooth((c.t - LOWER_END * 0.65) / 0.45) * (1 - smooth((c.t - SUPPORT_END) / (SETTLE_END - SUPPORT_END))) : 0;
    const crouch = lower * (1 - lift);
    // The same tiny vertical movement carries stretcher, body and both hands; feet remain on the floor.
    const bob = team.moving ? Math.sin(team.stride * 2) * 0.012 : 0;
    if (!loading || c.t > LIFT_END) team.bed.root.position.y = BED_Y + bob;
    if (c.model.root.parent === team.group) c.model.root.position.y = team.bed.root.position.y + 0.31 * c.model.root.scale.x;
    team.group.updateWorldMatrix(true, false);
    c.model.root.updateWorldMatrix(true, false);
    for (let i = 0; i < team.medics.length; i++) {
      const medic = team.medics[i];
      const end = i ? -1 : 1;
      medic.root.position.z = end * (MEDIC_Z - support * 0.27);
      medic.root.updateWorldMatrix(true, false);
      medic.update(dt, t, team.moving, false);
      team.inverse.copy(medic.root.quaternion).invert();
      for (let hand = 0; hand < 2; hand++) {
        const side = hand ? 1 : -1;
        const target = hand ? team.right : team.left;
        // Handles are expressed in the team frame, support points in the worker's own frame.
        target.set(side * (0.35 + Math.abs(team.bed.halves[0].position.x)), team.bed.root.position.y, end * HANDLE_Z);
        if (support) {
          team.scratch.set(0, i ? 1.02 : 0.12, 0);
          c.model.root.localToWorld(team.scratch);
          team.scratch.y = Math.max(team.scratch.y - 0.13, c.floor.y + FEET + 0.09);
          team.group.worldToLocal(team.scratch);
          team.scratch.x += side * 0.23;
          target.lerp(team.scratch, support);
        }
        target.sub(medic.root.position).applyQuaternion(team.inverse);
      }
      // Facing inward means the front medic walks backwards, maintaining sight of the patient.
      if (!i) {
        team.scratch.copy(team.left);
        team.left.copy(team.right);
        team.right.copy(team.scratch);
      }
      team.pose.crouch = crouch;
      team.pose.stride = team.moving ? team.stride : 0;
      medic.medicPose?.(team.pose);
    }
  }

  private copyMaterials(team: Team, root: THREE.Object3D) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const clone = (original: THREE.Material) => {
        let material = team.materials.get(original);
        if (!material) {
          material = original.clone();
          team.materials.set(original, material);
        }
        return material;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
    });
  }

  private opacity(team: Team, value: number) {
    for (const [original, material] of team.materials) {
      material.opacity = original.opacity * value;
      const transparent = original.transparent || value < 1;
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
      }
    }
  }

  /** Shuts the laptop and shrinks it away; false once it's gone. */
  private closeLaptop(c: Casualty, dt: number): boolean {
    const laptop = c.laptop!;
    if (!laptop.shut(dt)) return true;
    c.lgone = Math.min(1, c.lgone + dt / LAPTOP_GONE);
    laptop.root.scale.setScalar(Math.max(0.001, 1 - c.lgone * c.lgone));
    if (c.lgone < 1) return true;
    this.dropLaptop(c);
    c.laptop = null;
    return false;
  }

  /** Back in its seat at once, as if nothing happened: its session never stopped. */
  private reseat(c: Casualty) {
    c.seat.add(c.model.root);
    c.model.root.position.set(0, 0, 0);
    c.model.root.rotation.set(0, 0, 0);
    c.model.root.scale.setScalar(c.scale);
    c.model.revive();
  }

  private dropTeam(c: Casualty) {
    const team = c.team;
    if (!team) return;
    c.team = null;
    team.group.removeFromParent();
    // Medic helpers free their own geometry. Keep the worker's geometry out of team cleanup.
    const geometry = new Set(team.bed.geometries);
    for (const medic of team.medics) {
      medic.medicPose?.(null);
      medic.dispose();
      medic.root.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) geometry.add((object as THREE.Mesh).geometry);
      });
    }
    for (const item of geometry) item.dispose();
    for (const material of team.materials.values()) material.dispose();
    // Stretcher materials were created for this team, unlike shared character materials.
    const bedMaterials = new Set<THREE.Material>();
    team.bed.root.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (material && !Array.isArray(material)) bedMaterials.add(material);
    });
    for (const [original, material] of team.materials) if (bedMaterials.has(material)) original.dispose();
  }

  private dropModel(c: Casualty) {
    c.model.root.removeFromParent();
    const geometry = new Set<THREE.BufferGeometry>();
    c.model.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) geometry.add((object as THREE.Mesh).geometry);
    });
    c.model.dispose();
    for (const item of geometry) item.dispose();
  }

  private dropPool(c: Casualty) {
    c.pool.removeFromParent();
  }

  private dropLaptop(c: Casualty) {
    if (!c.laptop) return;
    c.laptop.root.removeFromParent();
    c.laptop.dispose();
    c.laptop = null;
  }
}
