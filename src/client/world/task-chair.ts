import * as THREE from 'three';
import { toon } from './toon';

/** Swap only the chair's contents: seating and swivel code keep the same group and transform. */
export function installTaskChairs(source: THREE.Object3D, chairs: Iterable<THREE.Group>): void {
  const model = source.clone(true);
  model.name = 'task-chair';
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
  for (const chair of chairs) {
    chair.clear();
    chair.add(model.clone(true));
  }
}
