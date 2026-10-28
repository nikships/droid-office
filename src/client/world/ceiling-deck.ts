import * as THREE from 'three';
import { withFinish } from './surface';
import { ANISOTROPY } from './texture-quality';

/** Swap only the retained material, so Stack.set keeps its real hatch and colliders. */
export function installCeilingDeck(source: THREE.Object3D, target: THREE.MeshToonMaterial): boolean {
  let steel: THREE.MeshStandardMaterial | undefined;
  source.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof THREE.MeshStandardMaterial && material.name === 'CeilingDeck') steel = material;
    }
  });
  if (!steel?.map || !steel.normalMap || !steel.aoMap) return false;
  const repeat = (texture: THREE.Texture) => {
    const copy = texture.clone();
    copy.wrapS = copy.wrapT = THREE.RepeatWrapping;
    // Blender's exported UVs are (0.5 + x / 1.2, 0.5 - z / 1.2).
    // Match that basis on Stack's metre-based X/Z UVs, including tangent normals.
    copy.repeat.set(1 / 1.2, -1 / 1.2);
    copy.offset.set(0.5, 0.5);
    copy.anisotropy = ANISOTROPY;
    copy.needsUpdate = true;
    return copy;
  };
  const old = new Set([target.map, target.normalMap, target.aoMap, target.emissiveMap]);
  target.map = repeat(steel.map);
  target.emissiveMap = target.map;
  target.normalMap = repeat(steel.normalMap);
  target.normalScale.copy(steel.normalScale);
  target.aoMap = repeat(steel.aoMap);
  target.aoMapIntensity = 0.85;
  withFinish(target, 'paint');
  target.needsUpdate = true;
  for (const texture of old) texture?.dispose();
  return true;
}
