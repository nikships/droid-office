import * as THREE from 'three';
import { WALL_HEIGHT } from '../../shared/layout';
import { Sparkles } from './wand';

// Living 3D effects driven by Gemini Decision 1: feathered ceiling rays, stationary soft radial glow
// pools, luminous arc filaments between colliding desks, and delicate motes. Every effect uses soft
// vertex-color falloff to black under additive blending so no hard ring or silhouette edge ever
// appears on the floor or in mid-air. Parented to one group hidden during Remastered GI probe bakes.

/** How far above the floor floor-level glows float, clear of the rug and the floor's own decals. */
const LIFT = 0.018;
const WHITE = new THREE.Color('#ffffff');

let poolGeo: THREE.BufferGeometry | null = null;
let beamShaftGeo: THREE.BufferGeometry | null = null;

/**
 * Polar disc of unit radius on XZ whose vertex RGB falls smoothly from 1 at the center to 0 at r = 1
 * with zero slope at both ends, producing a soft pool of light with no visible outer boundary.
 */
function buildRadialGlowGeo(rings = 8, segs = 40): THREE.BufferGeometry {
  const verts = 1 + rings * segs;
  const pos = new Float32Array(verts * 3);
  const norm = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  norm[1] = 1;
  col[0] = col[1] = col[2] = 1;
  for (let r = 1; r <= rings; r++) {
    const u = r / rings;
    const w = Math.cos(u * Math.PI * 0.5) ** 2.6;
    const base = 1 + (r - 1) * segs;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const idx = (base + s) * 3;
      pos[idx] = Math.cos(a) * u;
      pos[idx + 1] = 0;
      pos[idx + 2] = Math.sin(a) * u;
      norm[idx + 1] = 1;
      col[idx] = col[idx + 1] = col[idx + 2] = w;
    }
  }
  const indices: number[] = [];
  for (let s = 0; s < segs; s++) {
    const next = (s + 1) % segs;
    indices.push(0, 1 + next, 1 + s);
  }
  for (let r = 2; r <= rings; r++) {
    const prev = 1 + (r - 2) * segs;
    const curr = 1 + (r - 1) * segs;
    for (let s = 0; s < segs; s++) {
      const next = (s + 1) % segs;
      indices.push(prev + s, prev + next, curr + next, prev + s, curr + next, curr + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Volumetric ray shaft built from four intersecting tapered vertical planes (0°, 45°, 90°, 135°)
 * whose vertex colors feather smoothly to zero across width (`u = ±1`) as well as at the floor and
 * ceiling (`v = 0, 1`), eliminating hard cylinder silhouette edges from every viewing angle.
 */
function buildBeamShaftGeo(topR = 0.22, botR = 0.72, fins = 4, cols = 12, rows = 16): THREE.BufferGeometry {
  const perFin = (cols + 1) * (rows + 1);
  const verts = fins * perFin;
  const pos = new Float32Array(verts * 3);
  const norm = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const indices: number[] = [];

  for (let f = 0; f < fins; f++) {
    const angle = (f / fins) * Math.PI;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const nx = -sinA;
    const nz = cosA;
    const finBase = f * perFin;

    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      const y = v * WALL_HEIGHT;
      const halfW = botR + (topR - botR) * v;
      const botFade = THREE.MathUtils.smoothstep(v, 0, 0.16);
      const topFade = 1 - THREE.MathUtils.smoothstep(v, 0.78, 1);
      const vWeight = botFade * topFade * (0.55 + 0.45 * Math.sin(v * Math.PI * 0.75));

      for (let c = 0; c <= cols; c++) {
        const u = (c / cols) * 2 - 1;
        const cCos = Math.cos(u * Math.PI * 0.5);
        const hWeight = 0.6 * cCos ** 2.6 + 0.4 * cCos ** 8;
        const w = vWeight * hWeight;
        const idx = (finBase + r * (cols + 1) + c) * 3;
        pos[idx] = cosA * u * halfW;
        pos[idx + 1] = y;
        pos[idx + 2] = sinA * u * halfW;
        norm[idx] = nx;
        norm[idx + 1] = 0;
        norm[idx + 2] = nz;
        col[idx] = col[idx + 1] = col[idx + 2] = w;
      }
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = finBase + r * (cols + 1) + c;
        const b = a + 1;
        const d = a + (cols + 1);
        const e = d + 1;
        indices.push(a, b, e, a, e, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(indices);
  return geo;
}

function fxMaterial(color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color,
    vertexColors: true,
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

/** A stationary, feathered pool of light that gently breathes in and dissolves with no outer edge. */
class SoftPool implements Effect {
  readonly group: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private t = 0;

  constructor(
    at: THREE.Vector3,
    hex: string,
    private radius = 1.2,
    private seconds = 1.4,
    private gain = 0.18,
  ) {
    poolGeo ??= buildRadialGlowGeo();
    this.group = fxMesh(poolGeo, fxMaterial(hex));
    this.group.position.set(at.x, at.y + LIFT, at.z);
    this.group.scale.set(radius * 0.86, 1, radius * 0.86);
  }

  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / this.seconds);
    const rise = Math.sin(Math.min(1, p / 0.28) * Math.PI * 0.5);
    const fade = (1 - p) ** 1.7;
    const r = this.radius * (0.88 + 0.18 * rise);
    this.group.scale.set(r, 1, r);
    this.group.material.opacity = this.gain * rise * fade;
    return p < 1;
  }

  dispose() {
    this.group.material.dispose();
  }
}

/**
 * A gossamer tapered shaft of light streaming down from the ceiling onto a desk, with a feathered
 * stationary floor glow (never an expanding ring and never a hard cylinder silhouette).
 */
class Beam implements Effect {
  readonly group = new THREE.Group();
  private shaft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private pool: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private t = 0;

  constructor(
    at: THREE.Vector3,
    hex: string,
    private seconds = 2.0,
    private gain = 1,
  ) {
    beamShaftGeo ??= buildBeamShaftGeo();
    poolGeo ??= buildRadialGlowGeo();
    const tint = new THREE.Color(hex).lerp(WHITE, 0.32);
    this.shaft = fxMesh(beamShaftGeo, fxMaterial(tint));
    this.pool = fxMesh(poolGeo, fxMaterial(tint));
    this.pool.position.y = LIFT;
    this.group.position.set(at.x, at.y, at.z);
    this.group.add(this.shaft, this.pool);
    this.apply(0);
  }

  private apply(p: number) {
    const open = Math.sin(Math.min(1, p / 0.26) * Math.PI * 0.5);
    const fade = (1 - p) ** 1.75;
    const env = open * fade * this.gain;
    const width = Math.max(0.001, (0.78 + 0.22 * open) * (1 - p * 0.22));
    this.shaft.scale.set(width, 1, width);
    const poolR = 1.2 * (0.86 + 0.16 * open);
    this.pool.scale.set(poolR, 1, poolR);
    this.shaft.material.opacity = 0.085 * env;
    this.pool.material.opacity = 0.13 * env;
  }

  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / this.seconds);
    this.apply(p);
    return p < 1;
  }

  dispose() {
    this.shaft.material.dispose();
    this.pool.material.dispose();
  }
}

/** A luminous arc shimmering gently between two desks at cross purposes, feathered at both ends. */
class Crackle implements Effect {
  readonly group: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private t = 0;
  private sinceJitter = 1;
  private readonly points = 20;

  constructor(
    private from: THREE.Vector3,
    private to: THREE.Vector3,
    hex: string,
    private seconds = 2.0,
    private gain = 0.42,
  ) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.points * 3), 3));
    const colors = new Float32Array(this.points * 3);
    for (let i = 0; i < this.points; i++) {
      const u = i / (this.points - 1);
      const w = Math.sin(u * Math.PI) ** 0.85;
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = w;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      color: hex,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    mat.userData.outlineParameters = { visible: false };
    this.group = new THREE.Line(geo, mat);
    this.group.renderOrder = 6;
    this.group.frustumCulled = false;
    this.jitter();
  }

  private jitter() {
    const pos = this.group.geometry.getAttribute('position') as THREE.BufferAttribute;
    const span = this.from.distanceTo(this.to);
    const arch = Math.min(0.65, 0.22 + span * 0.05);
    const amp = Math.min(0.24, span * 0.04);
    for (let i = 0; i < this.points; i++) {
      const u = i / (this.points - 1);
      const env = Math.sin(u * Math.PI);
      const sway = (Math.random() - 0.5) * amp * env;
      pos.setXYZ(i, this.from.x + (this.to.x - this.from.x) * u + sway, this.from.y + (this.to.y - this.from.y) * u + env * arch + sway * 0.5, this.from.z + (this.to.z - this.from.z) * u - sway);
    }
    pos.needsUpdate = true;
  }

  update(dt: number): boolean {
    this.t += dt;
    this.sinceJitter += dt;
    if (this.sinceJitter > 0.065) {
      this.sinceJitter = 0;
      this.jitter();
    }
    const p = Math.min(1, this.t / this.seconds);
    const fadeIn = Math.min(1, p / 0.16);
    const fadeOut = (1 - p) ** 1.3;
    this.group.material.opacity = this.gain * fadeIn * fadeOut * (0.82 + Math.random() * 0.18);
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
  /** Prefers reduced motion: skips rays, glow pools and shimmering filaments. */
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

  /** A worker's micro-reaction: delicate motes in its color and a soft, stationary floor glow. */
  react(hex: string, head: THREE.Vector3, feet: THREE.Vector3, opts: { sparks?: number; lift?: number; glow?: boolean } = {}) {
    this.add(
      new Wrapped(
        new Sparkles(head.clone().add(new THREE.Vector3(0, 0.18, 0)), null, {
          colors: [hex, '#ffffff', hex],
          count: opts.sparks ?? 18,
          speed: 1.1,
          size: 0.024,
          seconds: 1.4,
          lift: opts.lift ?? 0.75,
        }),
      ),
    );
    if (opts.glow !== false && !this.calmMotion) this.add(new SoftPool(feet, hex, 1.05, 1.3, 0.14));
  }

  /**
   * Something the office knows happened at a desk (hired, finished, shipped, sent home, shot):
   * floating motes, plus either a feathered ceiling ray (`beam`) or a quiet stationary glow pool.
   */
  deskMoment(hex: string, head: THREE.Vector3, feet: THREE.Vector3, opts: { beam?: boolean; implode?: boolean; sparks?: number } = {}) {
    this.add(
      new Wrapped(
        new Sparkles(head.clone().add(new THREE.Vector3(0, 0.18, 0)), null, {
          colors: [hex, '#ffffff', hex],
          count: opts.sparks ?? 24,
          speed: 1.25,
          size: 0.026,
          seconds: 1.55,
          lift: opts.implode ? -0.35 : 0.85,
        }),
      ),
    );
    if (this.calmMotion) return;
    if (opts.beam) this.add(new Beam(feet, hex));
    else this.add(new SoftPool(feet, hex, opts.implode ? 1.1 : 1.25, 1.35, 0.16));
  }

  /** Shimmering arc filaments between pairs of heads, for desks at cross purposes. */
  links(pairs: [THREE.Vector3, THREE.Vector3][], hex: string) {
    if (this.calmMotion) return;
    for (const [a, b] of pairs) {
      const from = a.clone().add(new THREE.Vector3(0, 0.35, 0));
      const to = b.clone().add(new THREE.Vector3(0, 0.35, 0));
      this.add(new Crackle(from, to, hex, 2.0, 0.42));
      this.add(new Crackle(from, to, '#ffffff', 1.5, 0.24));
    }
  }

  /**
   * A room-wide moment: each graded desk blooms in turn outward from `center` with a soft pool of
   * light and gentle rising motes, without casting any ring across the floor.
   */
  roomWave(center: THREE.Vector3, hex: string, heads: { head: THREE.Vector3; feet: THREE.Vector3; id?: string }[]) {
    for (const h of heads) {
      const delay = this.calmMotion ? 0 : (Math.hypot(h.feet.x - center.x, h.feet.z - center.z) / 26) * 1.1;
      this.later(delay, () => {
        if (!this.calmMotion) this.add(new SoftPool(h.feet, hex, 1.15, 1.45, 0.15));
        this.add(
          new Wrapped(
            new Sparkles(h.head.clone().add(new THREE.Vector3(0, 0.2, 0)), null, {
              colors: [hex, '#ffffff'],
              count: 14,
              speed: 1.0,
              size: 0.022,
              seconds: 1.35,
              lift: 0.85,
            }),
          ),
        );
      });
    }
  }

  /**
   * Living 3D switched on (a gentle warm ray descending from the ceiling glyph with rising motes)
   * or off (a quiet settling glow).
   */
  power(on: boolean, from: THREE.Vector3) {
    if (this.calmMotion) return;
    if (on) {
      this.add(new Beam(from, '#ff8a3d', 1.6, 0.55));
      this.add(
        new Wrapped(
          new Sparkles(from.clone().add(new THREE.Vector3(0, 0.95, 0)), null, {
            colors: ['#ff8a3d', '#ffd7a8', '#ffffff'],
            count: 16,
            speed: 0.95,
            size: 0.022,
            seconds: 1.4,
            lift: 0.8,
          }),
        ),
      );
    } else {
      this.add(new SoftPool(from, '#94a3b8', 0.95, 1.0, 0.1));
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
    fx.add(new SoftPool(new THREE.Vector3(), '#ffffff'));
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
