import * as THREE from 'three';
import { ANISOTROPY } from './texture-quality';

/** Repeats on the retained wall UVs, and on its original occupied-window atlas. */
export interface FacadeBay {
  style: number;
  columns: number;
  rows: number;
  lightsAcross: number;
  lightsDown: number;
  tint?: string;
}

const installed = new WeakSet<THREE.Material>();

/** Material-only replacement: floor rebuilding, batching, night registration and footprints stay intact. */
export function installCityFacades(source: THREE.Object3D, ...roots: THREE.Object3D[]): number {
  const kit = new Map<string, THREE.MeshStandardMaterial>();
  source.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const mat of Array.isArray(object.material) ? object.material : [object.material]) {
      if (mat instanceof THREE.MeshStandardMaterial) kit.set(mat.name, mat);
    }
  });
  if (Array.from({ length: 10 }, (_, i) => kit.get(`CityFacade${i}`)).some((mat) => !mat?.map || !mat.normalMap || !mat.emissiveMap)) return 0;
  const targets = new Set<THREE.MeshToonMaterial>();
  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const mat of Array.isArray(object.material) ? object.material : [object.material]) {
        if (mat instanceof THREE.MeshToonMaterial && mat.userData.facade && !installed.has(mat)) targets.add(mat);
      }
    });
  }
  const obsolete = new Set<THREE.Texture>();
  let count = 0;
  for (const target of targets) {
    const bay = target.userData.facade as FacadeBay;
    const donor = kit.get(`CityFacade${bay.style}`);
    const lights = target.emissiveMap;
    const canvas = lights?.image as HTMLCanvasElement | undefined;
    if (!donor || !(lights instanceof THREE.CanvasTexture) || !canvas?.getContext) continue;
    const context = canvas.getContext('2d');
    if (!context) continue;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'multiply';
    const w = canvas.width / bay.lightsAcross;
    const h = canvas.height / bay.lightsDown;
    for (let y = 0; y < bay.lightsDown; y++) for (let x = 0; x < bay.lightsAcross; x++) context.drawImage(donor.emissiveMap!.image as CanvasImageSource, x * w, y * h, w, h);
    context.restore();
    lights.needsUpdate = true;
    const repeat = (texture: THREE.Texture) => {
      const copy = texture.clone();
      copy.wrapS = copy.wrapT = THREE.RepeatWrapping;
      // The donor's exported UV is (x / 2.8 + .5, 1 - y / 3.3).
      copy.repeat.set(bay.columns, -bay.rows);
      copy.offset.set(0, 1);
      copy.anisotropy = ANISOTROPY;
      copy.needsUpdate = true;
      return copy;
    };
    for (const texture of [target.map, target.normalMap]) if (texture) obsolete.add(texture);
    target.map = repeat(donor.map!);
    target.normalMap = repeat(donor.normalMap!);
    target.normalScale.copy(donor.normalScale);
    if (bay.tint) target.color.set(bay.tint).lerp(new THREE.Color('#ffffff'), 0.75);
    target.needsUpdate = true;
    installed.add(target);
    count++;
  }
  for (const texture of obsolete) texture.dispose();
  return count;
}
