import * as THREE from 'three';
import { toon } from './toon';

/** The authored -x front matches both original loft seat anchors. */
export function installLoftCouch(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const couch = office.getObjectByName('loft-couch');
  const part = source.getObjectByName('LoftCouch');
  if (!couch || !part) return false;
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
  couch.clear();
  couch.add(model);
  return true;
}
