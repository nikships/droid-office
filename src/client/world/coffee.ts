import * as THREE from 'three';
import type { Interactable } from './office';
import { mergeByMaterial, mesh, roundedBox, toon } from './toon';

/** The machine on the kitchen counter: a black body with a brushed steel face and drip tray, and one orange ready light. */
export function buildCoffeeMachine(interactable: Interactable): { machine: THREE.Group; cup: THREE.Mesh } {
  const machine = new THREE.Group();
  const body = new THREE.Group();
  const black = toon('#6a6a6a');
  const steel = toon('#eaeaea');
  // A tower at the back and a head over the front, with the cup standing in the bay between.
  body.add(mesh(roundedBox(0.6, 0.7, 0.2, 0.02), black, 0, 0.35, -0.15));
  body.add(mesh(roundedBox(0.6, 0.3, 0.32, 0.02), black, 0, 0.55, 0.09));
  body.add(mesh(new THREE.BoxGeometry(0.6, 0.04, 0.3), black, 0, 0.02, 0.1, false));
  body.add(mesh(new THREE.BoxGeometry(0.46, 0.2, 0.012), steel, 0, 0.56, 0.255, false));
  body.add(mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.05, 6), steel, 0, 0.375, 0.12, false));
  body.add(mesh(new THREE.BoxGeometry(0.3, 0.01, 0.22), steel, 0, 0.045, 0.12, false));
  body.add(mesh(new THREE.BoxGeometry(0.06, 0.012, 0.012), toon('#ee6018', { emissive: '#ee6018' }), 0.18, 0.67, 0.256, false));
  machine.add(mergeByMaterial(body));
  const cup = mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.14, 10), toon('#eeeeee'), 0, 0.1, 0.12);
  machine.add(cup);
  machine.userData.interact = interactable;
  return { machine, cup };
}
