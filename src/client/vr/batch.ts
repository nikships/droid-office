/**
 * VR-only static batching. Chrome on Android XR draws each eye separately, so every mesh costs
 * two draw calls; the office's ~1,700 small meshes were the frame (measured on Galaxy XR: merging
 * by material cut 1,483 draws per eye to 622 and raised the frame rate from about 21 to 32 fps).
 * While presenting, meshes that share a material and draw state are merged into one world-space
 * mesh each. A multi-material mesh (a box with a textured face) splits into one piece per geometry
 * group, and each piece merges under its own material. Transparent meshes merge only when their
 * layers look the same in any order (flatLayer: the office's glass and shine panes).
 *
 * The originals stay in the scene for everything but drawing: they move to SOURCE_LAYER, which no
 * camera renders but the VR raycaster tests, so picking, `userData.interact` and reach work as
 * before, and the merged meshes never answer a raycast. A merged mesh shares its sources'
 * material, so color, opacity and texture changes still show.
 *
 * Only meshes that hold still through a short watch window are merged, so animated things (worker
 * models, the jukebox, doors) never are. A merged source that later moves, hides or swaps material
 * is dropped from batching for the session and its batches (with every batch sharing a mesh with
 * them, so no mesh is left half drawn) rebuild without it; the root hiding (a
 * trip to the roof) or a source leaving the scene (a floor change) restarts the whole process.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Where batched originals live: out of every camera's mask, still on the VR raycaster's. */
export const SOURCE_LAYER = 5;
/** A mesh must hold still this long before it is merged. */
const WATCH_MS = 1500;
/** A broken batch waits this long for other changes before the rebuild (one hitch, not many). */
const REBUILD_MS = 1500;
/** Sources re-checked per frame (round-robin), so a changed one is caught within a few frames. */
const CHECKS_PER_FRAME = 150;

interface Source {
  mesh: THREE.Mesh;
  matrix: THREE.Matrix4;
  /** The material, or each slot of a material array, when merged. */
  materials: THREE.Material[];
  /** Each material's stamp() when merged. */
  stamps: string[];
  parent: THREE.Object3D | null;
}

/** What one merged mesh draws of a source: all of it, or one geometry group of a multi-material mesh. */
export interface Piece {
  mesh: THREE.Mesh;
  group?: THREE.GeometryGroup;
  /** Baked into a vertex color when the merged mesh draws with a shared white material. */
  tint?: THREE.Color;
}

interface Batch {
  merged: THREE.Mesh;
  meshes: THREE.Mesh[];
  pieces: number;
}

type MeshLike = {
  isMesh?: boolean;
  isSkinnedMesh?: boolean;
  isInstancedMesh?: boolean;
  material: THREE.Material | THREE.Material[];
  geometry: THREE.BufferGeometry;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  userData: Record<string, unknown>;
  onBeforeRender?: unknown;
};

