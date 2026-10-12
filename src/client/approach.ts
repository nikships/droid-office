// Where you stand to use a desk, and how the camera arrives there. N, "go to desk", the command
// palette and window.office all use this pose. A non-desk spot still aims with pitchToward.

import { deskSeat, type DeskDef } from '../shared/layout';

/** How far down you look on arriving at a desk. Camera presets and the elevator stay level, at -0.08. */
export const DESK_LOOK_PITCH = -0.2;

export interface ApproachPose {
  /** Where your feet go. */
  at: { x: number; y: number; z: number };
  /** PlayerController.facing: 0 faces +z. The camera's yaw is this minus π. */
  facing: number;
  lookPitch: number;
  /** What you turn toward. A desk's pitch is fixed and must not be replaced by pitchToward(face). */
  face: { x: number; y: number; z: number };
  /** True at a desk: lookPitch is DESK_LOOK_PITCH, not pitchToward. */
  pitchFixed: boolean;
}

/** In front of a kiosk, beside a bean bag, or behind a worker. */
function standOff(desk: DeskDef): number {
  return desk.station ? -1.6 : desk.beanbag ? 1.6 : 2.4;
}

/** The one pose for standing at a desk: the spot, the facing, and the pitch. */
export function deskApproach(desk: DeskDef): ApproachPose {
  const spot = deskSeat(desk, standOff(desk));
  const at = { x: spot.x, y: 0, z: spot.z };
  const face = { x: desk.x, y: 0.9, z: desk.z };
  return {
    at,
    facing: Math.atan2(face.x - at.x, face.z - at.z),
    lookPitch: DESK_LOOK_PITCH,
    face,
    pitchFixed: true,
  };
}
