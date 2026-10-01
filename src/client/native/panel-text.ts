// Text the headset panel derives from office state, and the copy it shows in place of desktop-only
// choices. Pure, so tests run it in Node.

import type { WorkerInfo } from '../../shared/protocol';

/**
 * A worker across repositories, as one line: how many, its own floor's first, then the others'
 * folders. Empty for a worker in one checkout.
 */
export function workerReposLine(w: Pick<WorkerInfo, 'repos'>, ownName: string | undefined): string {
  if (!w.repos?.length) return '';
  const names = [ownName ?? 'this floor', ...w.repos.map((r) => r.name)];
  return `📚 ${names.length} repositories: ${names.join(', ')}`;
}

/** Fixed roles for the installed app; WebXR retains its own control scheme. */
export const NATIVE_CONTROL_ROWS: readonly (readonly [string, string])[] = [
  ['Left Menu', 'Open or hide the workspace. The right Menu button belongs to Android XR.'],
  ['Left stick', 'Move when Smooth movement is enabled. Hold the stick click to sprint.'],
  ['Right stick', 'Left/right turns. Push forward to aim a teleport; release to travel. Works with Smooth movement too.'],
  ['X · left', 'Go to the next waiting worker.'],
  ['Y · left', 'Open or close Find anything.'],
  ['A · right', 'Jump in the office.'],
  ['B · right', 'Go back in the workspace. In the office, return a held issue card.'],
  ['Right stick click', 'Show or hide the keyboard while the workspace is open.'],
  ['Triggers', 'Point and click in the workspace, use desks and elevator buttons, or place a held card.'],
  ['Grips', 'Hold nearby objects. Grip does not navigate menus or return cards.'],
  ['Merge gong', 'Strike the brass disc with either controller. Pull away before striking again.'],
  ['Ladder', 'Hold grip on a rung or rail. Pull your hand down to climb up; alternate hands naturally. Release both grips to let go.'],
  ['Fire pole', 'Hold grip on the pole to slide. Move your held hand sideways to turn around it. Release both grips to step off at the next floor.'],
  ['Gun', 'Reach behind your back and press grip to draw. Keep grip held; trigger fires. Release behind your back to holster, or elsewhere to drop it.'],
];

/**
 * Settings on the headset panel. The installed app always renders a head-tracked first-person view,
 * so the desktop's first/third person camera choice and its mouse-look notes are not offered.
 */
export const NATIVE_SETTINGS = {
  viewTitle: 'Headset view',
  viewMode: 'First person, head-tracked',
  view: 'The headset draws the office around you and your head movement is the camera. There is no third-person or mouse-look mode here; those are desktop views. Everyone on the desktop shares the same office, workers and boards with you.',
  movementTitle: 'Headset movement',
  movementControls:
    'Motion controllers only. The left controller’s Menu button opens and closes the workspace; the right Menu button belongs to Android XR. Left stick moves (click to sprint), right stick turns or aims a teleport. X goes to a waiting worker; Y opens commands; A jumps; B goes back. Triggers point and click; grip holds objects. See Controls for climbing, the pole and the gun.',
  notify: 'The headset app does not show system notifications. Workers waiting on someone show on Home, with their status, and on the Next worker tile.',
} as const;
