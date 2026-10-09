import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toonUnique } from './toon';

/**
 * A stainless .44 Magnum revolver in meters: the fist closes around the grip at the origin, the
 * bore points along +Z and +Y is up. Holders rotate the whole prop to their aiming axis; the model
 * adds no wrist tilt. The model is `magnum.glb`, built by tools/props/generate.py with its grip
 * shaped round the glove (glove.ts): the static body in one mesh per material, and the cylinder
 * apart on its crane (setCylinder), so it can swing out and spin.
 * No DOM or WebGL at import time, so tests can load it in Node.
 */

// These must match MAGNUM in tools/props/generate.py.
/** Overall length, including the hammer spur behind the grip, in meters. */
export const GUN_LEN = 0.2846;
/** The middle of the cylinder, shut. */
const DRUM_AT = new THREE.Vector3(0, 0.047, 0.03);
/** The crane's hinge, under the cylinder and to its left (+X), inside the frame. */
const CRANE_AT = new THREE.Vector2(0.008, 0.012);

/** The closest rendered solid struck by a bullet; only registered droids can be targets. */
export function gunHit(ray: THREE.Raycaster, office: THREE.Object3D, workers: ReadonlyMap<THREE.Object3D, string>): { hit: THREE.Intersection; workerId: string | null } | null {
  // A muzzle ray has no camera. Do not raycast sprites: their camera-dependent intersection
  // would throw before any droid could react. Only rendered meshes can absorb a bullet.
  const solids = new Set<THREE.Mesh>();
  for (const root of [office, ...workers.keys()])
    root.traverseVisible((object) => {
      if (object instanceof THREE.Mesh) solids.add(object);
    });
  for (const hit of ray.intersectObjects([...solids], false)) {
    // Raycaster includes material-invisible meshes; a multi-material mesh can hide one face.
    if (!(hit.object instanceof THREE.Mesh)) continue;
    const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face?.materialIndex ?? 0] : hit.object.material;
    if (!material?.visible || material.opacity <= 0) continue;
    let shown = true;
    let workerId: string | null = null;
    for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) {
      if (!object.visible) shown = false;
      workerId ??= workers.get(object) ?? null;
    }
    if (shown) return { hit, workerId };
  }
  return null;
}

/** Where the muzzle is: the flash and the shot's smoke start here. */
export const MUZZLE_AT = new THREE.Vector3(0, 0.062, 0.235);

/**
 * Where the trigger finger goes through the guard: a gun spun on it turns round this point. The
 * guard's opening clears a glove finger laid across the gun here however far round it turns.
 */
export const SPIN_AT = new THREE.Vector3(0, -0.007, 0.05);

/** How far round the crane swings the cylinder out to the gun's left (+X), in radians about +Z. */
export const CRANE_SWING = -1.75;

/** What each part of magnum.glb is called in a gun, by its material in the generator. */
const PARTS: Record<string, string> = {
  GunFrame: 'gun-frame',
  GunSteel: 'gun-steel',
  GunWalnut: 'gun-walnut',
  GunDark: 'gun-details',
  GunOrange: 'gun-sight',
};
const DRUM_PARTS: Record<string, string> = { GunSteel: 'gun-cylinder', GunDark: 'gun-chambers', GunBrass: 'gun-brass' };

/** magnum.glb's meshes, toon-shaded, which every gun shares: the body, the crane's arm and the cylinder. */
interface Model {
  body: THREE.Mesh[];
  arm: THREE.Mesh[];
  drum: THREE.Mesh[];
}
let model: Model | null = null;
/** What the shared model is made of: disposeGun leaves it for the next gun. */
const shared = new WeakSet<object>();
/** Guns made before the model arrived, filled in when it does. */
const waiting = new Set<THREE.Group>();

interface GunCylinder {
  crane: THREE.Object3D;
  drum: THREE.Object3D;
}

/**
 * Takes magnum.glb's scene (as GLTFLoader gives it) as the model every gun is made from, and fills
 * in any gun made before it arrived. Its materials become toon ones of the same colors.
 */
