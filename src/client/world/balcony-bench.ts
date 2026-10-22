import * as THREE from 'three';
import { toon } from './toon';

/** Replace only static bench geometry; its parent retains both seat places and picking. */
export function installBalconyBench(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const bench = office.getObjectByName('balcony-bench');
  const part = source.getObjectByName('BalconyBench');
  if (!bench || !part) return false;
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
  bench.clear();
  bench.add(model);
  return true;
}
