import * as THREE from 'three';
import { toon } from './toon';

/** Keep the original live diffuser, pip and wires in the ceiling batch; replace only eight housings. */
export function installLedBarHousings(source: THREE.Object3D, office: THREE.Object3D): number {
  const body = source.getObjectByName('LedBarHousing');
  if (!body) return 0;
  const mounts: THREE.Object3D[] = [];
  office.traverse((object) => {
    if (object.name === 'led-bar-housing') mounts.push(object);
  });
  if (!mounts.length) return 0;
  const model = body.clone(true);
  const materials = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const convert = (source: THREE.MeshStandardMaterial): THREE.Material => {
      let material = materials.get(source);
      if (!material) {
        material = toon(source.color, source.name === 'BarRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
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
