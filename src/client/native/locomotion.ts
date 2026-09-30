/**
 * The VR session's collision and rig math, as free functions over the PlayerController, so
 * the native controls move the same body through the same colliders as WebXR and desktop.
 * These mirror the private VRSession methods of the same names (vr/session.ts).
 */

import * as THREE from 'three';
import { GRAVITY, STEP } from '../player';
import type { PlayerController } from '../player';

type Body = Pick<PlayerController, 'pos' | 'vy' | 'grounded' | 'stepOffset' | 'street' | 'groundBelow' | 'blockedAt'>;

/** First arc point at or below the floor it's over, when it's somewhere standable (VRSession.findLanding). */
export function findLanding(player: Body, pts: readonly THREE.Vector3[]): THREE.Vector3 | null {
  for (const p of pts) {
    const g = Math.max(player.groundBelow(p.x, p.z, p.y + 1), player.street);
    if (!Number.isFinite(g) || p.y > g + 0.1) continue;
    if (Math.abs(g - player.pos.y) > 8) continue;
    if (player.blockedAt(p.x, p.z, g)) continue;
    return new THREE.Vector3(p.x, g, p.z);
  }
  return null;
}

/** Stay on the floor: up stairs freely, down a step at a time, never through the loft (VRSession.snapGround). */
export function snapGround(player: Body): void {
  const g = Math.max(player.groundBelow(player.pos.x, player.pos.z, player.pos.y), player.street);
  if (!Number.isFinite(g)) return;
  if (g > player.pos.y) player.pos.y = g;
  else if (player.pos.y - g <= STEP + 0.02) player.pos.y = g;
}

/** Falling while the desktop update is off: player.update's gravity minus the jump (VRSession.applyGravity). */
export function applyGravity(player: Body, dt: number): void {
  const g = Math.max(player.groundBelow(player.pos.x, player.pos.z, player.pos.y), player.street);
  if (!Number.isFinite(g)) return;
  if (player.grounded && player.pos.y > g && player.pos.y - g <= STEP + 0.02) {
    player.stepOffset += player.pos.y - g;
    player.pos.y = g;
  }
  player.vy -= GRAVITY * dt;
  player.pos.y += player.vy * dt;
  if (player.pos.y <= g) {
    player.pos.y = g;
    player.vy = 0;
    player.grounded = true;
  } else if (player.pos.y > g + 0.02) {
    player.grounded = false;
  }
}

/** Puts the avatar on a landing (VRSession.placeAvatar). */
export function placeAvatar(player: Body, at: THREE.Vector3): void {
  player.pos.set(at.x, at.y, at.z);
  player.vy = 0;
  player.grounded = true;
  snapGround(player);
}

const _f = new THREE.Vector3();

/** Heading of a rotation's -Z on the XZ plane, in the avatar's atan2(x, z) convention. */
export function headingOf(q: THREE.Quaternion): number {
  _f.set(0, 0, -1).applyQuaternion(q);
  return Math.atan2(_f.x, _f.z);
}

/**
 * The rig yaw and origin that put a head (native pose `local`, `localQuat`) over `feet`,
 * looking along `facing`. A rotation by `yaw` about +Y adds `yaw` to an atan2(x, z) heading.
 */
export function rigFor(local: THREE.Vector3, localQuat: THREE.Quaternion, feet: THREE.Vector3, facing: number, out: THREE.Vector3): number {
  const yaw = facing - headingOf(localQuat);
  _f.set(local.x, 0, local.z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
  out.set(feet.x - _f.x, feet.y, feet.z - _f.z);
  return Math.atan2(Math.sin(yaw), Math.cos(yaw));
}

/**
 * A room-scale step toward (x, z) in pieces of at most `max` meters. PlayerController.stepTo
 * checks an axis step's endpoint, so one long step could cross a thin wall; the native brain
 * runs at 30 Hz, so a head moves further between its steps than it does between WebXR frames.
 */
export function stepToward(player: Pick<PlayerController, 'pos' | 'stepTo'>, x: number, z: number, max = 0.1): void {
  const dx = x - player.pos.x;
  const dz = z - player.pos.z;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / max));
  // Each piece starts from where the last one stopped: a blocked piece must not let the next jump past it.
  for (let i = 0; i < steps; i++) player.stepTo(player.pos.x + dx / steps, player.pos.z + dz / steps);
}
