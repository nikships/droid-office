import * as THREE from 'three';
import { Sparkles } from './wand';

// Living 3D effects driven by Gemini Decision 1: shockwave rings racing across the floor, beams of
// light, crackling links between desks, and sparks. Everything is unlit additive MeshBasicMaterial
// (no outlines, no shadows), parented to one group that probe bakes hide, so none of it reaches
// the Remastered GI cache.

/** How far above the floor floor-level effects float, clear of the rug and the floor's own decals. */
const LIFT = 0.018;

let waveGeo: THREE.RingGeometry | null = null;
let beamGeo: THREE.CylinderGeometry | null = null;

function flat<T extends THREE.BufferGeometry>(g: T): T {
  g.rotateX(-Math.PI / 2);
  return g;
}

function fxMaterial(color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  mat.userData.outlineParameters = { visible: false };
  return mat;
}

function fxMesh(geo: THREE.BufferGeometry, mat: THREE.MeshBasicMaterial): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 4;
  mesh.castShadow = mesh.receiveShadow = false;
  return mesh;
}

interface Effect {
  group: THREE.Object3D;
  update(dt: number): boolean;
  dispose(): void;
}

/** A ring racing out across the floor from `at` (or in toward it), fading as it goes. */
class Shockwave implements Effect {
  readonly group: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private t = 0;

  constructor(
    at: THREE.Vector3,
    hex: string,
    private from: number,
    private to: number,
    private seconds: number,
    private gain = 1,
  ) {
    waveGeo ??= flat(new THREE.RingGeometry(0.92, 1, 96));
    this.group = fxMesh(waveGeo, fxMaterial(hex));
    this.group.position.set(at.x, at.y + LIFT * 2, at.z);
    this.group.scale.setScalar(Math.max(0.001, from));
  }

  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / this.seconds);
    const eased = 1 - (1 - p) ** 3;
    const r = this.from + (this.to - this.from) * eased;
    this.group.scale.set(Math.max(0.001, r), 1, Math.max(0.001, r));
    this.group.material.opacity = this.gain * (1 - p) ** 1.5;
    return p < 1;
  }

  dispose() {
    this.group.material.dispose();
  }
}

/** A column of light shooting up from a desk and fading: someone arriving. */
class Beam implements Effect {
  readonly group: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private t = 0;

  constructor(
    at: THREE.Vector3,
    hex: string,
    private seconds = 1.6,
  ) {
    beamGeo ??= new THREE.CylinderGeometry(0.55, 0.75, 1, 32, 1, true).translate(0, 0.5, 0);
    this.group = fxMesh(beamGeo, fxMaterial(hex));
    this.group.position.set(at.x, at.y + LIFT, at.z);
    this.group.scale.set(1, 0.001, 1);
  }

  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / this.seconds);
    const rise = 1 - (1 - Math.min(1, p / 0.35)) ** 3;
    this.group.scale.set(1 - p * 0.55, Math.max(0.001, rise * 4.2), 1 - p * 0.55);
    this.group.material.opacity = 0.75 * (1 - p) ** 1.4;
    return p < 1;
  }

  dispose() {
    this.group.material.dispose();
  }
}

/** A jagged line of light crackling between two points, re-zigzagged every few frames: desks at odds. */
class Crackle implements Effect {
  readonly group: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private t = 0;
  private sinceJitter = 1;
  private readonly points: number;

  constructor(
    private from: THREE.Vector3,
    private to: THREE.Vector3,
    hex: string,
    private seconds = 2.2,
  ) {
    this.points = 14;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.points * 3), 3));
    const mat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, toneMapped: false });
    mat.userData.outlineParameters = { visible: false };
    this.group = new THREE.Line(geo, mat);
    this.group.renderOrder = 11;
    this.group.frustumCulled = false;
    this.jitter();
  }

  private jitter() {
    const pos = this.group.geometry.getAttribute('position') as THREE.BufferAttribute;
    const span = this.from.distanceTo(this.to);
    for (let i = 0; i < this.points; i++) {
      const u = i / (this.points - 1);
      const sway = i === 0 || i === this.points - 1 ? 0 : (Math.random() - 0.5) * Math.min(0.9, span * 0.12);
      pos.setXYZ(i, this.from.x + (this.to.x - this.from.x) * u + sway, this.from.y + (this.to.y - this.from.y) * u + Math.sin(u * Math.PI) * 0.5 + sway * 0.6, this.from.z + (this.to.z - this.from.z) * u - sway);
    }
    pos.needsUpdate = true;
  }

  update(dt: number): boolean {
    this.t += dt;
    this.sinceJitter += dt;
    if (this.sinceJitter > 0.07) {
      this.sinceJitter = 0;
      this.jitter();
    }
    const p = Math.min(1, this.t / this.seconds);
    this.group.material.opacity = (p < 0.1 ? p / 0.1 : (1 - p) ** 0.8) * (0.6 + Math.random() * 0.4);
    return p < 1;
  }

  dispose() {
    this.group.geometry.dispose();
    this.group.material.dispose();
  }
}

class Wrapped implements Effect {
  constructor(private s: Sparkles) {}
  get group() {
    return this.s.group;
  }
  update(dt: number) {
    return this.s.update(dt);
  }
  dispose() {
    this.s.dispose();
  }
}

export class VibeFx {
  readonly group = new THREE.Group();
  private effects: Effect[] = [];
  private queued: { at: number; run: () => void }[] = [];
  private clock = 0;
  private on = false;
  /** Prefers reduced motion: nothing races across the floor. */
  calmMotion = false;

  constructor() {
    this.group.name = 'living-3d-fx';
  }

