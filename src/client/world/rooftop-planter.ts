import * as THREE from 'three';
import { FLOOR } from '../../shared/layout';
import type { Collider } from './office';
import { ANISOTROPY } from './texture-quality';
import { mesh, toon, toonUnique } from './toon';

export const ROOF_PLANTER = { width: 2.4, depth: 0.8, basinHeight: 0.64 } as const;
export const ROOF_PLANTERS = [...[-12, -4, 4, 12].map((x) => ({ x, z: FLOOR.maxZ - 1.7, rotY: 0 })), { x: FLOOR.minX + 1.6, z: 3, rotY: Math.PI / 2 }, { x: FLOOR.maxX - 1.6, z: 3, rotY: Math.PI / 2 }];

/** Basins are solid; the light grass canopy is not a wall. Keep the centre and lift approach open. */
export function buildRoofPlanters(colliders: Collider[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'rooftop-planters';
  for (const [index, p] of ROOF_PLANTERS.entries()) {
    const mount = new THREE.Group();
    mount.name = `rooftop-planter-${index}`;
    mount.position.set(p.x, 0, p.z);
    mount.rotation.y = p.rotY;
    const { width, depth, basinHeight } = ROOF_PLANTER;
    mount.add(mesh(new THREE.BoxGeometry(width, basinHeight, depth), toon('#8c9087'), 0, basinHeight / 2, 0));
    mount.add(mesh(new THREE.BoxGeometry(width - 0.16, 0.025, depth - 0.16), toon('#28261d'), 0, basinHeight, 0));
    for (const x of [-0.8, -0.4, 0, 0.4, 0.8]) mount.add(mesh(new THREE.ConeGeometry(0.18, 0.65, 5), toon('#738659'), x, basinHeight + 0.32, 0));
    group.add(mount);
    const hw = (Math.abs(Math.cos(p.rotY)) * width + Math.abs(Math.sin(p.rotY)) * depth) / 2;
    const hd = (Math.abs(Math.sin(p.rotY)) * width + Math.abs(Math.cos(p.rotY)) * depth) / 2;
    colliders.push({ minX: p.x - hw, maxX: p.x + hw, minZ: p.z - hd, maxZ: p.z + hd, bottom: 0, top: basinHeight });
  }
  return group;
}

export function installRoofPlanters(source: THREE.Object3D, root: THREE.Object3D): boolean {
  const mounts = root.getObjectByName('rooftop-planters')?.children;
  if (!mounts || mounts.length !== ROOF_PLANTERS.length) return false;
  const originals = new Set<THREE.MeshStandardMaterial>();
  let unsupported = false;
  source.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const src of Array.isArray(object.material) ? object.material : [object.material]) {
      if (src instanceof THREE.MeshStandardMaterial) originals.add(src);
      else unsupported = true;
    }
  });
  const required = ['PlanterConcrete', 'PlanterSteel', 'PlanterSoil', 'PlanterSage', 'PlanterEvergreen', 'PlanterSeedheads'];
  if (unsupported || required.some((name) => ![...originals].some((m) => m.name === name && (name !== 'PlanterConcrete' || m.map)))) return false;
  const materials = new Map<THREE.Material, THREE.MeshToonMaterial>();
  for (const src of originals) {
    const material = toonUnique(src.color, src.name === 'PlanterSteel' ? 'metal' : undefined);
    material.map = src.map;
    if (material.map) material.map.anisotropy = ANISOTROPY;
    material.name = src.name;
    if (['PlanterSage', 'PlanterEvergreen', 'PlanterSeedheads'].includes(src.name)) material.userData.outlineParameters = { visible: false };
    materials.set(src, material);
  }
  for (const mount of mounts) {
    const model = source.clone(true);
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = Array.isArray(object.material) ? object.material.map((m) => materials.get(m)!) : materials.get(object.material)!;
    });
    mount.clear();
    mount.add(model);
  }
  return true;
}
