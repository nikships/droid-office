import * as THREE from 'three';
import { toon } from './toon';

/** Both original stools share geometry/hardware, but retain their separate seat colors. */
export function installBalconyStools(source: THREE.Object3D, office: THREE.Object3D): number {
  const part = source.getObjectByName('BalconyStool');
  if (!part) return 0;
  const shared = new Map<THREE.Material, THREE.MeshToonMaterial>();
  let count = 0;
  for (const id of [1, 2]) {
    const stool = office.getObjectByName(`balcony-stool-${id}`);
    if (!stool) continue;
    const model = part.clone(true);
    const local = new Map<THREE.Material, THREE.MeshToonMaterial>();
    const color = typeof stool.userData.seatColor === 'string' ? stool.userData.seatColor : null;
    const convert = (source: THREE.MeshStandardMaterial) => {
      const isSeat = source.name === 'StoolSeat';
      const cache = isSeat ? local : shared;
      let material = cache.get(source);
      if (!material) {
        const finish = source.metalness > 0.5 ? { finish: 'metal' as const } : source.name === 'StoolShell' ? { finish: 'paint' as const } : {};
        material = toon(isSeat && color ? color : source.color, finish);
        cache.set(source, material);
      }
      return material;
    };
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
    });
    stool.clear();
    stool.add(model);
    count++;
  }
  return count;
}
