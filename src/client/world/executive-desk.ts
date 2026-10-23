import * as THREE from 'three';
import { toon } from './toon';

/** Keep the loft's real shell display, BOSS label and chair outside the static replacement. */
export function installExecutiveDesk(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const desk = office.getObjectByName('executive-desk');
  const body = source.getObjectByName('ExecutiveDesk');
  if (!desk || !body) return false;
  const model = body.clone(true);
  const materials = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const convert = (source: THREE.MeshStandardMaterial): THREE.Material => {
      let material = materials.get(source);
      if (!material) {
        material = toon(source.color, source.name === 'BossSignal' ? { emissive: source.color } : source.name === 'BossTop' || source.name === 'BossRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
        materials.set(source, material);
      }
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  desk.clear();
  desk.add(model);
  return true;
}
