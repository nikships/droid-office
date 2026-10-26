import * as THREE from 'three';

export interface RaycastChunk {
  box: THREE.Box3;
  start: number;
  count: number;
}

interface TriangleBounds extends RaycastChunk {
  left?: TriangleBounds;
  right?: TriangleBounds;
}

interface CachedBounds {
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  index: THREE.BufferAttribute | null;
  positionVersion: number;
  indexVersion: number;
  tree: TriangleBounds;
}

const triangleBounds = new WeakMap<THREE.BufferGeometry, CachedBounds>();
const LEAF_VERTICES = 32 * 3;

function positionVersion(position: CachedBounds['position']): number {
  return position instanceof THREE.InterleavedBufferAttribute ? position.data.version : position.version;
}

/** Keep triangle order and the original geometry: a leaf only narrows the exact raycaster's draw range. */
function boundsFor(object: THREE.Object3D): TriangleBounds | null {
  if (!(object instanceof THREE.Mesh) || object.raycast !== THREE.Mesh.prototype.raycast || object.getVertexPosition !== THREE.Mesh.prototype.getVertexPosition || Array.isArray(object.material)) return null;
  const geometry = object.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index?.count ?? position?.count ?? 0;
  if (!position || geometry.morphAttributes.position?.length || count < LEAF_VERTICES * 4 || count % 3 !== 0) return null;
  const version = positionVersion(position);
  const cached = triangleBounds.get(geometry);
  if (cached && cached.position === position && cached.index === index && cached.positionVersion === version && cached.indexVersion === (index?.version ?? 0)) return cached.tree;
  const point = new THREE.Vector3();
  const build = (start: number, count: number): TriangleBounds => {
    const box = new THREE.Box3();
    if (count <= LEAF_VERTICES) {
      for (let i = start; i < start + count; i++) box.expandByPoint(point.fromBufferAttribute(position, index ? index.getX(i) : i));
      return { box, start, count };
    }
    const half = Math.floor(count / 6) * 3;
    const left = build(start, half);
    const right = build(start + half, count - half);
    return { box: box.copy(left.box).union(right.box), start, count, left, right };
  };
  const tree = build(0, count);
  triangleBounds.set(geometry, { position, index, positionVersion: version, indexVersion: index?.version ?? 0, tree });
  return tree;
}

/** Build shared geometry bounds while the loading screen is up, not on the first crosshair query. */
export function preparePicking(root: THREE.Object3D): void {
  root.traverse(boundsFor);
}

function boundedIntersections(mesh: THREE.Mesh, tree: TriangleBounds, ray: THREE.Raycaster, hits: THREE.Intersection[], local: THREE.Ray, inverse: THREE.Matrix4): void {
  const geometry = mesh.geometry;
  const { start, count } = geometry.drawRange;
  // An unusual, non-triangle-aligned range keeps three.js's original iteration semantics.
  if (start % 3 !== 0 || (Number.isFinite(count) && count % 3 !== 0)) {
    mesh.raycast(ray, hits);
    return;
  }
  local.copy(ray.ray).applyMatrix4(inverse.copy(mesh.matrixWorld).invert());
  const visit = (node: TriangleBounds) => {
    if (node.start >= start + count || node.start + node.count <= start || !local.intersectsBox(node.box)) return;
    if (node.left && node.right) {
      visit(node.left);
      visit(node.right);
    } else {
      const first = Math.max(start, node.start);
      geometry.setDrawRange(first, Math.min(start + count, node.start + node.count) - first);
      mesh.raycast(ray, hits);
    }
  };
  try {
    visit(tree);
  } finally {
    geometry.setDrawRange(start, count);
  }
}

/**
 * A static batch keeps its source solids' bounds. Its one large box often contains mostly empty
 * space: only solids touched by the local ray need the usual, exact triangle test.
 */
export function boundStaticRaycast(mesh: THREE.Mesh, chunks: readonly RaycastChunk[]): void {
  if (chunks.length < 2) return;
  const geometry = mesh.geometry;
  const raycast = mesh.raycast;
  const inverse = new THREE.Matrix4();
  const local = new THREE.Ray();
  mesh.raycast = function (ray, hits) {
    if (this.geometry !== geometry) return raycast.call(this, ray, hits);
    local.copy(ray.ray).applyMatrix4(inverse.copy(this.matrixWorld).invert());
    const { start, count } = geometry.drawRange;
    try {
      for (const chunk of chunks) {
        if (!local.intersectsBox(chunk.box)) continue;
        const first = Math.max(start, chunk.start);
        const end = Math.min(start + count, chunk.start + chunk.count);
        if (end <= first) continue;
        geometry.setDrawRange(first, end - first);
        raycast.call(this, ray, hits);
      }
    } finally {
      geometry.setDrawRange(start, count);
    }
  };
}

/**
 * Raycaster's traversal, but hidden subtrees cannot be hit. Filtering only after intersectObjects
 * still tests all their triangles, including the detailed models kept out of sight for shader warmup.
 */
export function visibleIntersections(ray: THREE.Raycaster, roots: readonly THREE.Object3D[]): THREE.Intersection[] {
  const hits: THREE.Intersection[] = [];
  const local = new THREE.Ray();
  const inverse = new THREE.Matrix4();
  const visit = (object: THREE.Object3D) => {
    if (!object.visible) return;
    if (object.layers.test(ray.layers)) {
      const tree = boundsFor(object);
      if (tree) boundedIntersections(object as THREE.Mesh, tree, ray, hits, local, inverse);
      else {
        const propagate: unknown = object.raycast(ray, hits);
        if (propagate === false) return;
      }
    }
    for (const child of object.children) visit(child);
  };
  for (const root of roots) visit(root);
  return hits.sort((a, b) => a.distance - b.distance);
}