  /** Whether Living 3D is on for this view: transient effects play. */
  get enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean) {
    this.on = on;
  }

  /** A worker's micro-reaction: sparks in its color and an optional shockwave. */
  react(hex: string, head: THREE.Vector3, feet: THREE.Vector3, opts: { sparks?: number; lift?: number; wave?: boolean } = {}) {
    this.add(new Wrapped(new Sparkles(head.clone().add(new THREE.Vector3(0, 0.2, 0)), null, { colors: [hex, '#ffffff', hex], count: opts.sparks ?? 34, speed: 1.6, size: 0.032, seconds: 1.5, lift: opts.lift ?? 0.9 })));
    if (opts.wave !== false && !this.calmMotion) this.add(new Shockwave(feet, hex, 0.6, 3.4, 1.1, 0.9));
  }

  /**
   * Something the office knows happened at a desk (hired, finished, shipped, sent home, shot):
   * sparks, a shockwave racing out (or closing in with `implode`), and with `beam` a column of light
   * shooting up from the desk.
   */
  deskMoment(hex: string, head: THREE.Vector3, feet: THREE.Vector3, opts: { beam?: boolean; implode?: boolean; sparks?: number } = {}) {
    this.add(new Wrapped(new Sparkles(head.clone().add(new THREE.Vector3(0, 0.2, 0)), null, { colors: [hex, '#ffffff', hex], count: opts.sparks ?? 40, speed: 1.8, size: 0.034, seconds: 1.6, lift: opts.implode ? -0.4 : 1 })));
    if (this.calmMotion) return;
    if (opts.implode) this.add(new Shockwave(feet, hex, 4.2, 0.3, 1.2, 1));
    else this.add(new Shockwave(feet, hex, 0.5, 4.4, 1.2, 1));
    if (opts.beam) this.add(new Beam(feet, hex));
  }

  /** Crackling links of light between pairs of heads, for desks at cross purposes. */
  links(pairs: [THREE.Vector3, THREE.Vector3][], hex: string) {
    if (this.calmMotion) return;
    for (const [a, b] of pairs) {
      const from = a.clone().add(new THREE.Vector3(0, 0.35, 0));
      const to = b.clone().add(new THREE.Vector3(0, 0.35, 0));
      this.add(new Crackle(from, to, hex));
      this.add(new Crackle(from, to, '#ffffff', 1.6));
    }
  }

  /**
   * A room-wide moment: a ring racing out from `center` across the floor, then each of `heads` (with
   * `feet` under it) lighting up in turn as the ring reaches it.
   */
  roomWave(center: THREE.Vector3, hex: string, heads: { head: THREE.Vector3; feet: THREE.Vector3; id?: string }[]) {
    if (!this.calmMotion) {
      this.add(new Shockwave(center, hex, 0.5, 26, 2.2, 1));
      this.add(new Shockwave(center, '#ffffff', 0.3, 18, 1.8, 0.45));
    }
    for (const h of heads) {
      const delay = this.calmMotion ? 0 : (Math.hypot(h.feet.x - center.x, h.feet.z - center.z) / 26) * 2.2 * 0.6;
      this.later(delay, () => {
        this.add(new Wrapped(new Sparkles(h.head.clone().add(new THREE.Vector3(0, 0.25, 0)), null, { colors: [hex, '#ffffff'], count: 22, speed: 1.3, size: 0.028, seconds: 1.3, lift: 1.1 })));
      });
    }
  }

  /**
   * Living 3D switched on (a bright ring racing out from you) or off (a gray ring closing in on
   * you).
   */
  power(on: boolean, from: THREE.Vector3) {
    if (this.calmMotion) return;
    if (on) {
      this.add(new Shockwave(from, '#ff7a1a', 0.4, 30, 2, 1.2));
      this.add(new Shockwave(from, '#ffffff', 0.2, 22, 1.6, 0.6));
    } else {
      this.add(new Shockwave(from, '#8c8c8c', 26, 0.3, 1.4, 0.9));
    }
  }

  /** Plays `run` `seconds` from now. */
  later(seconds: number, run: () => void) {
    if (seconds <= 0) run();
    else this.queued.push({ at: this.clock + seconds, run });
  }

  private add(e: Effect) {
    this.group.add(e.group);
    this.effects.push(e);
  }

  /** Moves everything along; true while anything is still changing. */
  update(dt: number): boolean {
    this.clock += dt;
    if (this.queued.length) {
      const due: typeof this.queued = [];
      const pending: typeof this.queued = [];
      for (const q of this.queued) (q.at <= this.clock ? due : pending).push(q);
      this.queued = pending;
      for (const q of due) q.run();
    }
    let moving = this.queued.length > 0;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      if (e.update(dt)) {
        moving = true;
        continue;
      }
      this.group.remove(e.group);
      e.dispose();
      this.effects.splice(i, 1);
    }
    return moving;
  }

  /** One of each mesh, barely visible, for shader warmup. */
  static standIn(): THREE.Group {
    const fx = new VibeFx();
    fx.setEnabled(true);
    fx.add(new Shockwave(new THREE.Vector3(), '#ffffff', 1, 2, 1));
    fx.add(new Beam(new THREE.Vector3(), '#ffffff'));
    fx.add(new Crackle(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), '#ffffff'));
    fx.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) (o.material as THREE.Material).opacity = 0.01;
    });
    // Off below the floor with the other stand-ins.
    fx.group.position.set(0, -40, 0);
    return fx.group;
  }

  /** Clears every effect at once (changing floors). */
  clear() {
    for (const e of this.effects) {
      this.group.remove(e.group);
      e.dispose();
    }
    this.effects = [];
    this.queued = [];
  }
}

/** One of each mesh the effects draw, for shader warmup. */
export function vibeFxStandIn(): THREE.Group {
  return VibeFx.standIn();
}
