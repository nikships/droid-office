import * as THREE from 'three';

/** An OLED pixel that's off emits no light. Dark UI panels and supplied content keep their own colors. */
export const SCREEN_BLACK = '#000000';

const GLASS_PARS = /* glsl */ `
varying vec2 vScreenUv;
varying vec3 vScreenView;
`;

/**
 * Cover glass, not a picture of the room. A streak sliding across the panel read as the ceiling
 * fixtures; the highlight stays on the rim, and is zero everywhere else, so black is not washed grey.
 */
const GLASS = /* glsl */ `
vec3 screenView = normalize( vScreenView );
float screenFresnel = pow( 1.0 - abs( screenView.z ), 5.0 );
vec2 screenEdgeDistance = min( vScreenUv, 1.0 - vScreenUv );
float screenEdge = 1.0 - smoothstep( 0.0, 0.014, min( screenEdgeDistance.x, screenEdgeDistance.y ) );
// Rim only. Head-on the panel is untouched; nothing is added across the glass.
outgoingLight += vec3( 0.84, 0.91, 1.0 ) * screenEdge * ( 0.006 + 0.045 * screenFresnel );
`;

/** OLED content stays unlit and unfogged; a rim highlight on the cover glass reads as gloss without reflecting the ceiling lights. */
export function screenMaterial(params: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: params.map ? '#ffffff' : SCREEN_BLACK, ...params, envMap: null, fog: false, toneMapped: false });
  material.onBeforeCompile = function (shader, renderer) {
    // Keep the office's shared glow and GI-bake hooks (world/sky.ts).
    THREE.Material.prototype.onBeforeCompile.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${GLASS_PARS}`).replace(
      '#include <project_vertex>',
      /* glsl */ `#include <project_vertex>
vScreenUv = uv;
vec3 screenRight = normalize( mat3( modelViewMatrix ) * vec3( 1.0, 0.0, 0.0 ) );
vec3 screenUp = normalize( mat3( modelViewMatrix ) * vec3( 0.0, 1.0, 0.0 ) );
vec3 screenNormal = normalize( normalMatrix * normal );
vScreenView = vec3( dot( -mvPosition.xyz, screenRight ), dot( -mvPosition.xyz, screenUp ), dot( -mvPosition.xyz, screenNormal ) );`,
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${GLASS_PARS}`).replace('#include <envmap_fragment>', `${GLASS}\n#include <envmap_fragment>`);
  };
  return material;
}