export function setMagnumModel(scene: THREE.Object3D) {
  const toons = new Map<string, THREE.MeshToonMaterial>();
  const part = (source: THREE.Mesh, names: Record<string, string>): THREE.Mesh => {
    const from = source.material as THREE.MeshStandardMaterial;
    let material = toons.get(from.name);
    if (!material) {
      material = toonUnique(from.color);
      material.name = from.name;
      toons.set(from.name, material);
      shared.add(material);
    }
    const mesh = new THREE.Mesh(source.geometry, material);
    mesh.name = names[from.name] ?? from.name;
    shared.add(source.geometry);
    return mesh;
  };
  const next: Model = { body: [], arm: [], drum: [] };
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.name === 'gun-crane-arm') next.arm.push(part(o, { GunSteel: 'gun-crane-arm' }));
    else if (o.parent?.name === 'gun-drum') next.drum.push(part(o, DRUM_PARTS));
    else next.body.push(part(o, PARTS));
  });
  model = next;
  for (const gun of waiting) fill(gun);
  waiting.clear();
}

/** Loads magnum.glb from its bytes (tests read it off disk; the office loads it with the props). */
export function parseMagnum(glb: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      glb,
      '',
      (gltf) => {
        setMagnumModel(gltf.scene);
        resolve();
      },
      reject,
    );
  });
}

/** True once the model is in, so magnum() comes back whole. */
export function magnumReady(): boolean {
  return model !== null;
}

function fill(gun: THREE.Group) {
  const m = model!;
  const c = gun.userData.cylinder as GunCylinder;
  const copy = (meshes: THREE.Mesh[]) => meshes.map((s) => Object.assign(new THREE.Mesh(s.geometry, s.material), { name: s.name }));
  gun.add(...copy(m.body));
  c.crane.add(...copy(m.arm));
  c.drum.add(...copy(m.drum));
}

/**
 * A magnum: the body, and the cylinder on its crane. Before the model has loaded it comes back
 * empty, and fills in when it lands.
 */
export function magnum(): THREE.Group {
  const gun = new THREE.Group();
  gun.name = 'magnum';
  // The crane hinges along +Z under the cylinder; the cylinder turns on its own axis.
  const crane = new THREE.Group();
  crane.name = 'gun-crane';
  crane.position.set(CRANE_AT.x, CRANE_AT.y, 0);
  const drum = new THREE.Group();
  drum.name = 'gun-drum';
  drum.position.set(DRUM_AT.x - CRANE_AT.x, DRUM_AT.y - CRANE_AT.y, DRUM_AT.z);
  crane.add(drum);
  gun.add(crane);
  gun.userData.cylinder = { crane, drum } satisfies GunCylinder;
  if (model) fill(gun);
  else waiting.add(gun);
  return gun;
}

/** Swings a magnum()'s cylinder out on its crane (0 shut … 1 all the way out) and turns it `turn` radians on its axis. */
export function setCylinder(gun: THREE.Object3D, open: number, turn: number) {
  const c = gun.userData.cylinder as GunCylinder | undefined;
  if (!c) return;
  c.crane.rotation.z = CRANE_SWING * open;
  c.drum.rotation.z = turn;
}

/**
 * Takes a gun from magnum() out of the hand holding it, and frees what was added to it (its muzzle
 * flash). The model it shares with every other gun stays.
 */
export function disposeGun(prop: THREE.Group) {
  prop.removeFromParent();
  waiting.delete(prop);
  const freed = new Set<{ dispose(): void }>();
  prop.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !shared.has(m.geometry)) freed.add(m.geometry);
    for (const material of [m.material ?? []].flat()) if (!shared.has(material)) freed.add(material);
  });
  for (const r of freed) r.dispose();
}

