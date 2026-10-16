import * as THREE from 'three';
import { WALL_HEIGHT } from '../../shared/layout';

/**
 * The server owns revival deadlines. This scene renders the fall and downed state, then a
 * white-gold beam lifts a dismissed worker straight through the ceiling. The laptop shuts and
 * shrinks as on a send-home. No DOM or WebGL at import time, so tests can load this in Node.
 */

/** Seconds tumbling out of the chair onto the floor. */
export const FALL_TIME = 0.75;
/** Seconds for the blood pool to spread to full size under the body. */
export const BLEED_TIME = 6;
/** Seconds for the spell circle to open to full size: a spell takes hold at once, blood takes its time. */
export const SPELL_TIME = 1.2;
/** How wide the blood pool gets, in meters. */
export const POOL_R = 0.9;
/** Seconds for the heavenly beam to appear before the body rises. */
export const BEAM_TIME = 0.8;
/** Seconds floating straight up through the ceiling. */
export const ASCEND_TIME = 3.6;
/** Seconds fading the empty beam after the worker has left. */
export const FADE_TIME = 0.7;
/** Rise far enough that the entire body clears the ceiling, including on the loft. */
export const ASCEND_HEIGHT = WALL_HEIGHT + 2;
/** Seconds for a shut laptop to shrink away. */
const LAPTOP_GONE = 0.3;
/** A worker's feet are this far above its origin. */
const FEET = 0.07;
/** How far out of its seat the shot worker lands. */
const TUMBLE = 0.65;

export type CasualtyPhase = 'fall' | 'bled' | 'beam' | 'ascend' | 'fade';

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

/** What a casualty needs of a laptop (see world/laptop.ts Laptop). */
export interface CasualtyLaptop {
  readonly root: THREE.Object3D;
  /** Shuts the lid; true once it's shut. */
  shut(dt: number): boolean;
  dispose(): void;
}

export interface CasualtyHooks {
  /** The thud as the body lands, or it dozes off for a spell. */
  onLand(at: THREE.Vector3, look: CasualtyLook): void;
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
 * The spell circle, the droid wand's colors: a dim orange glow on the floor in a bright orange
 * rim, a white hairline ring with eight orange marks round it, and white sparks circling over the
 * sleeper. It turns slowly while the spell holds (see step).
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
  spellMat ??= { disc: glow('#ee6018', 0.22), rim: glow('#ff8a4a', 0.9), inner: glow('#eeeeee', 0.7), rune: glow('#ee6018', 0.95), star: glow('#fff4ea', 1) };
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

/** A soft white-gold column and a pool of light, with private resources for each ascent. */
function heavenlyBeam(height: number) {
  const root = new THREE.Group();
  root.name = 'heavenly-beam';
  const materials: THREE.MeshBasicMaterial[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const add = (geometry: THREE.BufferGeometry, color: string, opacity: number, name: string) => {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    material.userData.opacity = opacity;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    root.add(mesh);
    materials.push(material);
    geometries.push(geometry);
    return mesh;
  };
  add(new THREE.CylinderGeometry(0.65, 1.35, height, 40, 1, true), '#ffe6ad', 0.14, 'beam-column').position.y = height / 2;
  add(new THREE.CylinderGeometry(0.28, 0.95, height, 32, 1, true), '#fff9e8', 0.18, 'beam-core').position.y = height / 2;
  const pool = add(new THREE.CircleGeometry(1.35, 40), '#fff2cc', 0.22, 'beam-pool');
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.005;
  const rim = add(new THREE.RingGeometry(1.28, 1.35, 40), '#ffe6ad', 0.5, 'beam-rim');
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.006;
  const light = new THREE.PointLight('#fff2cc', 0, 4, 2);
  light.position.y = 1.2;
  root.add(light);
  return { root, materials, geometries, light };
}

/**
 * Blood, the spell circle and a heavenly beam, for shader warmup. The beam's light is left out: the
 * warmup adds its own lights so it can choose the count, and a real ascent adds the beam's later.
 */
export function casualtyMarkers(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'casualty-markers';
  group.add(bloodPool(), spellCircle());
  const beam = heavenlyBeam(4);
  beam.light.removeFromParent();
  group.add(beam.root);
  return group;
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
  /** Where its origin lands, lifted so no part of it sinks into the floor. */
  floor: THREE.Vector3;
  /** The top of whatever is underfoot where it lands: the pool and beam sit on it. */
  ground: number;
  /** Its origin's height once eased face-up for the beam, again clear of the floor. */
  supine: number;
  pool: THREE.Group;
  laptop: CasualtyLaptop | null;
  /** 0 → 1 as the shut laptop shrinks away. */
  lgone: number;
  beam: ReturnType<typeof heavenlyBeam> | null;
  /** The fallen pose, eased face-up as the beam appears. */
  rotation: THREE.Quaternion;
  /** Confirmed: the model and laptop are this class's to dispose. Before that they're the office's. */
  owned: boolean;
}

const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
const smooth = (p: number) => {
  const u = THREE.MathUtils.clamp(p, 0, 1);
  return u * u * (3 - 2 * u);
};
/**
 * The fallen pose turns about the body's own axes: yaw, then tip over forward or back, then roll
 * onto a shoulder. Tipping about the world's x after the yaw instead rolls a sideways-facing body
 * head-first into the floor.
 */
const FALLEN = 'YXZ';
const SUPINE = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const vertex = new THREE.Vector3();

/**
 * How far below its origin the lowest visible vertex of `root` sits when turned to `pose`, or
 * null when it has no mesh. A worker lies on its side or back, so its round body reaches well
 * below its feet, and how far depends on the pose it was caught in when it went down.
 */
function reach(root: THREE.Object3D, pose: THREE.Quaternion): number | null {
  const kept = root.quaternion.clone();
  root.quaternion.copy(pose);
  root.updateMatrixWorld(true);
  const origin = root.matrixWorld.elements[13];
  let low = Infinity;
  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    for (let i = 0; i < position.count; i++) low = Math.min(low, vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).y);
  });
  root.quaternion.copy(kept);
  root.updateMatrixWorld(true);
  return Number.isFinite(low) ? origin - low : null;
}