/** The mesh-level part of a batch key, or null when the mesh must draw on its own whatever its material. */
function meshKey(mesh: MeshLike): string | null {
  if (!mesh.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh) return null;
  const g = mesh.geometry;
  if (!g?.attributes.position || Object.keys(g.morphAttributes).length) return null;
  // A partial draw range (something drawn part-way) would merge whole.
  if (g.drawRange.start !== 0 || Number.isFinite(g.drawRange.count)) return null;
  // Canvas panels and grabbables stay separate; so does anything with its own draw hook.
  if (mesh.userData.panel || mesh.userData.grabbable) return null;
  if (mesh.onBeforeRender !== undefined && mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return null;
  const attrs = Object.keys(g.attributes)
    .sort()
    .map((n) => `${n}${g.attributes[n].itemSize}${(g.attributes[n] as THREE.BufferAttribute).normalized ? 'n' : ''}`)
    .join(',');
  return `${attrs}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${mesh.renderOrder}`;
}

const opaque = (m: THREE.Material | undefined): m is THREE.Material => !!m && !m.transparent && !m.alphaHash;

/**
 * A transparent material whose layers look the same in any order: one flat color and opacity (no
 * texture, no vertex colors), normal or additive blending, and no depth writes. Two layers of
 * the same color c and alpha a blend to the same pixel either way round, so the office's window
 * glass and shine panes can merge per material even though a merged mesh can't sort its own
 * triangles. Other transparents sort per object and draw alone.
 */
function flatLayer(m: THREE.Material | undefined): m is THREE.Material {
  if (!m?.transparent || m.depthWrite || m.alphaHash || m.vertexColors) return false;
  if (m.blending !== THREE.NormalBlending && m.blending !== THREE.AdditiveBlending) return false;
  const r = m as THREE.MeshBasicMaterial;
  return !r.map && !r.alphaMap;
}

const mergeable = (m: THREE.Material | undefined): m is THREE.Material => opaque(m) || flatLayer(m);

/** Fields that never change how a material draws, or (color) that merging bakes into the geometry. */
const LOOK_SKIP = new Set(['uuid', 'id', 'name', 'version', 'userData', 'color', '_listeners']);

/**
 * Everything about a material but its color, or null when it can't be compared field by field
 * (vertex colors of its own, or a per-material shader hook). Materials that differ only in color
 * (the office's many toon colors) then draw as one, with each piece's color in the vertices.
 */
export function lookKey(m: THREE.Material): string | null {
  const rec = m as unknown as Record<string, unknown>;
  if (rec.vertexColors || !(rec.color instanceof THREE.Color)) return null;
  const parts: string[] = [];
  for (const k of Object.keys(rec).sort()) {
    if (LOOK_SKIP.has(k)) continue;
    const v = rec[k] as { isTexture?: boolean; isColor?: boolean; uuid?: string; getHexString?: () => string; toArray?: () => number[] } | null | undefined;
    if (typeof v === 'function') return null;
    if (v === null || typeof v !== 'object') parts.push(`${k}=${String(v)}`);
    else if (v.isTexture) parts.push(`${k}=${v.uuid}`);
    else if (v.isColor) parts.push(`${k}=${v.getHexString!()}`);
    else if (typeof v.toArray === 'function') parts.push(`${k}=${v.toArray().join(',')}`);
    else parts.push(`${k}=${JSON.stringify(v)}`);
  }
  return `${m.type}{${parts.join(';')}}`;
}

/**
 * What a merged mesh has to notice changing in a source's material: a recompile (version), and the
 * color, emissive and opacity, which change without one.
 */
function stamp(m: THREE.Material): string {
  const r = m as THREE.Material & { color?: THREE.Color; emissive?: THREE.Color };
  return `${m.version}|${r.color?.getHex() ?? ''}|${r.emissive?.getHex() ?? ''}|${m.opacity}`;
}

/**
 * The look an opaque material merges under with others of other colors. Never for a transparent
 * one: layers of different colors blend differently depending on order (see flatLayer).
 */
const lookOf = (m: THREE.Material): string | null => (opaque(m) ? lookKey(m) : null);

/** The material part of a piece's key: its look when it has one, else the material itself. */
function materialKey(m: THREE.Material): string {
  const look = lookOf(m);
  return look ? `look:${look}` : `mat:${m.uuid}`;
}

/**
 * The draw state a single-material mesh can share a merged mesh under, or null when it must draw
 * on its own (material arrays go through pieceKeys). Pure over plain fields, so the host tests drive it.
 */
export function batchKey(mesh: MeshLike): string | null {
  if (Array.isArray(mesh.material) || !mergeable(mesh.material)) return null;
  const k = meshKey(mesh);
  return k && `${materialKey(mesh.material)}|${k}`;
}

/**
 * One key per piece a mesh merges as: the whole mesh for one material, each geometry group for a
 * material array (a box with a textured front is six pieces). Null when any piece can't merge,
 * since a mesh either draws itself or is drawn entirely by merged meshes.
 */
export function pieceKeys(mesh: MeshLike): string[] | null {
  if (!Array.isArray(mesh.material)) {
    const k = batchKey(mesh);
    return k ? [k] : null;
  }
  const k = meshKey(mesh);
  const groups = mesh.geometry.groups;
  if (!k || !groups.length) return null;
  const mats = mesh.material;
  const keys: string[] = [];
  for (const g of groups) {
    const m = mats[g.materialIndex ?? 0];
    if (!mergeable(m)) return null;
    keys.push(`${materialKey(m)}|${k}`);
  }
  return keys;
}

/** The pieces pieceKeys keyed, in the same order. */
function pieces(mesh: THREE.Mesh): Piece[] {
  return Array.isArray(mesh.material) ? mesh.geometry.groups.map((group) => ({ mesh, group })) : [{ mesh }];
}

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] => (Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material]);
const pieceMaterial = (p: Piece): THREE.Material => (Array.isArray(p.mesh.material) ? p.mesh.material[p.group?.materialIndex ?? 0] : p.mesh.material);