/** How a muzzle flash lights its surroundings, at the flash's peak. */
export interface FlashLight {
  color: string;
  /** three.js point light intensity. */
  intensity: number;
  /** Meters beyond which it lights nothing. */
  distance: number;
  /** three.js decay exponent: 2 is physical, 0 lights everything within `distance` alike. */
  decay: number;
  /** Meters ahead of the muzzle along the bore. */
  ahead: number;
}

/** A flash seen from across the room: a hard physical light right at the barrel, thrown on the walls. */
const ROOM_FLASH: FlashLight = { color: '#ffb347', intensity: 14, distance: 7, decay: 2, ahead: 0.1 };

/** How long a muzzle flash lasts, in seconds. */
const FLASH_TIME = 0.09;

/**
 * The flash at the muzzle when it fires: a star of crossed additive planes round a white-hot core,
 * and a point light that throws it round the shot (`flash`). fire() pops it; update() fades it
 * back to nothing.
 */
export class Muzzle {
  readonly group = new THREE.Group();
  private t = Infinity;
  private fresh = false;
  private core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private star: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
  private light: THREE.PointLight;

  constructor(private flash: FlashLight = ROOM_FLASH) {
    this.group.position.copy(MUZZLE_AT);
    const additive = (color: string, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), additive('#fff6d8', 0));
    this.group.add(this.core);
    this.star = [];
    for (const [w, l] of [
      [0.05, 0.22],
      [0.05, 0.22],
      [0.09, 0.12],
    ]) {
      const blade = new THREE.Mesh(new THREE.PlaneGeometry(w, l), additive('#ffb347', 0));
      if (this.star.length === 1) blade.rotation.z = Math.PI / 2;
      if (this.star.length === 2) blade.rotation.y = Math.PI / 2;
      // Along the barrel, half of it past the muzzle.
      blade.rotation.x = this.star.length === 2 ? 0 : Math.PI / 2;
      blade.position.z = 0.08;
      this.group.add(blade);
      this.star.push(blade);
    }
    this.light = new THREE.PointLight(flash.color, 0, flash.distance, flash.decay);
    this.light.position.z = flash.ahead;
    this.group.add(this.light);
  }

  fire() {
    this.t = 0;
    this.fresh = true;
    // A different star each shot, at full brightness from the shot's own frame.
    this.group.rotation.z = Math.random() * Math.PI;
    this.show(1);
  }

  get lit(): boolean {
    return this.t < FLASH_TIME;
  }

  update(dt: number) {
    if (this.t >= FLASH_TIME) return;

    // Keep the flash at full brightness for its first frame.
    if (this.fresh) {
      this.fresh = false;
      return;
    }
    this.t += dt;
    this.show(Math.max(0, 1 - this.t / FLASH_TIME));
  }

  private show(k: number) {
    this.core.material.opacity = k;
    this.core.scale.setScalar(0.6 + 0.4 * k);
    for (const b of this.star) b.material.opacity = k * 0.9;
    this.group.scale.setScalar(1 + (1 - k) * 0.6);
    this.light.intensity = this.flash.intensity * k * k;
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat && 'dispose' in mat) mat.dispose();
    });
  }
}

/** How long an impact puff hangs in the air, in seconds. */
const PUFF_TIME = 0.5;

/**
 * Where a missed shot cracks into the wall or floor: grey dust bursting out, with one orange spark,
 * swelling and fading in half a second. update() returns false once it's gone.
 */
export class Puff {
  readonly group = new THREE.Group();
  private t = 0;
  private bits: { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; vel: THREE.Vector3 }[] = [];

