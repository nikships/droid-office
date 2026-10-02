import type { Arrival } from '../shared/protocol';
import { inElevator } from '../shared/layout';
import { ROOF } from '../shared/rooftop';
import type { Spot } from './state';

/** Where the owner stands on arrival: the arrival spot when it is a real place to stand, else the elevator car (null). */
export function standSpot(arrival: Arrival, blockedAt: (x: number, y: number, z: number) => boolean): { x: number; y: number; z: number; rotY: number } | null {
  const at = arrival.at;
  if (!at || inElevator(at.x, at.z) || blockedAt(at.x, at.y, at.z)) return null;
  return at;
}

/** The notice when the remembered floor went while the owner was away, if it did. */
export function removedFloorNotice(arrival: Arrival, was: string | null, saved: Spot | null, floor: string | null): string | null {
  if (!arrival.removed || !was) return null;
  const name = saved?.floor === was && saved.name ? saved.name : 'Your floor';
  return floor === ROOF ? `🛗 ${name} isn't in the building any more, so the elevator brought you up to the roof` : `🛗 ${name} isn't in the building any more`;
}
