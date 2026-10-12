import * as THREE from 'three';

/** An OLED pixel that's off emits no light. Dark UI panels and supplied content keep their own colors. */
export const SCREEN_BLACK = '#000000';

/** Unlit displays: room lighting, tone mapping and distance fog must not lift their black pixels. */
export function screenMaterial(params: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: params.map ? '#ffffff' : SCREEN_BLACK, ...params, fog: false, toneMapped: false });
}
