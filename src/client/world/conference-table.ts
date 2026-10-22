import * as THREE from 'three';
import { toon } from './toon';

/** Replace only Mission Control's table, not its chairs, glass, artwork or collider. */
export function installConferenceTable(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const table = office.getObjectByName('conference-table');
  const body = source.getObjectByName('ConferenceTable');
  if (!table || !body) return false;
  const model = body.clone(true);
  const materials = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const convert = (source: THREE.MeshStandardMaterial): THREE.Material => {
      let material = materials.get(source);
      if (!material) {
        material = toon(source.color, source.name === 'TableSignal' ? { emissive: source.color } : source.name === 'TableTop' || source.name === 'TableRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
        materials.set(source, material);
      }
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  table.clear();
  table.add(model);
  return true;
}
