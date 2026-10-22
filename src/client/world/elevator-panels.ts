import * as THREE from 'three';
import { toon } from './toon';

/** Both leaves or neither: keep the original sliding groups, controls and collision timing. */
export function installElevatorPanels(source: THREE.Object3D, elevator: THREE.Object3D): boolean {
  const pairs = ['Left', 'Right'].map((side) => ({
    mount: elevator.getObjectByName(`elevator-panel-${side.toLowerCase()}`),
    part: source.getObjectByName(`ElevatorPanel${side}`),
  }));
  if (pairs.some(({ mount, part }) => !mount || !part)) return false;
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (source: THREE.MeshStandardMaterial) => {
    let material = materials.get(source);
    if (!material) {
      material = toon(source.color, source.name === 'LiftSeal' ? {} : { finish: 'metal' });
      materials.set(source, material);
    }
    return material;
  };
  for (const { mount, part } of pairs) {
    const model = part!.clone(true);
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
    });
    mount!.clear();
    mount!.add(model);
  }
  return true;
}
