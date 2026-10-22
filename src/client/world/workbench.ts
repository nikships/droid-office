import * as THREE from 'three';
import { toon } from './toon';

/** Replace only each desk's workbench, never its laptop, worker, chair or interaction group. */
export function installWorkbenches(source: THREE.Object3D, desks: Iterable<THREE.Group>): void {
  const model = source.clone(true);
  model.name = 'workbench-model';
  const materials = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const convert = (source: THREE.MeshStandardMaterial): THREE.Material => {
      let material = materials.get(source);
      if (!material) {
        material = toon(source.color, source.name === 'BenchRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
        materials.set(source, material);
      }
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  for (const desk of desks) {
    const workbench = desk.getObjectByName('workbench');
    if (!workbench) continue;
    workbench.clear();
    workbench.add(model.clone(true));
  }
}
