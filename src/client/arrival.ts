import type { Arrival } from '../shared/protocol';
import { inElevator, SLAB } from '../shared/layout';
import { ROOF } from '../shared/rooftop';
import type { Spot } from './state';

/**
 * Where the owner stands on arrival: the arrival spot when it is a real place to stand, else the elevator car (null).
 * On any floor above the ground one there is nowhere to stand under the floor slab (the street and the garage are
 * only reachable from the ground floor), so a remembered spot down there is a fall that got saved, not a place:
 * the car it is, and the floor is under your feet again.
 */
export function standSpot(arrival: Arrival, blockedAt: (x: number, y: number, z: number) => boolean, floorIndex = -1): { x: number; y: number; z: number; rotY: number } | null {
  const at = arrival.at;
  if (!at || inElevator(at.x, at.z) || blockedAt(at.x, at.y, at.z)) return null;
  if (floorIndex > 0 && at.y < -SLAB - 0.05) return null;
  return at;
}

/** The notice when the remembered floor went while the owner was away, if it did. */
export function removedFloorNotice(arrival: Arrival, was: string | null, saved: Spot | null, floor: string | null): string | null {
  if (!arrival.removed || !was) return null;
  const name = saved?.floor === was && saved.name ? saved.name : 'Your floor';
  return floor === ROOF ? `🛗 ${name} isn't in the building any more, so the elevator brought you up to the roof` : `🛗 ${name} isn't in the building any more`;
}
