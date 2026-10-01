// Native (Galaxy XR): what a bullet does to a worker when nothing may open in front of you.
//
// The desktop asks what to do with a shot worker in a dialog. The headset never does: a hit plays
// out where it lands, and every choice after it is a physical act at the body. The first bullet
// drops the worker out of its chair, its session still running (world/casualties.ts shoot). A
// stray shot can do no more than that. Ending the session takes a second, aimed bullet into the
// body once it has lain still for FINISH_AFTER seconds; a quick double tap only drops it. Hauling
// the body back up into its chair by hand revives it instead (native/physical.ts haul). Each
// downed worker has its own casualty scene, so several can be down at once.
//
// No DOM or WebGL at import time, so tests load it in Node.

import type * as THREE from 'three';
import type { Casualties, CasualtyModel } from '../world/casualties';
import type { ShotOutcome } from './stage';

/** Seconds a downed worker must have lain still on the floor before another bullet into it ends its session. */
export const FINISH_AFTER = 0.8;

/** How close (meters) a hand must come to a body on the floor to take hold of it. */
export const HAUL_REACH = 0.4;

/**
 * A bullet struck worker `id` in the headset. A worker in its chair goes down ('down'). A body
 * already down jerks where it lies ('hit'), and one that has lain still long enough is finished
 * off: `finish(id)` sends its kill, at most once ('finished'). `sent` holds the kills already sent.
 */
export function shootInWorld(
  casualties: Pick<Casualties, 'shoot' | 'nudge' | 'lyingFor' | 'finish'>,
  id: string,
  model: CasualtyModel,
  seat: THREE.Object3D,
  direction: THREE.Vector3,
  sent: ReadonlySet<string>,
  finish: (id: string) => void,
): ShotOutcome {
  if (casualties.shoot(id, model, seat, direction)) return 'down';
  if (!casualties.nudge(id, direction)) return 'hit';
  const lying = casualties.lyingFor(id);
  if (sent.has(id) || lying === null || lying < FINISH_AFTER) return 'hit';
  casualties.finish(id);
  finish(id);
  return 'finished';
}
