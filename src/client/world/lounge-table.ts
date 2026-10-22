import * as THREE from 'three';
import { toon } from './toon';

/** Swap only the coffee table's static geometry, retaining its mount and collider. */
export function installLoungeTable(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const table = office.getObjectByName('lounge-table');
  const part = source.getObjectByName('LoungeTable');
  if (!table || !part) return false;
  const model = part.clone(true);
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (source: THREE.MeshStandardMaterial) => {
    let material = materials.get(source);
    if (!material) {
      material = toon(source.color, source.name === 'TableRubber' || source.name === 'TableSignal' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
      materials.set(source, material);
    }
    return material;
  };
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  table.clear();
  table.add(model);
  return true;
}
