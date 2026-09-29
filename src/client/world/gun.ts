import * as THREE from 'three';
import { mesh, toon } from './toon';

/** Stainless steel, and the walnut grip. */
const STEEL = '#c9ced6';
const DARK_STEEL = '#8d99ae';
const WALNUT = '#6f4518';

/**
 * A silver .44 Magnum revolver, built from primitives: long barrel, cylinder, walnut grip, hammer,
 * trigger and sights. It points down +z with the grip at the origin, so a fist wraps round it and
 * the barrel sits over the knuckles. About real size (32 cm), which suits the hands and the
 * cartoon people alike.
 */
export function magnum(): THREE.Group {
  const gun = new THREE.Group();
  const steel = toon(STEEL);
  const dark = toon(DARK_STEEL);
  const wood = toon(WALNUT);
  // Grip: flaring toward the bottom, raked back a little, with a medallion on each side.
  const grip = mesh(new THREE.BoxGeometry(0.034, 0.1, 0.05), wood, 0, 0.045, -0.028, false);
  grip.rotation.x = 0.28;
  grip.scale.set(1, 1, 1.25);
  gun.add(grip);
  for (const sx of [-1, 1]) gun.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.004, 10).rotateZ(Math.PI / 2), dark, sx * 0.018, 0.05, -0.036, false));
  // Frame over the grip, and the cylinder turning in it: six chambers round the middle.
  gun.add(mesh(new THREE.BoxGeometry(0.032, 0.035, 0.075), steel, 0, 0.105, -0.005, false));
  const cylinder = mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.05, 12).rotateX(Math.PI / 2), steel, 0, 0.105, 0.02, false);
  gun.add(cylinder);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    gun.add(mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.052, 6).rotateX(Math.PI / 2), dark, Math.cos(a) * 0.014, 0.105 + Math.sin(a) * 0.014, 0.02, false));
  }
  // Long barrel with a rib on top and a lug underneath, front sight at the muzzle.
  gun.add(mesh(new THREE.BoxGeometry(0.026, 0.028, 0.19), steel, 0, 0.105, 0.14, false));
  gun.add(mesh(new THREE.BoxGeometry(0.012, 0.008, 0.19), dark, 0, 0.122, 0.14, false));
  gun.add(mesh(new THREE.BoxGeometry(0.02, 0.02, 0.15), dark, 0, 0.082, 0.12, false));
  gun.add(mesh(new THREE.BoxGeometry(0.006, 0.014, 0.008), dark, 0, 0.128, 0.232, false));
  // Hammer cocked back, trigger in its guard.
  const hammer = mesh(new THREE.BoxGeometry(0.012, 0.035, 0.014), dark, 0, 0.125, -0.048, false);
  hammer.rotation.x = -0.5;
  gun.add(hammer);
  gun.add(mesh(new THREE.BoxGeometry(0.008, 0.025, 0.008), dark, 0, 0.078, -0.01, false));
  const guard = mesh(new THREE.TorusGeometry(0.02, 0.004, 6, 12, Math.PI * 1.4), steel, 0, 0.068, -0.008, false);
  guard.rotation.z = Math.PI * 0.8;
  gun.add(guard);
  return gun;
}

/** Where the muzzle is, in the gun's own space (see magnum): the flash goes here. */
export const MUZZLE = new THREE.Vector3(0, 0.105, 0.24);

/** How long the flash shows, in seconds. */
const FLASH_TIME = 0.09;

/**
 * A muzzle flash: a hot star and a puff of smoke at the muzzle, there and gone in a blink.
 * Built additive with no depth write, so it glows however the gun is lit.
 */
export class MuzzleFlash {
  readonly group = new THREE.Group();
  private star: THREE.Mesh;
  private ball: THREE.Mesh;
  private t = -1;

  constructor() {
    const hot = new THREE.MeshBasicMaterial({ color: '#ffe66d', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const core = new THREE.MeshBasicMaterial({ color: '#fffaf3', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.star = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), hot);
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), core);
    this.group.add(this.star, this.ball);
    this.group.position.copy(MUZZLE);
    this.group.visible = false;
  }

  /** Fires it: full blaze, shrinking away over FLASH_TIME. */
  fire() {
    this.t = 0;
    this.group.visible = true;
    this.star.rotation.z = Math.random() * Math.PI;
  }

  get firing(): boolean {
    return this.t >= 0;
  }

  update(dt: number) {
    if (this.t < 0) return;
    this.t += dt;
    const p = Math.min(1, this.t / FLASH_TIME);
    const k = 1 - p;
    this.group.visible = p < 1;
    if (p >= 1) {
      this.t = -1;
      return;
    }
    this.star.scale.setScalar(0.6 + k * 0.6);
    this.ball.scale.setScalar(0.7 + k * 0.5);
    (this.star.material as THREE.MeshBasicMaterial).opacity = k;
    (this.ball.material as THREE.MeshBasicMaterial).opacity = k;
  }

  dispose() {
    this.star.geometry.dispose();
    this.ball.geometry.dispose();
    (this.star.material as THREE.Material).dispose();
    (this.ball.material as THREE.Material).dispose();
  }
}

/** Takes a gun from magnum out of the hand holding it (its materials are shared). */
export function disposeGun(g: THREE.Group) {
  g.removeFromParent();
  g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
}
