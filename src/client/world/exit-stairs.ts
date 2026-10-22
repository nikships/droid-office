import * as THREE from 'three';
import { EXIT_STAIRS } from '../../shared/layout';
import { toon } from './toon';

/** Keep the original moving ground parent, landing/step colliders, rail barriers and exit door. */
export function installExitStairs(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const stairs = office.getObjectByName('exit-stairs');
  const part = source.getObjectByName('ExitStairs');
  if (!stairs || !part) return false;
  const model = part.clone(true);
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (source: THREE.MeshStandardMaterial) => {
    let material = materials.get(source);
    if (!material) {
      material = toon(source.color, source.metalness > 0.5 ? { finish: 'metal' } : {});
      materials.set(source, material);
    }
    return material;
  };
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  model.position.set((EXIT_STAIRS.minX + EXIT_STAIRS.maxX) / 2, 0, EXIT_STAIRS.landingZ0);
  stairs.clear();
  stairs.add(model);
  return true;
}
