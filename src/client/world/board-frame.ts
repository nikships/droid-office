import * as THREE from 'three';
import { ANISOTROPY } from './texture-quality';
import { toonUnique } from './toon';

/** Replace only the three north-wall frames, never their live canvas or interaction group. */
export function installBoardFrames(source: THREE.Object3D, office: THREE.Object3D): number {
  const body = source.getObjectByName('board-frame');
  if (!body) return 0;
  const mounts: THREE.Object3D[] = [];
  office.traverse((object) => {
    if (object.name === 'board-frame-mount') mounts.push(object);
  });
  if (!mounts.length) return 0;
  const model = body.clone(true);
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const convert = (source: THREE.MeshStandardMaterial): THREE.MeshToonMaterial => {
      let material = materials.get(source);
      if (!material) {
        material = toonUnique(source.color, source.name === 'BoardRubber' || source.name === 'BoardSignal' ? undefined : source.metalness > 0.5 ? 'metal' : 'paint');
        material.map = source.map;
        material.normalMap = source.normalMap;
        material.normalScale.copy(source.normalScale);
        for (const texture of [material.map, material.normalMap]) {
          if (texture) texture.anisotropy = ANISOTROPY;
        }
        materials.set(source, material);
      }
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  for (const mount of mounts) {
    mount.clear();
    mount.add(model.clone(true));
  }
  return mounts.length;
}
