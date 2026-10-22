import * as THREE from 'three';
import { FLOOR, LADDER, WALL_HEIGHT } from '../../shared/layout';
import { mergeByMaterial, toon } from './toon';

/** Keep all original section groups/visibility, rung spacing, grips, signs, hatches and colliders. */
export function installFloorLadder(source: THREE.Object3D, office: THREE.Object3D): boolean {
  const sections = [
    { name: 'main', y0: 0, y1: WALL_HEIGHT },
    { name: 'below', y0: -2.2, y1: 0 },
    { name: 'above', y0: WALL_HEIGHT, y1: WALL_HEIGHT + 2.2 },
  ].map((s) => ({ ...s, mount: office.getObjectByName(`floor-ladder-${s.name}`) }));
  const parts = ['Rail', 'Rung', 'Mount'].map((name) => source.getObjectByName(`Ladder${name}`));
  if (sections.some((s) => !s.mount) || parts.some((p) => !p)) return false;
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  const convert = (source: THREE.MeshStandardMaterial) => {
    let material = materials.get(source);
    if (!material) {
      material = toon(source.color, { finish: 'metal' });
      materials.set(source, material);
    }
    return material;
  };
  const [rail, rung, bracket] = parts.map((part) => {
    const model = part!.clone(true);
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
    });
    return model;
  });
  const railX = FLOOR.minX + 0.16;
  for (const section of sections) {
    const model = new THREE.Group();
    for (const side of [-1, 1]) {
      const post = rail.clone(true);
      post.position.set(railX, section.y0, LADDER.z + (side * LADDER.width) / 2);
      post.scale.y = section.y1 - section.y0;
      model.add(post);
    }
    for (let y = Math.ceil((section.y0 + 0.15) / 0.3) * 0.3; y < section.y1 - 0.05; y += 0.3) {
      const step = rung.clone(true);
      step.position.set(railX, y, LADDER.z);
      step.scale.z = LADDER.width;
      model.add(step);
    }
    if (section.name === 'main') {
      for (let y = 0.9; y < WALL_HEIGHT - 0.4; y += 1.5) {
        for (const side of [-1, 1]) {
          const anchor = bracket.clone(true);
          anchor.position.set(railX, y, LADDER.z + (side * LADDER.width) / 2);
          model.add(anchor);
        }
      }
    }
    section.mount!.clear();
    section.mount!.add(mergeByMaterial(model));
  }
  return true;
}
