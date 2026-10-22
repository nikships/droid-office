import * as THREE from 'three';
import { SEATING_BY_ID } from '../../shared/layout';
import { toon } from './toon';

/** The asymmetric shell and the seated player face the same +z direction. */
export function buildLoungeBeanbag(id: string, color: THREE.ColorRepresentation): THREE.Group {
  const seat = SEATING_BY_ID.get(id)!;
  const bag = new THREE.Group();
  bag.name = id;
  bag.position.set(seat.x, seat.y, seat.z);
  bag.rotation.y = seat.rotY;
  bag.userData.fabricColor = color;
  const fallback = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10), toon(color));
  fallback.position.y = 0.35;
  fallback.scale.y = 0.6;
  bag.add(fallback);
  return bag;
}

/** Both seats keep their original tint, mount, +z facing, picking and collider. */
export function installLoungeBeanbags(source: THREE.Object3D, office: THREE.Object3D): number {
  const part = source.getObjectByName('LoungeBeanbag');
  if (!part) return 0;
  const shared = new Map<THREE.Material, THREE.MeshToonMaterial>();
  let installed = 0;
  for (const id of ['lounge-beanbag-1', 'lounge-beanbag-2']) {
    const bag = office.getObjectByName(id);
    if (!bag) continue;
    const fabric = new Map<THREE.Material, THREE.MeshToonMaterial>();
    const convert = (source: THREE.MeshStandardMaterial) => {
      const cache = source.name === 'BeanFabric' ? fabric : shared;
      let material = cache.get(source);
      if (!material) {
        material = source.name === 'BeanFabric' ? toon(bag.userData.fabricColor ?? source.color) : toon(source.color, source.metalness > 0.5 ? { finish: 'metal' } : {});
        cache.set(source, material);
      }
      return material;
    };
    const model = part.clone(true);
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
    });
    bag.clear();
    bag.add(model);
    installed++;
  }
  return installed;
}
