import * as THREE from 'three';
import { toon } from './toon';

/** Keep the lounge's seated-player anchors, picking group and collider unchanged. */
export function installLoungeSofa(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const couch = office.getObjectByName('lounge-sofa');
  const body = source.getObjectByName('LoungeSofa');
  if (!couch || !body) return false;
  const model = body.clone(true);
  const materials = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const convert = (source: THREE.MeshStandardMaterial): THREE.Material => {
      let material = materials.get(source);
      if (!material) {
        material = toon(source.color, source.metalness > 0.5 ? { finish: 'metal' } : {});
        materials.set(source, material);
      }
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  couch.clear();
  couch.add(model);
  return true;
}
