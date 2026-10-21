import * as THREE from 'three';

export interface ProbeAtlas {
  width: number;
  height: number;
  depth: number;
  data: Float32Array;
}

export const axisProbeUniforms = {
  rmAxisSH: { value: null as THREE.Data3DTexture | null },
  rmAxisReady: { value: 0 },
};

/**
 * Evaluate the same L2 light for the six axis normals once per finished bake, not per fragment.
 * Keep signed irradiance and the source padding: interpolation must happen before the zero clamp.
 */
export function axisProbeTexture({ width, height, depth, data }: ProbeAtlas): THREE.Data3DTexture {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || !Number.isInteger(depth) || depth < 28 || depth % 7 !== 0 || data.length !== width * height * depth * 4) {
    throw new RangeError('Invalid packed probe atlas');
  }
  const voxels = width * height * (depth / 7);
  const stride = voxels * 4;
  const output = new Float32Array(stride * 6);
  for (let i = 0; i < voxels; i++) {
    for (let c = 0; c < 3; c++) {
      const coefficient = (n: number) => {
        const packed = n * 3 + c;
        return data[Math.floor(packed / 4) * stride + i * 4 + (packed % 4)];
      };
      const base = coefficient(0) * 0.886227 - coefficient(6) * 0.247708;
      const x = coefficient(3) * 1.023328;
      const y = coefficient(1) * 1.023328;
      const z = coefficient(2) * 1.023328;
      const zz = coefficient(6) * 0.743125;
      const diff = coefficient(8) * 0.429043;
      const values = [base + diff + x, base + diff - x, base - diff + y, base - diff - y, base + zz + z, base + zz - z];
      for (let slot = 0; slot < 6; slot++) output[slot * stride + i * 4 + c] = values[slot];
    }
  }
  const texture = new THREE.Data3DTexture(output, width, height, (depth / 7) * 6);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.FloatType;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** One trilinear fetch on axis-aligned faces; unchanged SH evaluation for every other normal. */
export const AXIS_PROBE_GLSL = /* glsl */ `
#ifdef USE_LIGHT_PROBES_GRID
uniform highp sampler3D rmAxisSH;
uniform float rmAxisReady;
vec3 rmAxisIrradiance( vec3 worldPos, vec3 worldNormal ) {
  vec3 a = abs( worldNormal );
  float slot = -1.0;
  // Allow only transform round-off, not a coarser approximation of curved surfaces.
  if ( abs( a.x - 1.0 ) <= 0.000001 && a.y <= 0.000001 && a.z <= 0.000001 ) slot = worldNormal.x > 0.0 ? 0.0 : 1.0;
  else if ( abs( a.y - 1.0 ) <= 0.000001 && a.x <= 0.000001 && a.z <= 0.000001 ) slot = worldNormal.y > 0.0 ? 2.0 : 3.0;
  else if ( abs( a.z - 1.0 ) <= 0.000001 && a.x <= 0.000001 && a.y <= 0.000001 ) slot = worldNormal.z > 0.0 ? 4.0 : 5.0;
  if ( rmAxisReady > 0.0 && slot >= 0.0 ) {
    vec3 res = probesResolution;
    vec3 gridRange = probesMax - probesMin;
    vec3 samplePos = worldPos + worldNormal * ( gridRange / ( res - 1.0 ) ) * 0.5;
    vec3 uvw = clamp( ( samplePos - probesMin ) / gridRange, 0.0, 1.0 );
    uvw = uvw * ( res - 1.0 ) / res + 0.5 / res;
    float padded = res.z + 2.0;
    return max( texture( rmAxisSH, vec3( uvw.xy, ( uvw.z * res.z + 1.0 + slot * padded ) / ( 6.0 * padded ) ) ).rgb, vec3( 0.0 ) );
  }
  return getLightProbeGridIrradiance( worldPos, worldNormal );
}
#define getLightProbeGridIrradiance rmAxisIrradiance
#endif
`;
