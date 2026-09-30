/**
 * Faster VR picking. Each controller ray is tested against every mesh in the office (about 1,500)
 * every other frame; on Galaxy XR that cost 5-8 ms a pick, most of it walking every triangle of a
 * dozen detailed meshes (2k-7k triangles each) that the ray's bounding-sphere test let through.
 *
 * While presenting, meshes over TRI_MIN triangles get a bounding volume hierarchy
 * (three-mesh-bvh), built a few per frame so entering VR never hitches, and their raycast then
 * only visits the triangles near the ray. Hits are the same as three's: point, distance, face and
 * uv (the issues board picks a note by uv). The BVH is built in indirect mode, so the geometry's
 * index and groups are left exactly as they were. A tree is a snapshot of its geometry: this is
 * for the office's fixed furniture, whose vertices never change after they are built.
 *
 * three-mesh-bvh loads on the first session, so the desktop bundle never carries it.
 */

import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

/** Below this, three's own triangle loop is as fast as walking a tree. */
export const TRI_MIN = 256;
/** Build time per frame (ms): a big mesh may run over once, then the queue waits a frame. */
const BUILD_MS = 2;

const trees = new WeakMap<THREE.BufferGeometry, MeshBVH>();
type Bvh = typeof import('three-mesh-bvh').MeshBVH;
let Tree: Bvh | null = null;
let loading: Promise<void> | null = null;

/** Starts loading the tree builder (once); trees build from the frame after it lands. */
function load(): void {
  loading ??= import('three-mesh-bvh')
    .then((m) => {
      Tree = m.MeshBVH;
    })
    .catch(() => {
      // Picking stays on three's own raycast; the next session tries again.
      loading = null;
    });
}

/** For the host tests, which build trees straight away. */
export async function loadTrees(): Promise<void> {
  load();
  await loading;
}
const _sphere = new THREE.Sphere();

/** Triangles a mesh's geometry draws. */
export function triangles(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
}

/** Whether a mesh is worth a tree: a plain mesh with enough triangles, and geometry that never changes shape. */
export function wantsTree(o: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh & { isSkinnedMesh?: boolean; isBatchedMesh?: boolean };
  if (!m.isMesh || m.isSkinnedMesh || m.isBatchedMesh) return false;
  const g = m.geometry;
  if (!g?.attributes.position || Object.keys(g.morphAttributes).length) return false;
  return triangles(g) >= TRI_MIN;
}

/**
 * three's Mesh.raycast, with the triangle walk swapped for the tree once the geometry has one.
 * The bounding-sphere cull runs first, as in three, so the ~1,500 meshes a ray misses stay cheap.
 */
function treeRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]): void {
  const tree = trees.get(this.geometry);
  if (!tree || this.material === undefined) {
    THREE.Mesh.prototype.raycast.call(this, raycaster, hits);
    return;
  }
  const g = this.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  _sphere.copy(g.boundingSphere!).applyMatrix4(this.matrixWorld);
  if (!raycaster.ray.intersectsSphere(_sphere)) return;
  tree.raycastObject3D(this, raycaster, hits);
}

export class RayAccel {
  private queue: THREE.Mesh[] = [];
  private root: THREE.Object3D | null = null;
  /** Meshes whose raycast this swapped, so a session end can put three's back. */
  private patched = new Set<THREE.Mesh>();

  /** Trees built so far this session, for the perf hooks. */
  get built(): number {
    return this.patched.size;
  }

  /**
   * One frame: (re)scan when the root changes, then build trees within the frame's budget. `root`
   * is what the VR rays test (the office, or the roof's pickables' parent).
   */
  update(root: THREE.Object3D | null): void {
    if (root !== this.root) {
      this.root = root;
      this.queue = [];
      if (root) this.scan(root);
    }
    if (!this.queue.length) return;
    if (!Tree) {
      load();
      return;
    }
    const until = performance.now() + BUILD_MS;
    while (this.queue.length && performance.now() < until) {
      const mesh = this.queue.pop()!;
      const g = mesh.geometry;
      // A geometry swapped or grown since it was queued goes back through the scan next time.
      if (!wantsTree(mesh)) continue;
      if (!trees.has(g)) {
        try {
          trees.set(g, new Tree(g, { indirect: true }));
        } catch {
          continue;
        }
      }
      this.patch(mesh);
    }
  }

  private scan(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (!wantsTree(o) || this.patched.has(o)) return;
      // Meshes sharing a geometry share its tree: the first one queued builds it.
      if (trees.has(o.geometry)) this.patch(o);
      else this.queue.push(o);
    });
    // Popped from the end, so smallest first: the cheap ones finish quickly, the big ones get whole frames.
    this.queue.sort((a, b) => triangles(b.geometry) - triangles(a.geometry));
  }

  private patch(mesh: THREE.Mesh): void {
    // Only meshes on three's own raycast: a mesh with its own (merged batches, panels) keeps it.
    if (Object.hasOwn(mesh, 'raycast')) return;
    mesh.raycast = treeRaycast;
    this.patched.add(mesh);
  }

  /** Session end: every mesh back on three's raycast. The trees stay with their geometries for next time. */
  reset(): void {
    for (const m of this.patched) if (m.raycast === treeRaycast) delete (m as { raycast?: unknown }).raycast;
    this.patched.clear();
    this.queue = [];
    this.root = null;
  }
}
