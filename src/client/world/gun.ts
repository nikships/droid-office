import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * A stylized .44 revolver in meters: the fist closes around the grip at the origin, the bore
 * points along +Z and +Y is up. Holders rotate the whole prop to their aiming axis; the model
 * adds no wrist tilt. Solid side profiles keep the frame, guard and grip in the gun's YZ plane.
 * Four opaque toon batches work identically in the desktop and native scene renderer.
 * No DOM or WebGL at import time, so tests can load it in Node.
 */

/** Overall length, including the hammer behind the grip, in meters. */
export const GUN_LEN = 0.34;
/** How high the barrel sits above the origin. */
const BORE_Y = 0.086;

/** The closest rendered solid struck by a bullet; only registered workers can be targets. */
export function gunHit(ray: THREE.Raycaster, office: THREE.Object3D, workers: ReadonlyMap<THREE.Object3D, string>): { hit: THREE.Intersection; workerId: string | null } | null {
  // A muzzle ray has no camera. Do not raycast sprites: their camera-dependent intersection
  // would throw before any worker could react. Only rendered meshes can absorb a bullet.
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

/** A beveled side silhouette: coordinates are [forward Z, up Y], thickness runs along X. */
function profile(points: readonly (readonly [number, number])[], width: number, bevel = 0.001, holes: readonly (readonly (readonly [number, number])[])[] = []): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  for (const hole of holes) shape.holes.push(new THREE.Path(hole.map(([z, y]) => new THREE.Vector2(z, y))));
  return new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelSegments: 1, steps: 1, bevelSize: bevel, bevelThickness: bevel }).translate(0, 0, -width / 2 + bevel).rotateY(-Math.PI / 2);
}

/** An ellipse outline in the side plane, as [Z, Y] pairs. */
function oval(z: number, y: number, rz: number, ry: number, n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => [z + Math.cos((i / n) * Math.PI * 2) * rz, y + Math.sin((i / n) * Math.PI * 2) * ry]);
}

export function magnum(): THREE.Group {
  const gun = new THREE.Group();
  gun.name = 'magnum';
  const steel = new THREE.MeshToonMaterial({ color: '#ced5de' });
  const frame = new THREE.MeshToonMaterial({ color: '#85919f' });
  const wood = new THREE.MeshToonMaterial({ color: '#794830' });
  const dark = new THREE.MeshToonMaterial({ color: '#29313b' });
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>([
    [steel, []],
    [frame, []],
    [wood, []],
    [dark, []],
  ]);
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => batches.get(material)!.push(geometry.translate(x, y, z));
  const box = (width: number, height: number, length: number, material: THREE.Material, x: number, y: number, z: number) => add(new THREE.BoxGeometry(width, height, length), material, x, y, z);

  // An actual hollow tube, including its front annulus and inner wall. The dark recess is 20 mm
  // behind the lip, rather than a solid cap sitting on the muzzle like the previous model.
  const barrel = new THREE.Shape().absarc(0, 0, 0.018, 0, Math.PI * 2, false);
  barrel.holes.push(new THREE.Path().absarc(0, 0, 0.006, 0, Math.PI * 2, true));
  add(new THREE.ExtrudeGeometry(barrel, { depth: 0.184, bevelEnabled: false, curveSegments: 8, steps: 1 }), steel, 0, BORE_Y, 0.076);
  add(new THREE.CircleGeometry(0.006, 16), dark, 0, BORE_Y, 0.24);
  add(
    profile(
      [
        [0.075, 0.075],
        [0.25, 0.075],
        [0.246, 0.059],
        [0.08, 0.059],
      ],
      0.027,
      0.002,
    ),
    frame,
  );
  // A continuous top rib, a ramped front sight and a low notched rear sight on the top strap.
  box(0.011, 0.007, 0.18, steel, 0, 0.106, 0.163);
  add(
    profile(
      [
        [0.222, 0.108],
        [0.252, 0.108],
        [0.25, 0.121],
        [0.244, 0.122],
      ],
      0.004,
      0,
    ),
    dark,
  );
  for (const side of [-1, 1]) box(0.004, 0.007, 0.012, dark, side * 0.0055, 0.1125, -0.028);

  // The cylinder rotates around +Z, with its top chamber on the bore axis. Flutes are shallow
  // changes to its own outline rather than six intersecting cylinders protruding through it.
  const cylinder = new THREE.CylinderGeometry(0.03, 0.03, 0.076, 30);
  const pos = cylinder.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const flute = 1 - 0.065 * ((1 + Math.cos(Math.atan2(z, x) * 6)) / 2) ** 3;
    pos.setXYZ(i, x * flute, pos.getY(i), z * flute);
  }
  cylinder.computeVertexNormals();
  add(cylinder.rotateX(Math.PI / 2), steel, 0, BORE_Y - 0.026, 0.03);
  // Both shoulders of the frame leave a real opening around the cylinder.
  add(
    profile(
      [
        [-0.047, 0.081],
        [-0.039, 0.105],
        [-0.03, 0.11],
        [0.081, 0.11],
        [0.096, 0.093],
        [0.093, 0.029],
        [0.061, 0.021],
        [0.019, 0.022],
        [-0.006, 0.034],
        [-0.034, 0.015],
        [-0.051, 0.02],
      ],
      0.028,
      0.0015,
      [
        [
          [-0.012, 0.096],
          [0.075, 0.096],
          [0.077, 0.034],
          [-0.014, 0.034],
        ],
      ],
    ),
    frame,
  );
  // The hammer is the rearmost point, 80 mm behind the attachment.
  add(
    profile(
      [
        [-0.045, 0.092],
        [-0.039, 0.1],
        [-0.054, 0.12],
        [-0.079, 0.126],
        [-0.077, 0.119],
        [-0.059, 0.112],
      ],
      0.012,
    ),
    dark,
  );
  // The guard is a closed side profile, open in its middle and only 10 mm wide across X.
  const loop = (rz: number, ry: number, top: number): [number, number][] => [
    [0.048 - rz, top],
    [0.048 + rz, top],
    ...oval(0.048, 0.006, rz, ry, 24)
      .filter(([, y]) => y < 0.006)
      .reverse(),
  ];
  add(profile(loop(0.042, 0.05, 0.02), 0.01, 0.001, [loop(0.033, 0.041, 0.008)]), steel);
  add(
    profile(
      [
        [0.035, 0.013],
        [0.043, 0.012],
        [0.044, -0.006],
        [0.039, -0.019],
        [0.029, -0.023],
        [0.029, -0.017],
        [0.035, -0.01],
      ],
      0.007,
      0,
    ),
    dark,
  );

  // Sculpted walnut panels on a visible metal backstrap. The origin is inside the upper grip,
  // where a controller or cartoon fist holds it, rather than above the old dangling handle.
  const grip: readonly (readonly [number, number])[] = [
    [-0.032, 0.035],
    [-0.005, 0.033],
    [0.016, 0.018],
    [0.018, -0.004],
    [0.015, -0.03],
    [0.012, -0.052],
    [0.006, -0.064],
    [-0.008, -0.07],
    [-0.03, -0.07],
    [-0.045, -0.064],
    [-0.052, -0.051],
    [-0.046, -0.024],
    [-0.04, 0.0],
    [-0.036, 0.02],
  ];
  add(profile(grip, 0.034, 0.0015), frame);
  for (const side of [-1, 1]) {
    add(profile(grip, 0.007, 0.0025), wood, side * 0.0185);
    add(new THREE.CylinderGeometry(0.005, 0.005, 0.0015, 8).rotateZ(Math.PI / 2), steel, side * 0.0225, -0.019, -0.014);
    add(new THREE.CylinderGeometry(0.0015, 0.0015, 0.0017, 6).rotateZ(Math.PI / 2), dark, side * 0.023, -0.019, -0.014);
  }

  // Bake the static parts into one draw per material. No texture or unsupported material work is
  // required by the native exporter, and each returned gun owns its GPU resources.
  for (const [material, parts] of batches) {
    const surfaces = parts.map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry));
    const merged = mergeGeometries(surfaces)!;
    for (let i = 0; i < parts.length; i++) {
      parts[i].dispose();
      if (surfaces[i] !== parts[i]) surfaces[i].dispose();
    }
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = material === steel ? 'gun-steel' : material === frame ? 'gun-frame' : material === wood ? 'gun-walnut' : 'gun-details';
    gun.add(mesh);
  }
  return gun;
}

