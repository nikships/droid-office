import * as THREE from 'three';
import { GONG } from '../../shared/layout';
import { mergeByMaterial, mesh, roundedBox, textPlane, toon, toonUnique } from './toon';
import type { Collider, Interactable } from './office';

// The gong: a steel disc hung in a black steel frame, next to the PR board. It rings when a pull
// request merges, and anyone can walk up and hit it; struck, it flashes orange.

const BRASS = '#e5e5e5';
const LACQUER = '#727272';
const INK = '#484848';
const ACCENT = '#ee6018';

export interface Gong {
  group: THREE.Group;
  colliders: Collider[];
  /** Walk up and press E. */
  interactable: Interactable;
  /** Swings the disc and flashes it; `strength` 1 is a good whack. */
  strike(strength?: number): void;
  /** Where confetti bursts from when there's no desk to burst over: just above the frame. */
  readonly top: THREE.Vector3;
  update(dt: number): void;
}

export function buildGong(): Gong {
  const { x, z, width, height } = GONG;
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const lacquer = toon(LACQUER);
  const ink = toon(INK);
  const half = width / 2;

  // The frame: two square steel posts on base plates, a beam across the top capped at both ends, and
  // a rail below it. Merged: none of it moves.
  const frame = new THREE.Group();
  for (const sx of [-half, half]) {
    frame.add(mesh(new THREE.BoxGeometry(0.12, height, 0.12), lacquer, sx, height / 2, 0));
    frame.add(mesh(roundedBox(0.24, 0.05, 0.6, 0.01), ink, sx, 0.025, 0));
    frame.add(mesh(new THREE.BoxGeometry(0.16, 0.03, 0.16), ink, sx, height + 0.015, 0, false));
  }
  frame.add(mesh(new THREE.BoxGeometry(width + 0.4, 0.16, 0.16), lacquer, 0, height - 0.08, 0));
  for (const sx of [-1, 1]) frame.add(mesh(new THREE.BoxGeometry(0.02, 0.18, 0.18), ink, sx * (half + 0.21), height - 0.08, 0, false));
  frame.add(mesh(new THREE.BoxGeometry(width, 0.07, 0.08), ink, 0, height - 0.32, 0, false));
  group.add(mergeByMaterial(frame));
  const plaque = textPlane('MERGE GONG', { bg: '#0a0a0a', color: '#eeeeee', border: '#2f2f2f', size: 48 });
  plaque.scale.multiplyScalar(0.5);
  plaque.position.set(0, height - 0.08, 0.1);
  group.add(plaque);

  // The disc hangs on two cords from a pivot under the beam, so it can swing when it's hit.
  const pivot = new THREE.Group();
  pivot.position.y = height - 0.34;
  group.add(pivot);
  const R = 0.62;
  const drop = 1.02;
  const brass = toonUnique(BRASS);
  brass.emissive = new THREE.Color(ACCENT);
  brass.emissiveIntensity = 0;
  const disc = new THREE.Group();
  disc.position.y = -drop;
  pivot.add(disc);
  disc.add(mesh(new THREE.CylinderGeometry(R, R, 0.05, 32).rotateX(Math.PI / 2), brass, 0, 0, 0));
  disc.add(mesh(new THREE.TorusGeometry(R, 0.04, 6, 32), brass, 0, 0, 0, false));
  disc.add(mesh(new THREE.TorusGeometry(R * 0.55, 0.018, 4, 32), toon('#c0c0c0'), 0, 0, 0.03, false));
  const boss = mesh(new THREE.SphereGeometry(0.16, 16, 12), brass, 0, 0, 0.02, false);
  boss.scale.z = 0.45;
  disc.add(boss);
  for (const sx of [-1, 1]) {
    const cord = mesh(new THREE.CylinderGeometry(0.012, 0.012, drop - R + 0.08, 5), ink, sx * 0.22, -(drop - R) / 2, 0, false);
    cord.rotation.z = sx * 0.2;
    pivot.add(cord);
  }

  // The mallet leans against the right post.
  const mallet = new THREE.Group();
  mallet.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6), ink, 0, 0.45, 0, false));
  mallet.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), toon('#808080'), 0, 0.92, 0, false));
  mallet.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 6), toon(ACCENT), 0, 0.8, 0, false));
  mallet.position.set(half + 0.18, 0, 0.12);
  mallet.rotation.z = 0.22;
  group.add(mallet);

  // A ring of sound spreading out from the disc when it's struck.
  const waveMat = new THREE.MeshBasicMaterial({ color: '#ef6f2e', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const wave = new THREE.Mesh(new THREE.RingGeometry(R * 0.95, R * 1.08, 40), waveMat);
  wave.position.set(0, pivot.position.y - drop, 0.08);
  wave.visible = false;
  group.add(wave);

  const colliders: Collider[] = [{ minX: x - half - 0.12, maxX: x + half + 0.3, minZ: z - 0.3, maxZ: z + 0.3, top: height + 0.1 }];
  const interactable: Interactable = { kind: 'gong', x, z: z + 1.3, radius: 1.5 };
  group.userData.interact = interactable;

  let swing = 0;
  let phase = 0;
  let glow = 0;
  let waveT = Infinity;
  let waveSize = 1;

  return {
    group,
    colliders,
    interactable,
    top: new THREE.Vector3(x, height + 0.4, z + 0.3),
    strike(strength = 1) {
      // Hit from the front, it swings back towards the wall first.
      swing = Math.min(0.3, swing * 0.5 + 0.16 * strength);
      phase = 0;
      glow = Math.min(1, 0.6 + 0.3 * strength);
      waveT = 0;
      waveSize = 1 + strength;
    },
    update(dt) {
      if (swing > 0.001) {
        phase += dt * Math.PI * 2 * 0.85;
        swing *= Math.exp(-dt * 0.9);
        pivot.rotation.x = swing * Math.sin(phase);
        disc.rotation.z = swing * 0.35 * Math.sin(phase * 1.6);
        // The metal shivers while it rings.
        disc.position.z = Math.sin(phase * 40) * 0.012 * glow;
      } else if (swing) {
        swing = 0;
        pivot.rotation.x = 0;
        disc.rotation.z = 0;
        disc.position.z = 0;
      }
      glow *= Math.exp(-dt * 2.5);
      brass.emissiveIntensity = glow * 0.55;
      waveT += dt;
      wave.visible = waveT < 0.9;
      if (wave.visible) {
        wave.scale.setScalar(1 + waveT * 2.2 * waveSize);
        waveMat.opacity = 0.55 * (1 - waveT / 0.9);
      }
    },
  };
}
