/**
 * What the trigger does to something in the world in the headset app. On the desktop, E opens a
 * window for most things (a terminal, a board, the hire form); the headset app has no workspace, so
 * here each thing either does its job in the world or does nothing. The one menu it opens is the
 * hire menu that floats at an empty desk (native/menus.ts). main.ts nativeUse runs these, and never
 * the desktop's interact().
 */

import type { InteractKind } from '../world/office';

export type NativeUse =
  /** Nothing happens: the thing has no in-world use in the headset (yet). */
  | { do: 'none' }
  /** An empty desk: its hire menu, floating at the desk. */
  | { do: 'hire-menu' }
  /** An occupied desk: its laptop takes the paired keyboard's keys (its screen lights up). */
  | { do: 'laptop' }
  /** A sleeping worker: it wakes up at its desk. */
  | { do: 'wake' }
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
      // The meeting table: the desktop's meeting form has no place in the headset.
      if (c.room && !c.worker) return NONE;
      if (c.carrying) return { do: 'card' };
      if (!c.worker) return { do: 'hire-menu' };
      if (c.worker.lost) return NONE;
      return c.worker.asleep ? { do: 'wake' } : { do: 'laptop' };
    case 'station':
      return c.worker?.downed ? NONE : { do: 'talk' };
    case 'issues':
      if (c.carrying) return { do: 'card' };
      if (c.spot === 'tab') return { do: 'tab' };
      if (c.spot === 'ticket') return NONE;
      return c.note ? { do: 'note' } : NONE;
    case 'queue':
      return c.carrying ? { do: 'card' } : NONE;
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
    // These open a desktop window (or a desktop-only game) and have no in-world use in the headset yet.
    case 'pulls':
    case 'services':
    case 'tv':
    case 'decor':
    case 'elevator':
    case 'jukebox':
    case 'cabinet':
    case 'meeting':
    case 'bar':
    case 'bookshelf':
    case 'golf':
    case 'ball':
      return NONE;
  }
}
