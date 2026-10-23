import * as THREE from 'three';
import type { CarKind } from './cars';
import { withFinish } from './surface';
import { toon } from './toon';

const REQUIRED = ['CarPaint', 'CarRubber', 'CarMetal', 'CarCarbon', 'CarGlass', 'CarHeadlight', 'CarTaillight', 'CarCaliper'];

/** Replace only the batched fallback. Empty parking anchors keep the original transforms and colors. */
export function installSportsCars(source: THREE.Object3D, root: THREE.Object3D): boolean {
  const parked = root.getObjectByName('parked-cars');
  const fallback = parked?.getObjectByName('parked-car-fallback');
  if (!parked || !fallback) return false;
  const models = new Map<CarKind, THREE.Mesh[]>();
  for (const [kind, name] of [
    ['lambo', 'SportsWedge'],
    ['ferrari', 'SportsCoupe'],
  ] as const) {
    const meshes: THREE.Mesh[] = [];
    source.getObjectByName(name)?.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object);
    });
    if (!meshes.length || meshes.some((mesh) => !(mesh.material instanceof THREE.MeshStandardMaterial))) return false;
    if (meshes.some((mesh) => !mesh.geometry.getAttribute('position')?.count)) return false;
    if (meshes.some((mesh) => ['CarCarbon', 'CarGlass'].includes((mesh.material as THREE.Material).name) && !(mesh.material as THREE.MeshStandardMaterial).map)) return false;
    const names = new Set(meshes.map((mesh) => (mesh.material as THREE.Material).name));
    if (REQUIRED.some((name) => !names.has(name))) return false;
    if (!parked.children.some((object) => object.userData.parkedCar?.kind === kind)) return false;
    models.set(kind, meshes);
  }
  source.updateMatrixWorld(true);
  const sourceInverse = source.matrixWorld.clone().invert();
  const materials = new Map<THREE.Material, THREE.Material>();
  const materialOf = (src: THREE.MeshStandardMaterial) => {
    const hit = materials.get(src);
    if (hit) return hit;
    const flat = ['CarGlass', 'CarHeadlight', 'CarTaillight'].includes(src.name);
    const material = flat
      ? new THREE.MeshBasicMaterial({ color: src.color, map: src.map, side: src.side })
      : withFinish(new THREE.MeshToonMaterial({ color: src.color, map: src.map, gradientMap: (toon('#ffffff') as THREE.MeshToonMaterial).gradientMap, side: src.side }), src.name === 'CarMetal' ? 'metal' : 'paint');
    material.name = src.name;
    material.userData.outlineParameters = { visible: false };
    materials.set(src, material);
    return material;
  };
  const batches = new THREE.Group();
  batches.name = 'sports-car-models';
  for (const [kind, meshes] of models) {
    const anchors = parked.children.filter((object) => object.userData.parkedCar?.kind === kind);
    for (const part of meshes) {
      const src = part.material as THREE.MeshStandardMaterial;
      const instances = new THREE.InstancedMesh(part.geometry, materialOf(src), anchors.length);
      instances.name = `${kind}-${src.name}`;
      const local = new THREE.Matrix4().multiplyMatrices(sourceInverse, part.matrixWorld);
      for (const [i, anchor] of anchors.entries()) {
        anchor.updateMatrix();
        instances.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(anchor.matrix, local));
        if (src.name === 'CarPaint') instances.setColorAt(i, new THREE.Color(anchor.userData.parkedCar.color));
      }
      instances.instanceMatrix.needsUpdate = true;
      if (instances.instanceColor) instances.instanceColor.needsUpdate = true;
      instances.computeBoundingBox();
      instances.computeBoundingSphere();
      batches.add(instances);
    }
  }
  parked.add(batches);
  fallback.removeFromParent();
  fallback.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  return true;
}