  constructor(at: THREE.Vector3, normal: THREE.Vector3 | null) {
    this.group.position.copy(at);
    const away = (normal ?? new THREE.Vector3(0, 1, 0)).clone();
    const mat = (color: string) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    for (let i = 0; i < 5; i++) {
      const dust = new THREE.Mesh(new THREE.SphereGeometry(0.035 + Math.random() * 0.03, 8, 6), mat('#b9b3a8'));
      const v = away.clone().multiplyScalar(1.2 + Math.random());
      v.x += (Math.random() - 0.5) * 2.2;
      v.y += Math.random() * 1.4;
      v.z += (Math.random() - 0.5) * 2.2;
      this.bits.push({ mesh: dust, vel: v });
      this.group.add(dust);
    }
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), mat('#ffcf5c'));
    this.bits.push({
      mesh: spark,
      vel: away
        .clone()
        .multiplyScalar(4)
        .add(new THREE.Vector3((Math.random() - 0.5) * 3, 2, (Math.random() - 0.5) * 3)),
    });
    this.group.add(spark);
  }

  /** Moves the dust along; false once it has cleared. */
  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / PUFF_TIME);
    for (const b of this.bits) {
      b.mesh.position.addScaledVector(b.vel, dt);
      b.vel.multiplyScalar(Math.exp(-dt * 3));
      b.vel.y -= dt * 1.5;
      b.mesh.scale.setScalar(1 + p * 2.2);
      b.mesh.material.opacity = 0.9 * (1 - p);
    }
    return p < 1;
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }
}

/** How long a hit's spray hangs in the air, in seconds. */
const SPRAY_TIME = 0.45;

let sprayBall: THREE.SphereGeometry | null = null;

/**
 * Where a bullet strikes a droid, at the contact point: a red mist bursting back out of the hit
 * and droplets flung out of it that drop and fade in under half a second. update() returns false
 * once it's gone.
 */
export class BloodSpray {
  readonly group = new THREE.Group();
  private t = 0;
  private bits: { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; vel: THREE.Vector3; size: number; grow: number; fall: number }[] = [];
  private ball = (sprayBall ??= new THREE.SphereGeometry(1, 8, 6));

  /** `out` points back out of the wound (toward the shooter); `travel` is the bullet's direction. */
  constructor(at: THREE.Vector3, out: THREE.Vector3, travel: THREE.Vector3) {
    this.group.position.copy(at);
    const away = out.clone().normalize();
    const on = travel.clone().normalize();
    const add = (color: string, opacity: number, size: number, vel: THREE.Vector3, grow: number, fall: number) => {
      const mesh = new THREE.Mesh(this.ball, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      mesh.scale.setScalar(size);
      this.group.add(mesh);
      this.bits.push({ mesh, vel, size, grow, fall });
    };
    // The mist: a quick red cloud swelling out of the wound.
    for (let i = 0; i < 3; i++)
      add(
        '#9e1420',
        0.85,
        0.035 + Math.random() * 0.02,
        away
          .clone()
          .multiplyScalar(0.5 + Math.random() * 0.4)
          .add(jitter(0.5)),
        3.2,
        0.4,
      );
    // Droplets: most fly back at the shooter, a few carry on with the bullet; gravity takes them.
    for (let i = 0; i < 8; i++) {
      const dir = (i < 6 ? away : on)
        .clone()
        .multiplyScalar(1.6 + Math.random() * 1.6)
        .add(jitter(1.4));
      dir.y += 0.6 + Math.random() * 0.8;
      add(i % 3 ? '#b3121f' : '#d8202e', 0.95, 0.009 + Math.random() * 0.009, dir, 0.3, 9.8);
    }
  }

  /** Moves the spray along; false once it has cleared. */
  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / SPRAY_TIME);
    for (const b of this.bits) {
      b.mesh.position.addScaledVector(b.vel, dt);
      b.vel.multiplyScalar(Math.exp(-dt * 2.5));
      b.vel.y -= dt * b.fall;
      b.mesh.scale.setScalar(b.size * (1 + p * b.grow));
      b.mesh.material.opacity = (b.grow > 1 ? 0.85 : 0.95) * (1 - p * p);
    }
    return p < 1;
  }

  /** Frees its materials; the shared sphere stays for the next hit. */
  dispose() {
    for (const b of this.bits) b.mesh.material.dispose();
  }
}

function jitter(size: number): THREE.Vector3 {
  return new THREE.Vector3((Math.random() - 0.5) * size, (Math.random() - 0.5) * size, (Math.random() - 0.5) * size);
}
