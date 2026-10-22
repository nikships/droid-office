import * as THREE from 'three';
import { DROID_RACK } from '../../shared/layout';
import { toon } from './toon';

/** Only the existing plinth/backboard; cube models, feeds, labels and glow stay siblings. */
export function installDroidRack(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const mount = office.getObjectByName('droid-rack-frame');
  const part = source.getObjectByName('DroidRack');
  if (!mount || !part) return false;
  const model = part.clone(true);
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (source: THREE.MeshStandardMaterial) => {
    let material = materials.get(source);
    if (!material) {
      material = toon(source.color, source.name === 'RackRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
      materials.set(source, material);
    }
    return material;
  };
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  model.position.set((DROID_RACK.minX + DROID_RACK.maxX) / 2, 0, (DROID_RACK.minZ + DROID_RACK.maxZ) / 2);
  mount.clear();
  mount.add(model);
  return true;
}
