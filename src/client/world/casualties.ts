import * as THREE from 'three';
import { WALL_HEIGHT } from '../../shared/layout';
import { isTeamKitGeometry } from './team-kit';

/** A charged dismissal lifts the worker straight through the ceiling. No downed or revival phase. */
export const BEAM_TIME = 0.8;
export const ASCEND_TIME = 3.6;
export const FADE_TIME = 0.7;
export const ASCEND_HEIGHT = WALL_HEIGHT + 2;
const LAPTOP_GONE = 0.3;

export type CasualtyPhase = 'beam' | 'ascend' | 'fade';
export type CasualtyLook = 'blood' | 'spell';

export interface CasualtyModel {
  readonly root: THREE.Group;
  update(dt: number, t: number): void;
  die(asleep?: boolean): void;
  dispose(): void;
}

export interface CasualtyLaptop {
  readonly root: THREE.Object3D;
  shut(dt: number): boolean;
  dispose(): void;
}
/** Polar disc on XZ whose vertex RGB falls smoothly to zero at `radius`, leaving no hard floor rim. */
function softPoolGeometry(radius: number, rings = 8, segs = 40): THREE.BufferGeometry {
  const verts = 1 + rings * segs;
  const pos = new Float32Array(verts * 3);
  const norm = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  norm[1] = 1;
  col[0] = col[1] = col[2] = 1;
  for (let r = 1; r <= rings; r++) {
    const u = r / rings;
    const w = Math.cos(u * Math.PI * 0.5) ** 2.4;
    const base = 1 + (r - 1) * segs;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const idx = (base + s) * 3;
      pos[idx] = Math.cos(a) * u * radius;
      pos[idx + 1] = 0;
      pos[idx + 2] = Math.sin(a) * u * radius;
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

/** Open tapered column whose vertex RGB fades smoothly to zero where it meets the floor. */
function softColumnGeometry(topR: number, botR: number, height: number, segs: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(topR, botR, height, segs, 12, true);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = THREE.MathUtils.clamp((pos.getY(i) + height / 2) / height, 0, 1);
    const w = THREE.MathUtils.smoothstep(v, 0, 0.14) * (1 - 0.25 * v);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = w;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** A soft white-gold column and a feathered pool of light, with private resources for each ascent. */
function heavenlyBeam(height: number) {
  const root = new THREE.Group();
  root.name = 'heavenly-beam';
  const materials: THREE.MeshBasicMaterial[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const add = (geometry: THREE.BufferGeometry, color: string, opacity: number, name: string) => {
    const material = new THREE.MeshBasicMaterial({ color, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    material.userData.opacity = opacity;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    root.add(mesh);
    materials.push(material);
    geometries.push(geometry);
    return mesh;
  };
  add(softColumnGeometry(0.65, 1.35, height, 40), '#ffe6ad', 0.11, 'beam-column').position.y = height / 2;
  add(softColumnGeometry(0.28, 0.95, height, 32), '#fff9e8', 0.14, 'beam-core').position.y = height / 2;
  add(softPoolGeometry(1.6), '#fff2cc', 0.22, 'beam-pool').position.y = 0.006;
  const light = new THREE.PointLight('#fff2cc', 0, 4, 2);
  light.position.y = 1.2;
  root.add(light);
  return { root, materials, geometries, light };
}

/** Warm the beam's materials without adding another light to the warmup's chosen count. */
export function casualtyMarkers(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'casualty-markers';
  const beam = heavenlyBeam(4);
  beam.light.removeFromParent();
  group.add(beam.root);
  return group;
}

interface Casualty {
  model: CasualtyModel;
  phase: CasualtyPhase;
  t: number;
  from: THREE.Vector3;
  ground: number;
  supine: number;
  rotation: THREE.Quaternion;
  laptop: CasualtyLaptop | null;
  lgone: number;
  beam: ReturnType<typeof heavenlyBeam>;
}

const smooth = (p: number) => {
  const u = THREE.MathUtils.clamp(p, 0, 1);
  return u * u * (3 - 2 * u);
};
const SUPINE = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const vertex = new THREE.Vector3();

/** The body's lowest visible vertex relative to its origin, used to keep its turning pose clear. */ function reach(root: THREE.Object3D, pose: THREE.Quaternion): number | null {
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
    private ground: (x: number, z: number, y: number) => number,
  ) {}

  get active(): boolean {
    return this.all.size > 0;
  }

  phaseOf(id: string): CasualtyPhase | null {
    return this.all.get(id)?.phase ?? null;
  }

  /** Takes ownership of a dismissed worker and laptop, beginning the beam immediately. */
  ascend(id: string, model: CasualtyModel, laptop: CasualtyLaptop, look: CasualtyLook = 'blood'): boolean {
    if (this.all.has(id)) return false;
    model.die(look === 'spell');
    const from = model.root.getWorldPosition(new THREE.Vector3());
    const rotation = model.root.getWorldQuaternion(new THREE.Quaternion());
    const scale = model.root.getWorldScale(new THREE.Vector3());
    this.parent.add(model.root);
    model.root.position.copy(from);
    model.root.quaternion.copy(rotation);
    model.root.scale.copy(scale);
    let ground = this.ground(from.x, from.z, from.y);
    if (!Number.isFinite(ground)) ground = from.y;
    const supine = Math.max(from.y, ground + (reach(model.root, SUPINE) ?? 0));
    const beam = heavenlyBeam(ASCEND_HEIGHT);
    beam.root.position.set(from.x, ground + 0.025, from.z);
    this.parent.add(beam.root);
    model.root.traverse((object) => {
      if ((object as THREE.Sprite).isSprite) object.visible = false;
    });
    this.all.set(id, { model, phase: 'beam', t: 0, from, ground, supine, rotation, laptop, lgone: 0, beam });
    return true;
  }

  clear() {
    for (const c of this.all.values()) this.dispose(c);
    this.all.clear();
  }

  update(dt: number, t: number) {
    for (const [id, c] of this.all) {
      this.step(c, dt);
      c.model.update(dt, t);
      if (c.laptop) this.closeLaptop(c, dt);
      if (c.phase === 'fade' && c.t >= FADE_TIME) {
        this.dispose(c);
        this.all.delete(id);
      }
    }
  }

  private step(c: Casualty, dt: number) {
    c.t += dt;
    const { root } = c.model;
    switch (c.phase) {
      case 'beam': {
        const p = smooth(c.t / BEAM_TIME);
        this.beamOpacity(c, p);
        root.quaternion.slerpQuaternions(c.rotation, SUPINE, p);
        const clear = reach(root, root.quaternion);
        root.position.y = Math.max(root.position.y, THREE.MathUtils.lerp(c.from.y, c.supine, p), clear === null ? -Infinity : c.ground + clear);
        if (c.t >= BEAM_TIME) {
          c.supine = Math.max(c.supine, root.position.y);
          c.phase = 'ascend';
          c.t = 0;
        }
        return;
      }
      case 'ascend': {
        const p = THREE.MathUtils.clamp(c.t / ASCEND_TIME, 0, 1);
        root.position.y = c.supine + ASCEND_HEIGHT * p * p;
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

  private beamOpacity(c: Casualty, value: number) {
    for (const material of c.beam.materials) material.opacity = (material.userData.opacity as number) * value;
    c.beam.light.intensity = value * 2;
  }

  private closeLaptop(c: Casualty, dt: number) {
    const laptop = c.laptop!;
    if (!laptop.shut(dt)) return;
    c.lgone = Math.min(1, c.lgone + dt / LAPTOP_GONE);
    laptop.root.scale.setScalar(Math.max(0.001, 1 - c.lgone * c.lgone));
    if (c.lgone >= 1) this.dropLaptop(c);
  }

  private dropLaptop(c: Casualty) {
    if (!c.laptop) return;
    c.laptop.root.removeFromParent();
    c.laptop.dispose();
    c.laptop = null;
  }

  private dispose(c: Casualty) {
    c.beam.root.removeFromParent();
    for (const geometry of c.beam.geometries) geometry.dispose();
    for (const material of c.beam.materials) material.dispose();
    c.beam.light.dispose();
    this.dropLaptop(c);
    c.model.root.removeFromParent();
    const geometry = new Set<THREE.BufferGeometry>();
    c.model.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) geometry.add((object as THREE.Mesh).geometry);
    });
    c.model.dispose();
    for (const item of geometry) if (!isTeamKitGeometry(item)) item.dispose();
  }
}
