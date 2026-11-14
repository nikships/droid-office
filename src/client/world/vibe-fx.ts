import * as THREE from 'three';
import { MONITOR_SPILL_HEX, type MonitorSpillTone, POSTURE_AURA_HEX, type WorkerVibePosture } from '../../shared/gemini-vibes';
import { disposeSprite, textSprite } from './toon';
import { Sparkles } from './wand';

// Living 3D effects driven by Gemini Decision 1: a glowing ring on the floor under every graded
// worker (its color how it is going or its state of mind, its pulse and orbit as fast as the stakes
// are high, and an outer arc filled as far as it is through its task), emoji popping over heads,
// shockwave rings racing across the floor, beams of light, crackling links between desks, and
// sparks. Everything is
// unlit additive MeshBasicMaterial (no outlines, no shadows), parented to one group that probe bakes
// hide, so none of it reaches the Remastered GI cache.

const RING_INNER = 0.74;
const RING_OUTER = 0.84;
const ARC_INNER = 0.9;
const ARC_OUTER = 0.98;
const PROGRESS_INNER = 1.04;
const PROGRESS_OUTER = 1.12;
const PROGRESS_SEGMENTS = 72;
/** How far above the floor the rings float, clear of the rug and the floor's own decals. */
const LIFT = 0.018;

let ringGeo: THREE.RingGeometry | null = null;
let arcGeo: THREE.RingGeometry | null = null;
let discGeo: THREE.PlaneGeometry | null = null;
let waveGeo: THREE.RingGeometry | null = null;
let beamGeo: THREE.CylinderGeometry | null = null;
let glowTex: THREE.DataTexture | null = null;
const _show = new THREE.Color();
const WHITE = new THREE.Color('#ffffff');

function flat<T extends THREE.BufferGeometry>(g: T): T {
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A soft round glow, white in the middle and clear at the edge, tinted by each material's color. Built in JS so it needs no canvas. */
function glowTexture(): THREE.DataTexture {
  if (glowTex) return glowTex;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.min(1, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2));
      const a = r >= 1 ? 0 : (1 - r) ** 1.6 * 0.9;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  glowTex = new THREE.DataTexture(data, n, n);
  glowTex.magFilter = glowTex.minFilter = THREE.LinearFilter;
  glowTex.needsUpdate = true;
  return glowTex;
}

