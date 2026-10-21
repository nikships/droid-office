import * as THREE from 'three';

export interface RaycastChunk {
  box: THREE.Box3;
  start: number;
  count: number;
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
  const visit = (object: THREE.Object3D) => {
    if (!object.visible) return;
    if (object.layers.test(ray.layers)) {
      const propagate: unknown = object.raycast(ray, hits);
      if (propagate === false) return;
    }
    for (const child of object.children) visit(child);
  };
  for (const root of roots) visit(root);
  return hits.sort((a, b) => a.distance - b.distance);
}
