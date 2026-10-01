/**
 * The office page in the headset app (`/?native=1`). The app draws the office in 3D around the
 * player, and, as the owner decided, shows no workspace: the desktop's top bar, menus and windows
 * never appear in the headset. Every in-world action plays out in the world (main.ts nativeUse), the
 * left controller's Menu button opens the small settings menu that floats where it was opened, and an
 * empty desk's hire menu floats at that desk (native/menus.ts). Keys from a keyboard paired to the
 * headset type into the laptop or kiosk you are at (native/typing.ts).
 *
 * initNativeUi hides the page itself and refuses every window (ui/dom.ts setModalGate), so nothing
 * an event, a server message or a stray key does can raise the workspace panel or block the world
 * behind an unseen window. panelState() reports the panel closed to the headset app, always.
 */

import './native.css';
import { closeAllModals, refusedModals, setModalGate } from '../ui/dom';
import { closeFloorMenu, floorMenuOpen } from '../ui/floormenu';
import type { CarriedIssue } from '../../shared/protocol';
import { isNativeSearch } from './mode';

export { isNativeSearch };

/** The page was opened for the headset app. */
export function isNativeMode(): boolean {
  return isNativeSearch(location.search);
}

/**
 * What the headset app's workspace panel shows: nothing, ever, on the office page. The shape stays
 * the one the native bridge and the capture harness read.
 */
export interface NativePanelState {
  /** Whether the panel has something to show: always false. */
  open: false;
  home: false;
  modal: false;
  floorMenu: false;
  typing: false;
  terminal: null;
  /** The original shared board card carried by this player. */
  carrying: CarriedIssue | null;
}

export interface NativeUi {
  panelState(): NativePanelState;
  /** Hears every change of panelState; returns the unlisten. */
  onPanelChange(fn: (state: NativePanelState) => void): () => void;
  /** The workspace never opens; false also clears anything the page left behind (a floor list, a focused field). */
  setPanelOpen(open: boolean): void;
  setCarrying(card: CarriedIssue | null): void;
  /** How many windows were refused since the page loaded (none ever shows in the headset). */
  refused(): number;
}

let instance: NativeUi | null = null;

/** Sets up the headset page. Call once, early, only on `/?native=1` (see isNativeMode). Calling it again returns the same one. */
export function initNativeUi(): NativeUi {
  if (instance) return instance;
  document.documentElement.classList.add('native-xr');
  document.body.classList.add('native-xr');
  noPointerLock();
  // No window opens in the headset app: it would sit unseen on a panel nobody shows and hold the world still.
  setModalGate(() => false);
  closeAllModals();

  const listeners = new Set<(s: NativePanelState) => void>();
  let carrying: CarriedIssue | null = null;
  const panelState = (): NativePanelState => ({ open: false, home: false, modal: false, floorMenu: false, typing: false, terminal: null, carrying });
  const notify = () => {
    const s = panelState();
    for (const fn of listeners) fn(s);
  };

  instance = {
    panelState,
    onPanelChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setPanelOpen(open) {
      if (open) return;
      closeAllModals();
      if (floorMenuOpen()) closeFloorMenu();
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    setCarrying(card) {
      if ((carrying?.issue ?? 0) === (card?.issue ?? 0) && (carrying?.title ?? '') === (card?.title ?? '')) return;
      carrying = card ? { issue: card.issue, title: card.title } : null;
      notify();
    },
    refused: refusedModals,
  };
  return instance;
}

/**
 * Nothing on the page is pointed at, so nothing may capture a mouse: a pointer lock taken on the
 * hidden 3D view (the desktop takes one when a window closes) would swallow input. Without
 * requestPointerLock the player's canLock is false, so it stops asking.
 */
function noPointerLock() {
  const scene = document.getElementById('scene');
  if (scene) Object.defineProperty(scene, 'requestPointerLock', { configurable: true, value: undefined });
  const release = () => {
    if (document.pointerLockElement) document.exitPointerLock();
  };
  document.addEventListener('pointerlockchange', release);
  release();
}
