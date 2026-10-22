import * as THREE from 'three';
import { toon } from './toon';

/** Swap just the counter, retaining the real label, agent pose, stage and picking group. */
export function installAgentKiosks(source: THREE.Object3D, stations: Iterable<THREE.Group>): number {
  const body = source.getObjectByName('AgentKiosk');
  if (!body) return 0;
  const model = body.clone(true);
  const materials = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const convert = (source: THREE.MeshStandardMaterial): THREE.Material => {
      let material = materials.get(source);
      if (!material) {
        material = toon(source.color, source.name === 'KioskSignal' ? { emissive: source.color } : source.name === 'KioskRubber' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
        materials.set(source, material);
      }
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  let installed = 0;
  for (const station of stations) {
    const kiosk = station.getObjectByName('agent-kiosk');
    if (!kiosk) continue;
    kiosk.clear();
    kiosk.add(model.clone(true));
    installed++;
  }
  return installed;
}
