import * as THREE from 'three';
import { toon } from './toon';

/** Replace only the leaf's solids, under the original hinge; keep glass, stripe and controls. */
export function installExitDoor(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const mount = office.getObjectByName('exit-door-hardware');
  const part = source.getObjectByName('ExitDoorLeaf');
  if (!mount || !part) return false;
  const model = part.clone(true);
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (source: THREE.MeshStandardMaterial) => {
    let material = materials.get(source);
    if (!material) {
      material = toon(source.color, source.name === 'DoorRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
      materials.set(source, material);
    }
    return material;
  };
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  mount.clear();
  mount.add(model);
  return true;
}
