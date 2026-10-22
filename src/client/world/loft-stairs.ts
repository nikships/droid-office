import * as THREE from 'three';
import { STAIRS } from '../../shared/layout';
import { toon } from './toon';

/** Replace only static stair geometry. The original fifteen colliders and side barrier stay put. */
export function installLoftStairs(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const stairs = office.getObjectByName('loft-stairs');
  const part = source.getObjectByName('LoftStairs');
  if (!stairs || !part) return false;
  const model = part.clone(true);
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (source: THREE.MeshStandardMaterial) => {
    let material = materials.get(source);
    if (!material) {
      material = toon(source.color, source.name === 'StairSignal' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
      materials.set(source, material);
    }
    return material;
  };
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  model.position.set(STAIRS.fromX, 0, STAIRS.minZ);
  stairs.clear();
  stairs.add(model);
  return true;
}
