import * as THREE from 'three';
import { toon } from './toon';

/** Keep the existing bistro-table mount, collider and neighboring stools. */
export function installBalconyTable(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const table = office.getObjectByName('balcony-table');
  const part = source.getObjectByName('BalconyTable');
  if (!table || !part) return false;
  const model = part.clone(true);
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (source: THREE.MeshStandardMaterial) => {
    let material = materials.get(source);
    if (!material) {
      material = toon(source.color, source.name === 'BistroRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
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
