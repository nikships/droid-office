/**
 * What the trigger does to something in the world in the headset app. On the desktop, E opens a
 * window for most things (a terminal, a board, the hire form). Native physical actions remain in
 * the world; office windows use the same desktop actions on the headset's compositor workspace.
 */

import type { InteractKind } from '../world/office';

export type NativeUse =
  /** Nothing happens: the thing has no in-world use in the headset (yet). */
  | { do: 'none' }
  /** An empty desk: its hire menu, floating at the desk. */
  | { do: 'hire-menu' }
  /** An occupied desk: opens its shared terminal, including wake/recovery when needed. */
  | { do: 'terminal' }
  /** The original office action, shown on the compositor workspace rather than a hidden window. */
  | { do: 'workspace' }
  /** A board agent's kiosk: the agent looks up, and its screen takes your typing. */
  | { do: 'talk' }
  /** The card in your hand goes where it was brought: a desk's worker, an empty desk, the queue, the issues board. */
  | { do: 'card' }
  /** A note on the issues board comes off the cork into your hand. */
  | { do: 'note' }
  /** A tab on the issues board's frame switches the wall. */
  | { do: 'tab' }
  /** Sit down, or stand up from the seat you are on. */
  | { do: 'sit' }
  | { do: 'stand' }
  /** A smoke break on the balcony, or stubbing it out. */
  | { do: 'smoke' }
  /** The DJ booth's air horn. */
  | { do: 'horn' }
  /** The machine monitor's refresh key for DroidProxy limits. */
  | { do: 'proxy' };

export interface NativeUseContext {
  /** An issue card is in your hand. */
  carrying: boolean;
  /** Whoever sits at the desk or kiosk it is, if anyone. */
  worker: { asleep: boolean; lost: boolean; downed: boolean } | null;
  /** The desk is the meeting table (nobody is hired there). */
  room: boolean;
  /** An issue note is under the ray. */
  note: boolean;
  /** A tab or a Jira card on the issues board's frame is under the ray. */
  spot: 'tab' | 'ticket' | null;
  /** You are sitting on the seat it is. */
  seated: boolean;
}

/** Every kind of thing in the world (world/office.ts InteractKind), for the exhaustive check. */
export const INTERACT_KINDS: readonly InteractKind[] = [
  'desk',
  'station',
  'issues',
  'pulls',
  'services',
  'queue',
  'tv',
  'coffee',
  'decor',
  'smoke',
  'elevator',
  'gong',
  'jukebox',
  'seat',
  'cabinet',
  'ladder',
  'pole',
  'meeting',
  'bar',
  'dj',
  'proxy',
  'bookshelf',
  'golf',
  'ball',
];

const NONE: NativeUse = { do: 'none' };

export function nativeUse(kind: InteractKind, c: NativeUseContext): NativeUse {
  switch (kind) {
    case 'desk':
      if (c.worker?.downed) return NONE;
      if (c.room && !c.worker) return { do: 'workspace' };
      if (c.carrying) return { do: 'card' };
      if (!c.worker) return { do: 'hire-menu' };
      return { do: 'terminal' };
    case 'station':
      return c.worker?.downed ? NONE : { do: 'talk' };
    case 'issues':
      if (c.carrying) return { do: 'card' };
      if (c.spot === 'tab') return { do: 'tab' };
      if (c.spot === 'ticket') return { do: 'workspace' };
      return c.note ? { do: 'note' } : { do: 'workspace' };
    case 'queue':
      return c.carrying ? { do: 'card' } : { do: 'workspace' };
    case 'seat':
      return c.seated ? { do: 'stand' } : { do: 'sit' };
    case 'smoke':
      return { do: 'smoke' };
    case 'dj':
      return { do: 'horn' };
    case 'proxy':
      return { do: 'proxy' };
    // The gong, the ladder and the poles are physical (native/physical.ts); the cup is picked up by hand.
    case 'gong':
    case 'ladder':
    case 'pole':
    case 'coffee':
    // These office windows retain their shared behavior on the compositor workspace.
    case 'pulls':
    case 'services':
    case 'tv':
    case 'decor':
    case 'elevator':
    case 'jukebox':
    case 'meeting':
    case 'bar':
    case 'bookshelf':
      return { do: 'workspace' };
    // These games move the desktop camera and still need a headset-specific control scheme.
    case 'cabinet':
    case 'golf':
    case 'ball':
      return NONE;
  }
}
