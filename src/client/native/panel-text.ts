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
  ['Left Menu', 'Open or put away the app’s native settings. Office workspace opens the shared terminals and office tools. The right Menu button belongs to Android XR.'],
  ['Left stick', 'Move when Smooth movement is enabled. Hold the stick click to sprint.'],
  ['Right stick', 'Left/right turns. Push forward to aim a teleport; release to travel. Works with Smooth movement too.'],
  ['X · left', 'Go to the next waiting worker.'],
  ['Y · left', 'Open or close Find anything.'],
  ['A · right', 'Jump in the office.'],
  ['B · right', 'Put away an open menu, or return a held issue card.'],
  ['Triggers', 'Use desks, kiosks and elevator buttons, press menu rows, or place a held card. At an empty desk, open its hire menu.'],
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
    'Motion controllers only. The left controller’s Menu button opens the app’s native settings; Office workspace opens the shared terminals and tools. The right Menu button belongs to Android XR. Left stick moves (click to sprint), right stick turns or aims a teleport. X goes to a waiting worker; Y opens Find anything; A jumps; B goes back. Triggers use what they point at; grip holds objects. A keyboard paired to the headset types into the open terminal or field, or the laptop you are at when the workspace is closed. See Controls for climbing, the pole and the gun.',
  notify: 'The headset app does not show system notifications. A worker waiting on someone blinks the lamp on its desk’s nameplate.',
} as const;
