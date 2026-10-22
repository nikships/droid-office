import * as THREE from 'three';
import { toon } from './toon';

/** Swap only the pendant housings; the ceiling keeps all rods, live diffusers and lighting state. */
export function installHighBayLamps(source: THREE.Object3D, office: THREE.Object3D): number {
  const body = source.getObjectByName('HighBayLamp');
  if (!body) return 0;
  const mounts: THREE.Object3D[] = [];
  office.traverse((object) => {
    if (object.name === 'high-bay-lamp') mounts.push(object);
  });
  if (!mounts.length) return 0;
  const model = body.clone(true);
  const materials = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const convert = (source: THREE.MeshStandardMaterial): THREE.Material => {
      let material = materials.get(source);
      if (!material) {
        material = toon(source.color, source.name === 'BayRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
        materials.set(source, material);
      }
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  for (const mount of mounts) {
    mount.clear();
    mount.add(model.clone(true));
  }
  return mounts.length;
}
