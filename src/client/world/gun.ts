import * as THREE from 'three';
import { mesh, toon } from './toon';

export interface GunProp {
  group: THREE.Group;
  muzzle: THREE.Group;
}

/** A compact, recognizable silver .44 Magnum built entirely from low-poly primitives. Forward is +z. */
export function buildGun(): GunProp {
  const group = new THREE.Group();
  const silver = new THREE.MeshStandardMaterial({ color: '#b8c0ca', metalness: 0.82, roughness: 0.24 });
  const darkSilver = new THREE.MeshStandardMaterial({ color: '#59616b', metalness: 0.72, roughness: 0.3 });
  const black = toon('#252833');
  const grip = toon('#352c28');

  const barrel = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.36, 12), silver, 0, 0.015, 0.18, false);
  barrel.rotation.x = Math.PI / 2;
  group.add(barrel);
  const upper = mesh(new THREE.BoxGeometry(0.105, 0.085, 0.25), silver, 0, 0.075, 0.13, false);
  group.add(upper);
  const frame = mesh(new THREE.BoxGeometry(0.12, 0.12, 0.14), silver, 0, -0.005, 0.015, false);
  group.add(frame);
  const cylinder = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.105, 10), darkSilver, 0, 0.005, -0.04, false);
  cylinder.rotation.z = Math.PI / 2;
  group.add(cylinder);
  const gripMesh = mesh(new THREE.BoxGeometry(0.085, 0.19, 0.105), grip, 0, -0.145, -0.005, false);
  gripMesh.rotation.x = -0.18;
  group.add(gripMesh);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.053, 0.009, 5, 16, Math.PI), darkSilver);
  guard.position.set(0, -0.075, 0.035);
  guard.rotation.z = Math.PI;
  group.add(guard);
  group.add(mesh(new THREE.SphereGeometry(0.025, 8, 6), black, 0, 0.12, 0.16, false));

  const muzzle = new THREE.Group();
  muzzle.position.set(0, 0.015, 0.365);
  muzzle.visible = false;
  const flashMat = new THREE.MeshBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.92, depthWrite: false });
  const flashCore = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), flashMat);
  flashCore.scale.set(0.8, 0.8, 1.5);
  muzzle.add(flashCore);
  const flareMat = new THREE.MeshBasicMaterial({ color: '#ff9d43', transparent: true, opacity: 0.8, depthWrite: false });
  const flare = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 8), flareMat);
  flare.rotation.x = Math.PI / 2;
  flare.position.z = 0.08;
  muzzle.add(flare);
  group.add(muzzle);
  return { group, muzzle };
}

/** Bright dust and sparks at a missed shot's first solid surface. Caller removes it when update returns false. */
export class ImpactPuff {
  readonly group = new THREE.Group();
  private age = 0;
  private readonly materials: THREE.MeshBasicMaterial[] = [];

  constructor(parent: THREE.Object3D, at: THREE.Vector3, normal: THREE.Vector3) {
    const n = normal.lengthSq() > 1e-5 ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
    this.group.position.copy(at).addScaledVector(n, 0.025);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    parent.add(this.group);
    const colors = ['#fff0bd', '#ffd28a', '#ff9d43', '#fffaf0', '#d4c6a6'];
    for (let i = 0; i < colors.length; i++) {
      const material = new THREE.MeshBasicMaterial({ color: colors[i], transparent: true, opacity: 0.9, depthWrite: false });
      const particle = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 0.055 : 0.026, 7, 5), material);
      const angle = (i / colors.length) * Math.PI * 2;
      particle.position.set(Math.cos(angle) * 0.035, 0, Math.sin(angle) * 0.035);
      this.group.add(particle);
      this.materials.push(material);
    }
  }

  update(dt: number): boolean {
    this.age += dt;
    const p = Math.min(1, this.age / 0.24);
    this.group.scale.setScalar(0.5 + p * 2.2);
    this.materials.forEach((m) => (m.opacity = (1 - p) * 0.9));
    this.group.position.y += dt * 0.18;
    return p < 1;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const object = o as THREE.Mesh;
      object.geometry?.dispose();
    });
    this.materials.forEach((m) => m.dispose());
  }
}