function fxMaterial(color: THREE.ColorRepresentation, map?: THREE.Texture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color,
    map: map ?? null,
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

/** One worker's desk ring: a soft glow disc, a breathing ring, an orbiting arc and its progress arc. */
class Aura {
  readonly group = new THREE.Group();
  private disc: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private arc: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  /** Its own geometry, drawn only as far round as the worker is through its task. */
  private progressArc: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly color = new THREE.Color(POSTURE_AURA_HEX.steady);
  private readonly target = new THREE.Color(POSTURE_AURA_HEX.steady);
  strength = 0;
  want = 0;
  stakes = 0.5;
  private shownStakes = 0.5;
  progress = 0;
  private shownProgress = 0;
  tone: MonitorSpillTone = 'neutral';
  private t = Math.random() * 10;
  /** Seconds into its pop-in when switched on, or a flare after a reaction; -1 when none. */
  private popT = -1;
  private flareT = -1;
  private readonly flareColor = new THREE.Color();

  constructor() {
    ringGeo ??= flat(new THREE.RingGeometry(RING_INNER, RING_OUTER, 72));
    arcGeo ??= flat(new THREE.RingGeometry(ARC_INNER, ARC_OUTER, 48, 1, 0, Math.PI * 0.55));
    discGeo ??= flat(new THREE.PlaneGeometry(2.2, 2.2));
    this.disc = fxMesh(discGeo, fxMaterial(this.color, glowTexture()));
    this.ring = fxMesh(ringGeo, fxMaterial(this.color));
    this.arc = fxMesh(arcGeo, fxMaterial(this.color));
    this.progressArc = fxMesh(flat(new THREE.RingGeometry(PROGRESS_INNER, PROGRESS_OUTER, PROGRESS_SEGMENTS, 1, Math.PI / 2, Math.PI * 2)), fxMaterial('#ffffff')) as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
    this.progressArc.geometry.setDrawRange(0, 0);
    this.group.add(this.disc, this.ring, this.arc, this.progressArc);
    this.group.visible = false;
  }

  setLook(tone: MonitorSpillTone, posture: WorkerVibePosture, stakes: number, progress: number) {
    this.tone = tone;
    this.target.set(tone === 'neutral' ? POSTURE_AURA_HEX[posture] : MONITOR_SPILL_HEX[tone]);
    this.stakes = Number.isFinite(stakes) ? Math.min(1, Math.max(0, stakes)) : 0.5;
    this.progress = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  }

  /** How far round its progress arc is drawn right now, 0–1. */
  get progressShown(): number {
    return this.shownProgress;
  }

  pop(delay = 0) {
    this.popT = -delay;
  }

  flare(hex: string) {
    this.flareColor.set(hex);
    this.flareT = 0;
  }

  /** True while it is still changing. */
  update(dt: number, calm: boolean): boolean {
    this.t += dt;
    const fade = 1 - Math.exp(-dt / (this.want > this.strength ? 0.35 : 0.5));
    this.strength += (this.want - this.strength) * fade;
    if (Math.abs(this.want - this.strength) < 1e-3 || (this.want === 0 && this.strength < 0.002)) this.strength = this.want;
    this.color.lerp(this.target, 1 - Math.exp(-dt / 0.4));
    this.shownStakes += (this.stakes - this.shownStakes) * (1 - Math.exp(-dt / 0.8));
    this.shownProgress += (this.progress - this.shownProgress) * (1 - Math.exp(-dt / 1.2));
    if (Math.abs(this.progress - this.shownProgress) < 1e-3) this.shownProgress = this.progress;
    const visible = this.strength > 0.002 || this.flareT >= 0;
    this.group.visible = visible;
    if (!visible) return false;

    const e = this.shownStakes;
    const hz = 0.5 + e * 2.4;
    const breathe = calm ? 0 : Math.sin(this.t * Math.PI * 2 * hz);
    let flicker = 1;
    if (this.tone === 'crimson' && !calm) flicker = 0.75 + 0.25 * Math.abs(Math.sin(this.t * 17) * Math.sin(this.t * 5.3));

    let popScale = 1;
    if (this.popT !== -1) {
      this.popT += dt;
      if (this.popT >= 0) {
        const u = Math.min(1, this.popT / 0.6);
        popScale = u < 1 ? 1 + Math.sin(u * Math.PI) * 0.45 - (1 - u) * 0.6 : 1;
        if (u >= 1) this.popT = -1;
      } else popScale = 0.001;
    }

    let flare = 0;
    if (this.flareT >= 0) {
      this.flareT += dt;
      flare = Math.max(0, 1 - this.flareT / 1.6);
      if (this.flareT >= 1.6) this.flareT = -1;
    }

    const k = this.strength * flicker;
    const show = _show.copy(this.color).lerp(this.flareColor, flare * 0.85);
    for (const m of [this.disc, this.ring, this.arc]) m.material.color.copy(show);
    this.progressArc.material.color.copy(show).lerp(WHITE, 0.45);
    this.progressArc.material.opacity = this.shownProgress > 0.01 ? k * 0.85 + flare * 0.3 : 0;
    this.progressArc.geometry.setDrawRange(0, Math.round(this.shownProgress * PROGRESS_SEGMENTS) * 6);
    this.disc.material.opacity = k * (0.22 + e * 0.28 + breathe * 0.08) + flare * 0.6;
    this.ring.material.opacity = k * (0.55 + e * 0.4 + breathe * 0.15) + flare * 0.5;
    this.arc.material.opacity = k * (0.5 + e * 0.5) + flare * 0.4;
    const swell = (1 + breathe * (0.03 + e * 0.05) + flare * 0.35) * popScale * Math.max(0.001, Math.min(1, this.strength * 1.25));
    this.group.scale.setScalar(Math.max(0.001, swell));
    if (!calm) this.arc.rotation.y -= dt * (0.6 + e * 6);
    return true;
  }

  dispose() {
    this.disc.material.dispose();
    this.ring.material.dispose();
    this.arc.material.dispose();
    this.progressArc.material.dispose();
    this.progressArc.geometry.dispose();
  }
}

interface Effect {
  group: THREE.Object3D;
  update(dt: number): boolean;
  dispose(): void;
}

/** An emoji popping up over a head, rising and fading. */
class GlyphPop implements Effect {
  readonly group: THREE.Sprite;
  private t = 0;
  private readonly size: THREE.Vector2;
  private readonly from: THREE.Vector3;

  constructor(
    glyph: string,
    at: THREE.Vector3,
    private seconds = 2.4,
    private scale = 1.6,
    private rise = 0.7,
  ) {
    this.group = textSprite(glyph, { size: 96 });
    this.group.material.depthTest = false;
    this.group.renderOrder = 12;
    this.size = new THREE.Vector2(this.group.scale.x, this.group.scale.y).multiplyScalar(scale);
    this.from = at.clone();
    this.group.position.copy(at);
    this.group.scale.set(0.001, 0.001, 1);
  }

  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / this.seconds);
    const popIn = Math.min(1, this.t / 0.28);
    const overshoot = popIn < 1 ? Math.sin(popIn * Math.PI * 0.5) * (1 + Math.sin(popIn * Math.PI) * 0.4) : 1;
    const out = p > 0.75 ? 1 - (p - 0.75) / 0.25 : 1;
    const k = Math.max(0.001, overshoot * (0.6 + 0.4 * out));
    this.group.scale.set(this.size.x * k, this.size.y * k, 1);
    this.group.position.set(this.from.x, this.from.y + this.rise * (1 - (1 - p) * (1 - p)) + Math.sin(this.t * 6) * 0.03, this.from.z);
    this.group.material.opacity = out;
    return p < 1;
  }

  dispose() {
    disposeSprite(this.group);
  }
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
  private auras = new Map<string, Aura>();
  /** Rings fading out after their worker left, dropped once dark. */
  private released = new Set<string>();
  private effects: Effect[] = [];
  private queued: { at: number; run: () => void }[] = [];
  private clock = 0;
  private on = false;
  /** Prefers reduced motion: rings hold still, nothing races across the floor. */
  calmMotion = false;

  constructor() {
    this.group.name = 'living-3d-fx';
  }

  /** Whether Living 3D is on for this view: rings show under graded workers and effects play. */
  get enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean) {
    this.on = on;
    if (!on) for (const a of this.auras.values()) a.want = 0;
  }

  /** Sets a worker's ring: `graded` false fades it out (not graded this pulse, or Living 3D is off). */
  setAura(id: string, graded: boolean, tone: MonitorSpillTone, posture: WorkerVibePosture, stakes: number, progress = 0) {
    let a = this.auras.get(id);
    if (!a) {
      if (!graded || !this.on) return;
      a = new Aura();
      this.auras.set(id, a);
      this.group.add(a.group);
      a.pop();
    }
    a.setLook(tone, posture, stakes, progress);
    a.want = graded && this.on ? 1 : 0;
  }

  /** Lets a worker's ring fade away where it is (it left its desk), then drops it. */
  release(id: string) {
    const a = this.auras.get(id);
    if (a) a.want = 0;
    this.released.add(id);
  }

  /** How far round a worker's progress arc is drawn (for automation). */
  progressOf(id: string): number {
    return this.auras.get(id)?.progressShown ?? 0;
  }

  /** Keeps a worker's ring under it, `at` being its feet. */
  follow(id: string, at: THREE.Vector3) {
    const a = this.auras.get(id);
    if (a) a.group.position.set(at.x, at.y + LIFT, at.z);
  }

  dropAura(id: string) {
    this.released.delete(id);
    const a = this.auras.get(id);
    if (!a) return;
    this.group.remove(a.group);
    a.dispose();
    this.auras.delete(id);
  }

  /** How many rings show right now (for automation). */
  get auraCount(): number {
    let n = 0;
    for (const a of this.auras.values()) if (a.group.visible && a.want > 0) n++;
    return n;
  }

  /** A worker's micro-reaction: its emoji over its head, sparks in its color, and its ring flaring out. */
  react(id: string, glyph: string, hex: string, head: THREE.Vector3, feet: THREE.Vector3, opts: { sparks?: number; lift?: number; wave?: boolean } = {}) {
    this.auras.get(id)?.flare(hex);
    this.add(new GlyphPop(glyph, head.clone().add(new THREE.Vector3(0, 0.55, 0)), 2.6, 1.7, 0.75));
    this.add(new Wrapped(new Sparkles(head.clone().add(new THREE.Vector3(0, 0.2, 0)), null, { colors: [hex, '#ffffff', hex], count: opts.sparks ?? 34, speed: 1.6, size: 0.032, seconds: 1.5, lift: opts.lift ?? 0.9 })));
    if (opts.wave !== false && !this.calmMotion) this.add(new Shockwave(feet, hex, 0.6, 3.4, 1.1, 0.9));
  }

  /**
   * Something the office knows happened at a desk (hired, finished, shipped, sent home, shot): its
   * emoji over the head, sparks, the ring flaring, a shockwave racing out (or closing in with
   * `implode`), and with `beam` a column of light shooting up from the desk.
   */
  deskMoment(id: string, glyph: string, hex: string, head: THREE.Vector3, feet: THREE.Vector3, opts: { beam?: boolean; implode?: boolean; sparks?: number } = {}) {
    this.auras.get(id)?.flare(hex);
    this.add(new GlyphPop(glyph, head.clone().add(new THREE.Vector3(0, 0.55, 0)), 2.8, 1.9, 0.85));
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
  roomWave(center: THREE.Vector3, hex: string, heads: { head: THREE.Vector3; feet: THREE.Vector3; id?: string }[], glyph?: string) {
    if (!this.calmMotion) {
      this.add(new Shockwave(center, hex, 0.5, 26, 2.2, 1));
      this.add(new Shockwave(center, '#ffffff', 0.3, 18, 1.8, 0.45));
    }
    for (const h of heads) {
      const delay = this.calmMotion ? 0 : (Math.hypot(h.feet.x - center.x, h.feet.z - center.z) / 26) * 2.2 * 0.6;
      this.later(delay, () => {
        if (h.id) this.auras.get(h.id)?.flare(hex);
        this.add(new Wrapped(new Sparkles(h.head.clone().add(new THREE.Vector3(0, 0.25, 0)), null, { colors: [hex, '#ffffff'], count: 22, speed: 1.3, size: 0.028, seconds: 1.3, lift: 1.1 })));
        if (glyph) this.add(new GlyphPop(glyph, h.head.clone().add(new THREE.Vector3(0, 0.6, 0)), 2.2, 1.3, 0.6));
      });
    }
  }

  /**
   * Living 3D switched on (a bright ring racing out from you and every desk ring popping in by
   * distance) or off (a gray ring closing in on you as the rings fold away).
   */
  power(on: boolean, from: THREE.Vector3) {
    if (on) {
      if (!this.calmMotion) {
        this.add(new Shockwave(from, '#ff7a1a', 0.4, 30, 2, 1.2));
        this.add(new Shockwave(from, '#ffffff', 0.2, 22, 1.6, 0.6));
      }
      for (const a of this.auras.values()) a.pop(this.calmMotion ? 0 : (a.group.position.distanceTo(from) / 30) * 2 * 0.7);
    } else if (!this.calmMotion) {
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
    for (const [id, a] of this.auras) {
      if (a.update(dt, this.calmMotion)) moving = true;
      else if (a.want === 0 && a.strength === 0 && (!this.on || this.released.has(id))) this.dropAura(id);
    }
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
    fx.setAura('warmup', true, 'emerald', 'flow', 0.5, 0.5);
    fx.update(0.016);
    fx.add(new Shockwave(new THREE.Vector3(), '#ffffff', 1, 2, 1));
    fx.add(new Beam(new THREE.Vector3(), '#ffffff'));
    fx.add(new Crackle(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), '#ffffff'));
    // The emoji pops are text sprites; this one has the same material without needing a canvas.
    fx.group.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, depthTest: false, opacity: 0.01 })));
    fx.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) (o.material as THREE.Material).opacity = 0.01;
    });
    // Off below the floor with the other stand-ins.
    fx.group.position.set(0, -40, 0);
    return fx.group;
  }

  /** Clears every ring and effect at once (changing floors). */
  clear() {
    for (const id of [...this.auras.keys()]) this.dropAura(id);
    this.released.clear();
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
