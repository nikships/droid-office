import * as THREE from 'three';
import { toon } from './toon';

/** Keep the loft's mount, +z optical axis, aim quaternion and collider unchanged. */
export function installTelescope(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const stand = office.getObjectByName('telescope-stand');
  const tube = office.getObjectByName('telescope-tube');
  const standSource = source.getObjectByName('TelescopeStand');
  const opticsSource = source.getObjectByName('TelescopeOptics');
  if (!stand || !tube || !standSource || !opticsSource) return false;
  const materials = new Map<THREE.Material, THREE.Material>();
  const convert = (source: THREE.MeshStandardMaterial): THREE.Material => {
    let material = materials.get(source);
    if (!material) {
      material =
        source.name === 'ScopeLens'
          ? new THREE.MeshBasicMaterial({ color: source.color, transparent: true, opacity: 0.8 })
          : toon(source.color, source.name === 'ScopeRubber' || source.name === 'ScopeSignal' ? {} : { finish: source.metalness > 0.5 ? 'metal' : 'paint' });
      materials.set(source, material);
    }
    return material;
  };
  const adopt = (part: THREE.Object3D) => {
    const model = part.clone(true);
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
    });
    return model;
  };
  const base = adopt(standSource);
  const optics = adopt(opticsSource);
  // GLB preview has the optics at 1.08 m; the existing aimed group already supplies that height.
  optics.position.y -= 1.08;
  stand.clear();
  stand.add(base);
  tube.clear();
  tube.add(optics);
  return true;
}