export class Casualties {
  private all = new Map<string, Casualty>();

  constructor(
    private parent: THREE.Object3D,
    /** The top of whatever is underfoot at (x, z) for feet at `y`. */
    private ground: (x: number, z: number, y: number) => number,
    private hooks: CasualtyHooks,
  ) {}

  /** A fall, a body on the floor, a body ascending. The picture is still playing it out. */
  get active(): boolean {
    return this.all.size > 0;
  }

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
      if (!this.dying(id) || Math.abs(c.ground - at.y) > 1.5) continue;
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
    const tip = (Math.random() < 0.5 ? -1 : 1) * (1.35 + Math.random() * 0.25);
    const lean = (Math.random() - 0.5) * 0.5;
    // Lying down, the body reaches below its feet: lift it until its lowest point rests on the floor.
    const landed = new THREE.Quaternion().setFromEuler(new THREE.Euler(tip, yaw + lean + side * 0.9, lean * 0.6 + side * 0.35, FALLEN));
    floor.y = top + (reach(model.root, landed) ?? -FEET);
    // The beam only ever lifts it: face-up never sinks lower than where it lay.
    const supine = Math.max(floor.y, top + (reach(model.root, SUPINE) ?? -FEET));
    const pool = look === 'spell' ? spellCircle() : bloodPool();
    // On top of whatever is underfoot, not at the body's origin (the rugs under the desks stand
    // 0.021 proud of the floorboards).
    pool.position.set(floor.x, top + 0.03, floor.z);
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
      tip,
      lean,
      side,
      floor,
      ground: top,
      supine,
      pool,
      laptop: null,
      lgone: 0,
      beam: null,
      rotation: new THREE.Quaternion(),
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

