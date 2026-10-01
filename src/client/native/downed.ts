// Native (Galaxy XR): a shot worker's body, when nothing may open in front of you.
//
// The owner's design holds everywhere: a shot sends worker.shoot, the server starts the worker's
// persisted 30-second revival window, every client on the floor sees it go down, and worker.revive
// within that window stands it back up with its session untouched; otherwise the server dismisses
// it and the medics collect the body. In the headset all of it happens in the world:
//
// - The hit lands at once where the bullet struck (main.ts landShot): the worker is knocked out of
//   its chair along the bullet before the server's echo arrives (PendingShots keeps that local
//   fall from being undone by an unrelated update meanwhile).
// - The window's time is told by the body (world/casualties.ts): a heartbeat that slows and fades,
//   felt in a hand near it, its light glowing red with each beat, and a pool that creeps out to full
//   size at the deadline. No text, no countdown, nothing head-locked.
// - Reviving is the use action (trigger) with a free hand at the body: its tracked grip touching
//   it, or its ray pointing at it from within REVIVE_RANGE, the owner's walk-up distance
//   (native/physical.ts useAtBody). The body stirs at once and gets back up into its chair when the
//   server confirms.
//
// No DOM or WebGL at import time, so tests load it in Node.

import type * as THREE from 'three';
import type { Casualties } from '../world/casualties';

/** How close (meters) a free hand's grip must come to any part of a body on the floor to be at it. */
export const REVIVE_TOUCH = 0.45;
/** How far (meters) along a free hand's pointing ray a body can be revived: the owner's walk-up range. */
export const REVIVE_RANGE = 2.4;
/** How near (meters) the pointing ray must pass a body's length to point at it. */
export const REVIVE_AIM = 0.3;
/** How long (ms) a shot's local fall waits for the server's downed state before it gets back up. */
export const SHOT_ECHO_MS = 2500;

/** The body a free hand's use action lands on: the one its grip touches, else the one its ray points at. */
export function bodyAt(casualties: Pick<Casualties, 'reach' | 'along'>, grip: THREE.Vector3, ray: THREE.Ray | null): string | null {
  return casualties.reach(grip, REVIVE_TOUCH) ?? (ray ? casualties.along(ray, REVIVE_RANGE, REVIVE_AIM) : null);
}

/**
 * Shots this client resolved before the server's downed state came back. Until it does (or
 * SHOT_ECHO_MS passes without it), the local fall stands even though the worker's info says it
 * is up.
 */
export class PendingShots {
  private at = new Map<string, number>();

  add(id: string, now: number): void {
    this.at.set(id, now);
  }

  /** The server's downed state arrived (or the worker is gone): nothing left to wait for. */
  settle(id: string): void {
    this.at.delete(id);
  }

  /** Whether `id`'s local fall still waits on the server at `now`. */
  holds(id: string, now: number): boolean {
    const t = this.at.get(id);
    if (t === undefined) return false;
    if (now - t < SHOT_ECHO_MS) return true;
    this.at.delete(id);
    return false;
  }

  clear(): void {
    this.at.clear();
  }
}