/** Whether `o` still hangs under `root` with every link visible. */
function shownUnder(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return false;
}

const range = (start: number, end: number): number[] => Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);

/**
 * Merges pieces of the same draw state into one world-space geometry, or null if they won't merge.
 * A group piece keeps only its own triangles (the vertices come along whole; boxes are tiny).
 */
export function mergeWorld(parts: readonly Piece[]): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const { mesh, group, tint } of parts) {
    const g = mesh.geometry.clone();
    if (group) {
      const n = g.index ? g.index.count : g.attributes.position.count;
      const end = Math.min(n, group.start + group.count);
      g.setIndex(g.index ? Array.from(g.index.array.slice(group.start, end)) : range(group.start, end));
    }
    g.clearGroups();
    if (tint) {
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) tint.toArray(c, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    g.applyMatrix4(mesh.matrixWorld);
    // A mirrored transform flips the winding; merged front faces must still face out.
    if (mesh.matrixWorld.determinant() < 0) {
      if (!g.index) g.setIndex(range(0, g.attributes.position.count));
      const idx = g.index!.array;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const t = idx[i + 1];
        idx[i + 1] = idx[i + 2];
        idx[i + 2] = t;
      }
    }
    geos.push(g);
  }
  // mergeGeometries wants all indexed or none; the steps above index some.
  if (geos.some((g) => g.index)) for (const g of geos) if (!g.index) g.setIndex(range(0, g.attributes.position.count));
  const merged = geos.length ? mergeGeometries(geos, false) : null;
  for (const g of geos) g.dispose();
  return merged;
}

export class StaticBatcher {
  private batches: Batch[] = [];
  /** Every merged mesh a source feeds (a multi-material mesh feeds one per material). */
  private bySource = new Map<THREE.Mesh, Set<Batch>>();
  private all: Source[] = [];
  /** Meshes that moved, hid or changed once this session: never merged again. */
  private dynamic = new WeakSet<THREE.Mesh>();
  /** Candidates under watch: their matrix and material stamps when the watch started. */
  private watch = new Map<THREE.Mesh, { matrix: THREE.Matrix4; stamps: string[] }>();
  /** One white, vertex-colored material per look (see lookKey), shared by every merged mesh of it. */
  private looks = new Map<string, THREE.Material>();
  private watchUntil = 0;
  private rebuildAt = 0;
  private root: THREE.Object3D | null = null;
  private cursor = 0;
  private pieceCount = 0;
  private group = new THREE.Group();

  constructor(private scene: THREE.Scene) {
    this.group.name = 'vr-static-batches';
    this.group.matrixAutoUpdate = false;
  }

  /** Draw calls saved (pieces batched minus merged meshes), for the perf hooks. */
  get saved(): number {
    return this.pieceCount - this.batches.length;
  }

  get meshes(): number {
    return this.batches.length;
  }

  /** Whether a mesh moved or changed while presenting and so draws itself for the session. */
  isDynamic(mesh: THREE.Mesh): boolean {
    return this.dynamic.has(mesh);
  }