/** Where the muzzle is: the flash and the shot's smoke start here. */
export const MUZZLE_AT = new THREE.Vector3(0, BORE_Y, 0.26);

/** Takes a gun from magnum() out of the hand holding it, and frees what it was made of. */
export function disposeGun(prop: THREE.Group) {
  prop.removeFromParent();
  prop.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose();
  });
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

/**
 * A flash seen down the barrel of a gun in your own hand (native/physical.ts). The physical light
 * above falls off with the square of the distance, so in the headset it clipped everything within
 * an arm's length of the muzzle to white: the gun itself, the chair in front of it and the worker.
 * This one has no hot spot: a warm pool of up to about half the surfaces' own color round the shot
 * (the gun, what it is pointed at, the desk under it), softening out to 1.4 m, whatever is right
 * at the muzzle. The floor and the walls beyond stay as they were, rather than washing pink.
 */
export const HELD_FLASH: FlashLight = { color: '#ffb347', intensity: 1.5, distance: 1.4, decay: 0, ahead: 0.35 };

/** A held gun's light level where Sky.lightAt has nothing to say: indoors in the office. */
export const INDOOR_LIGHT = 0.4;
/** How much of its own color a held gun shows at a clear day's light level. */
const HELD_FILL = 0.85;

/**
 * The fill a held gun gets at `level` (Sky.lightAt, 0–1), as a share of its own color: the curve
 * Hands.setLight lights the desktop's first-person fist and gun with. Indoors that is about half,
 * like the native hand renderer's ambient term (0.55), so the gun reads as steel and walnut in the
 * hand that holds it; the office's night light alone gives it a tenth, and it goes navy.
 */
export function heldGunFill(level: number): number {
  return HELD_FILL * (0.25 + 0.75 * THREE.MathUtils.clamp(Number.isFinite(level) ? level : INDOOR_LIGHT, 0, 1));
}

/**
 * Lights a gun from magnum() like the hand holding it: each of its toon batches glows with
 * heldGunFill(level) of its own color, under whatever the room adds (lamps, the moon, a flash).
 */
export function lightHeldGun(gun: THREE.Object3D, level: number): void {
  const fill = heldGunFill(level);
  gun.traverse((o) => {
    const material = (o as THREE.Mesh).material;
    if (material instanceof THREE.MeshToonMaterial) material.emissive.copy(material.color).multiplyScalar(fill);
  });
}

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
    // The first frame drawn after the shot shows the whole flash; at the headset's 30 Hz
    // gameplay rate that is the difference between a pop and a two-frame glimmer.
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

/** Every spray's one small sphere: the headset uploads it once. */
let sprayBall: THREE.SphereGeometry | null = null;

/**
 * Where a bullet strikes a worker, at the contact point: a red mist bursting back out of the hit
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
