import * as THREE from 'three';
import { FLOOR } from '../../shared/layout';

/** A finish changes only Remastered's response to light, not a material's Classic color. */
export type SurfaceFinish = 'paint' | 'metal';
export const SURFACE_FINISHES: Record<SurfaceFinish, readonly [number, number]> = {
  paint: [0.04, 0.72],
  metal: [0.55, 0.3],
};

export function withFinish<M extends THREE.Material>(material: M, finish: SurfaceFinish): M {
  material.userData.remasterFinish = finish;
  return material;
}

export function surfaceFinish(material: THREE.Material): readonly [number, number] | null {
  const finish = material.userData.remasterFinish as SurfaceFinish | undefined;
  return finish ? (SURFACE_FINISHES[finish] ?? null) : null;
}

/** Shared controls: changing renderers never rebuilds the materials or their shader programs. */
export const surfaceUniforms = {
  rmSurface: { value: 0 },
  rmContact: { value: 0 },
  rmContactMap: { value: null as THREE.DataTexture | null },
};

/**
 * A broad, analytic room reflection, evaluated at vertices rather than at every screen pixel.
 * The soft ceiling lobe and grazing response separate metal from painted surfaces. Its energy
 * follows the existing room fill, so switching off the overheads switches off their reflection.
 * It is disabled during the diffuse GI bake: a view-dependent highlight must not become bounce light.
 */
export const SURFACE_VERTEX = /* glsl */ `
vRmSurface = vec3( 0.0 );
if ( rmSurface > 0.0 ) {
  vec3 rmNormal = normalize( ( vec4( transformedNormal, 0.0 ) * viewMatrix ).xyz );
  vec3 rmView = normalize( cameraPosition - vSkyWorld );
  vec3 rmReflected = reflect( -rmView, rmNormal );
  float rmFacing = clamp( dot( rmNormal, rmView ), 0.0, 1.0 );
  float rmGrazing = pow( 1.0 - rmFacing, 5.0 );
  float rmCeiling = smoothstep( -0.25, 0.9, rmReflected.y );
  float rmSoftbox = pow( max( dot( rmReflected, normalize( vec3( -0.45, 0.8, 0.35 ) ) ), 0.0 ), mix( 24.0, 3.0, rmFinish.y ) );
  vec3 rmEnvironment = mix( vec3( 0.24, 0.26, 0.3 ), vec3( 1.0, 0.97, 0.92 ), rmCeiling );
  rmEnvironment += vec3( 1.0, 0.88, 0.72 ) * rmSoftbox * ( 1.0 - rmFinish.y );
  float rmFresnel = rmFinish.x + ( 1.0 - rmFinish.x ) * rmGrazing * ( 1.0 - rmFinish.y );
  float rmRoomEnergy = dot( skyOffice, vec3( 0.2126, 0.7152, 0.0722 ) );
  vRmSurface = rmEnvironment * rmFresnel * rmRoomEnergy * rmFill * 3.0;
}
`;

export const SURFACE_LIGHT = /* glsl */ `
if ( rmSurface > 0.0 && skyIndoor > 0.0 && rmGIOnly < 0.5 ) {
  vec3 rmTint = mix( vec3( 1.0 ), material.diffuseColor, step( 0.3, rmFinish.x ) );
  reflectedLight.indirectSpecular += vRmSurface * rmTint * skyIndoor;
}
`;

/** The room's static wall/floor junctions, evaluated analytically instead of a screen-space AO pass. */
export const WALL_CONTACT = /* glsl */ `
if ( rmContact > 0.0 && skyOn > 0.0 ) {
  float rmWallX = min( abs( vSkyWorld.x - ${FLOOR.minX.toFixed(3)} ), abs( vSkyWorld.x - ${FLOOR.maxX.toFixed(3)} ) );
  float rmWallZ = min( abs( vSkyWorld.z - ${FLOOR.minZ.toFixed(3)} ), abs( vSkyWorld.z - ${FLOOR.maxZ.toFixed(3)} ) );
  float rmJunction = min( max( rmWallX, rmWallZ ), abs( vSkyWorld.y ) );
  reflectedLight.indirectDiffuse *= mix( 1.0, 0.76 + 0.24 * smoothstep( 0.0, 0.65, rmJunction ), rmContact );
}
`;

export const CONTACT_LIGHT = /* glsl */ `
if ( rmContact > 0.0 && skyOn > 0.0 ) {
  vec2 rmContactUv = vec2(
    ( vSkyWorld.x - ${FLOOR.minX.toFixed(3)} ) / ${(FLOOR.maxX - FLOOR.minX).toFixed(3)},
    ( ${FLOOR.maxZ.toFixed(3)} - vSkyWorld.z ) / ${(FLOOR.maxZ - FLOOR.minZ).toFixed(3)}
  );
  float rmOcclusion = texture2D( rmContactMap, rmContactUv ).r;
  reflectedLight.indirectDiffuse *= mix( 1.0, rmOcclusion, rmContact );
}
`;

export interface ContactFootprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Darkness directly underneath, 0–1. */
  strength: number;
  /** Feather distance outside the footprint, in metres. */
  feather: number;
}

/** A static ambient-contact atlas, rasterized once. No rays, framebuffer or per-frame work. */
export function contactPixels(bounds: Pick<ContactFootprint, 'minX' | 'maxX' | 'minZ' | 'maxZ'>, footprints: readonly ContactFootprint[], width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height).fill(255);
  const sx = width / (bounds.maxX - bounds.minX);
  const sz = height / (bounds.maxZ - bounds.minZ);
  for (const f of footprints) {
    const feather = Math.max(0.001, f.feather);
    const x0 = Math.max(0, Math.floor((f.minX - feather - bounds.minX) * sx));
    const x1 = Math.min(width, Math.ceil((f.maxX + feather - bounds.minX) * sx));
    const y0 = Math.max(0, Math.floor((bounds.maxZ - f.maxZ - feather) * sz));
    const y1 = Math.min(height, Math.ceil((bounds.maxZ - f.minZ + feather) * sz));
    const strength = THREE.MathUtils.clamp(f.strength, 0, 1);
    for (let y = y0; y < y1; y++) {
      const z = bounds.maxZ - (y + 0.5) / sz;
      const dz = Math.max(f.minZ - z, z - f.maxZ, 0);
      for (let x = x0; x < x1; x++) {
        const wx = bounds.minX + (x + 0.5) / sx;
        const dx = Math.max(f.minX - wx, wx - f.maxX, 0);
        const t = Math.min(1, Math.hypot(dx, dz) / feather);
        const falloff = 1 - t * t * (3 - 2 * t);
        const i = y * width + x;
        data[i] = Math.round(data[i] * (1 - strength * falloff));
      }
    }
  }
  return data;
}

/** Every floor has the same fixed furniture. Keep one small, mipmapped, single-channel atlas. */
export function setContactFootprints(footprints: readonly ContactFootprint[]): void {
  if (surfaceUniforms.rmContactMap.value) return;
  const width = 1024;
  const height = Math.round((width * (FLOOR.maxZ - FLOOR.minZ)) / (FLOOR.maxX - FLOOR.minX));
  const texture = new THREE.DataTexture(contactPixels(FLOOR, footprints, width, height), width, height, THREE.RedFormat);
  texture.unpackAlignment = 1;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  surfaceUniforms.rmContactMap.value = texture;
}