  /**
   * One frame. `root` is what to batch (the current floor's office, or null for nothing, e.g. up
   * on the roof). Returns true when the drawn geometry changed, so the caller can re-bake shadows.
   */
  update(root: THREE.Object3D | null, now: number): boolean {
    const next = root?.visible ? root : null;
    if (next !== this.root) {
      const had = this.batches.length > 0;
      this.clear();
      this.root = next;
      if (this.root) this.startWatch(now);
      return had;
    }
    if (!this.root) return false;
    if (this.watchUntil && now >= this.watchUntil) {
      this.watchUntil = 0;
      this.build();
      return true;
    }
    if (this.rebuildAt && now >= this.rebuildAt) {
      this.rebuildAt = 0;
      this.clear();
      this.startWatch(now);
      return true;
    }
    return this.check(now);
  }

  private startWatch(now: number): void {
    const root = this.root!;
    root.updateWorldMatrix(true, true);
    this.watch.clear();
    const walk = (o: THREE.Object3D) => {
      if (!o.visible) return;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !this.dynamic.has(mesh) && mesh.layers.isEnabled(0) && pieceKeys(mesh)) this.watch.set(mesh, { matrix: mesh.matrixWorld.clone(), stamps: materialsOf(mesh).map(stamp) });
      for (const c of o.children) walk(c);
    };
    walk(root);
    this.watchUntil = now + WATCH_MS;
  }

  private build(): void {
    const root = this.root!;
    root.updateWorldMatrix(true, true);
    const groups = new Map<string, Piece[]>();
    const meshes: THREE.Mesh[] = [];
    for (const [mesh, was] of this.watch) {
      if (!shownUnder(mesh, root)) continue;
      // Moving, or a material that pulses or recolors: it draws itself.
      if (!mesh.matrixWorld.equals(was.matrix) || !sameStamps(mesh, was.stamps)) {
        this.dynamic.add(mesh);
        continue;
      }
      const keys = pieceKeys(mesh);
      if (!keys) continue;
      meshes.push(mesh);
      const parts = pieces(mesh);
      keys.forEach((key, i) => {
        let list = groups.get(key);
        if (!list) groups.set(key, (list = []));
        list.push(parts[i]);
      });
    }
    this.watch.clear();
    // Every piece of a multi-material mesh gets a merged mesh, even alone under its key: once the
    // mesh stops drawing itself, the merged meshes are all that draw it. A lone single-material
    // mesh gains nothing and just keeps drawing itself.
    const merged = new Set<THREE.Mesh>();
    const failed = new Set<THREE.Mesh>();
    for (const parts of groups.values()) {
      if (parts.length < 2 && !parts[0].group) continue;
      if (lookOf(pieceMaterial(parts[0]))) for (const p of parts) p.tint = new THREE.Color().copy((pieceMaterial(p) as THREE.MeshBasicMaterial).color);
      const geo = mergeWorld(parts);
      if (!geo) {
        for (const p of parts) failed.add(p.mesh);
        continue;
      }
      const src = parts[0];
      const mesh = new THREE.Mesh(geo, this.materialFor(pieceMaterial(src)));
      mesh.castShadow = src.mesh.castShadow;
      mesh.receiveShadow = src.mesh.receiveShadow;
      mesh.renderOrder = src.mesh.renderOrder;
      mesh.matrixAutoUpdate = false;
      // The originals answer rays; a merged mesh has no userData.interact to answer with.
      mesh.raycast = () => {};
      mesh.name = `batch:${parts.length}`;
      const batch: Batch = { merged: mesh, meshes: [...new Set(parts.map((p) => p.mesh))], pieces: parts.length };
      for (const m of batch.meshes) {
        let set = this.bySource.get(m);
        if (!set) this.bySource.set(m, (set = new Set()));
        set.add(batch);
        merged.add(m);
      }
      this.pieceCount += parts.length;
      this.batches.push(batch);
      this.group.add(mesh);
    }
    for (const m of meshes) {
      if (!merged.has(m)) continue;
      const materials = materialsOf(m);
      this.all.push({ mesh: m, matrix: m.matrixWorld.clone(), materials, stamps: materials.map(stamp), parent: m.parent });
      m.layers.set(SOURCE_LAYER);
    }
    // A mesh missing a piece can't be drawn by its merged meshes alone.
    for (const m of failed) if (this.bySource.has(m)) this.breakFor(m);
    if (this.batches.length) this.scene.add(this.group);
    this.cursor = 0;
  }

  /** Round-robin: a source that changed goes back to drawing itself, and its batches rebuild later. */
  private check(now: number): boolean {
    if (!this.all.length) return false;
    const root = this.root!;
    let changed = false;
    const n = Math.min(CHECKS_PER_FRAME, this.all.length);
    for (let i = 0; i < n && this.all.length; i++) {
      this.cursor %= this.all.length;
      const s = this.all[this.cursor++];
      if (!this.bySource.has(s.mesh)) continue;
      const gone = s.mesh.parent !== s.parent || !this.inTree(s.mesh, root);
      const moved = !gone && (!shownUnder(s.mesh, root) || !sameMaterials(s.mesh, s.materials) || !sameStamps(s.mesh, s.stamps) || !s.mesh.matrixWorld.equals(s.matrix));
      if (!gone && !moved) continue;
      if (moved) this.dynamic.add(s.mesh);
      this.breakFor(s.mesh);
      this.rebuildAt ||= now + REBUILD_MS;
      changed = true;
    }
    return changed;
  }

  /**
   * What a merged mesh draws with: a source's own material, or for a material with a look, the
   * look's shared white copy that takes each piece's color from the vertices.
   */
  private materialFor(m: THREE.Material): THREE.Material {
    const look = lookOf(m);
    if (!look) return m;
    let shared = this.looks.get(look);
    if (!shared) {
      shared = m.clone();
      (shared as THREE.MeshBasicMaterial).color.set(0xffffff);
      shared.vertexColors = true;
      shared.name = `batch-look:${m.name}`;
      this.looks.set(look, shared);
    }
    return shared;
  }

  private inTree(o: THREE.Object3D, root: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
    return false;
  }

  /**
   * Breaks every batch the mesh feeds, and every batch those batches' other meshes feed, so no
   * multi-material mesh is left half drawn: all of them draw themselves again, right away.
   */
  private breakFor(start: THREE.Mesh): void {
    const doomed = new Set<Batch>();
    const freed = new Set<THREE.Mesh>();
    const todo = [start];
    while (todo.length) {
      const m = todo.pop()!;
      if (freed.has(m)) continue;
      freed.add(m);
      for (const b of this.bySource.get(m) ?? []) {
        if (doomed.has(b)) continue;
        doomed.add(b);
        todo.push(...b.meshes);
      }
    }
    for (const b of doomed) {
      b.merged.removeFromParent();
      b.merged.geometry.dispose();
      this.pieceCount -= b.pieces;
    }
    for (const m of freed) {
      m.layers.set(0);
      this.bySource.delete(m);
    }
    this.batches = this.batches.filter((b) => !doomed.has(b));
    this.all = this.all.filter((s) => this.bySource.has(s.mesh));
  }

  /** Every original draws itself again and the merged meshes go (session end, root change). */
  clear(): void {
    for (const s of this.all) s.mesh.layers.set(0);
    for (const b of this.batches) b.merged.geometry.dispose();
    this.group.clear();
    this.group.removeFromParent();
    this.batches = [];
    this.bySource.clear();
    this.all = [];
    this.watch.clear();
    this.watchUntil = 0;
    this.rebuildAt = 0;
    this.cursor = 0;
    this.pieceCount = 0;
    for (const m of this.looks.values()) m.dispose();
    this.looks.clear();
  }

  /** Session end: put everything back and forget which meshes moved. */
  reset(): void {
    this.clear();
    this.root = null;
    this.dynamic = new WeakSet();
  }
}

function sameStamps(mesh: THREE.Mesh, was: readonly string[]): boolean {
  const now = materialsOf(mesh);
  return now.length === was.length && now.every((m, i) => stamp(m) === was[i]);
}

function sameMaterials(mesh: THREE.Mesh, was: readonly THREE.Material[]): boolean {
  const now = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return now.length === was.length && now.every((m, i) => m === was[i]);
}
