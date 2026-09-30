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

/**
 * Settings on the headset panel. The installed app always renders a head-tracked first-person view,
 * so the desktop's first/third person camera choice and its mouse-look notes are not offered.
 */
export const NATIVE_SETTINGS = {
  viewTitle: 'Headset view',
  viewMode: 'First person, head-tracked',
  view: 'The headset draws the office around you and your head movement is the camera. There is no third-person or mouse-look mode here; those are desktop views. Everyone on the desktop shares the same office, workers and boards with you.',
  movementTitle: 'Headset movement',
  movementControls: 'Motion controllers only. The left controller’s Menu button opens and closes the workspace; the trigger points and clicks; grip grabs things and puts back a carried card.',
  notify: 'The headset app does not show system notifications. Workers waiting on someone show on Home, with their status, and on the Next worker tile.',
} as const;