  /** Confirms dismissal: a heavenly beam appears, then the body floats straight through the ceiling. */
  confirm(id: string, laptop: CasualtyLaptop): boolean {
    const c = this.all.get(id);
    if (!c || (c.phase !== 'fall' && c.phase !== 'bled')) return false;
    if (c.phase === 'fall') this.land(c);
    c.owned = true;
    c.laptop = laptop;
    c.phase = 'beam';
    c.t = 0;
    c.rotation.copy(c.model.root.quaternion);
    c.beam = heavenlyBeam(ASCEND_HEIGHT);
    c.beam.root.position.set(c.floor.x, c.ground + 0.025, c.floor.z);
    this.parent.add(c.beam.root);
    c.model.root.traverse((object) => {
      if ((object as THREE.Sprite).isSprite) object.visible = false;
    });
    return true;
  }

  /** Off to another floor, or gone: every scene ends, models back in their seats unless collected. */
  clear() {
    for (const c of this.all.values()) {
      if (c.owned) {
        this.dropModel(c);
      } else this.reseat(c);
      this.dropBeam(c);
      this.dropPool(c);
      this.dropLaptop(c);
    }
    this.all.clear();
  }

  update(dt: number, t: number) {
    for (const [id, c] of this.all) {
      this.step(c, dt);
      c.model.update(dt, t);
      if (c.laptop && !this.closeLaptop(c, dt)) c.laptop = null;
      if (c.phase === 'fade' && c.t >= FADE_TIME) {
        this.dropBeam(c);
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
        root.rotation.set(c.tip * e, c.yaw + (c.lean + c.side * 0.9) * e, (c.lean * 0.6 + c.side * 0.35) * e, FALLEN);
        if (p >= 1) this.land(c);
        return;
      }
      case 'bled':
        c.bleed = Math.min(1, c.bleed + dt / (c.look === 'spell' ? SPELL_TIME : BLEED_TIME));
        c.pool.scale.setScalar(Math.max(0.05, POOL_R * easeOut(c.bleed)));
        if (c.look === 'spell') this.twinkle(c, dt);
        return;
      case 'beam': {
        const p = smooth(c.t / BEAM_TIME);
        this.beamOpacity(c, p);
        root.quaternion.slerpQuaternions(c.rotation, SUPINE, p);
        // Rolling over swings the body lower than either end pose does, so keep it clear on the
        // way, and never let it sink back: the beam is taking it.
        const clear = reach(root, root.quaternion);
        root.position.y = Math.max(root.position.y, c.floor.y + (c.supine - c.floor.y) * p, clear === null ? -Infinity : c.ground + clear);
        if (c.t >= BEAM_TIME) {
          c.supine = Math.max(c.supine, root.position.y);
          c.phase = 'ascend';
          c.t = 0;
        }
        return;
      }
      case 'ascend': {
        const p = THREE.MathUtils.clamp(c.t / ASCEND_TIME, 0, 1);
        // Ease into the rise without moving sideways or shrinking the worker.
        root.position.y = c.supine + ASCEND_HEIGHT * p * p;
        c.pool.scale.setScalar(Math.max(0.001, Math.max(0.05, POOL_R * easeOut(c.bleed)) * (1 - smooth(p / 0.3))));
        if (p >= 1) {
          c.phase = 'fade';
          c.t = 0;
        }
        return;
      }
      case 'fade':
        this.beamOpacity(c, 1 - smooth(c.t / FADE_TIME));
        return;
    }
  }

  /** Down: it lands with a thud and starts bleeding out. */
  private land(c: Casualty) {
    c.model.root.position.copy(c.floor);
    c.model.root.rotation.set(c.tip, c.yaw + c.lean + c.side * 0.9, c.lean * 0.6 + c.side * 0.35, FALLEN);
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

  private beamOpacity(c: Casualty, value: number) {
    const beam = c.beam!;
    for (const material of beam.materials) material.opacity = (material.userData.opacity as number) * value;
    beam.light.intensity = value * 2;
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
    c.model.root.rotation.set(0, 0, 0, 'XYZ');
    c.model.root.scale.setScalar(c.scale);
    c.model.revive();
  }

  private dropBeam(c: Casualty) {
    const beam = c.beam;
    if (!beam) return;
    c.beam = null;
    beam.root.removeFromParent();
    for (const geometry of beam.geometries) geometry.dispose();
    for (const material of beam.materials) material.dispose();
    beam.light.dispose();
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
