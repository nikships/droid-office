/**
 * The office page in the headset app (`/?native=1`). The app draws the office in 3D around the
 * player; office windows use the original DOM and terminal on its compositor workspace. APK-owned
 * graphics settings are separate from this page. A paired keyboard goes to a visible workspace
 * field or terminal, or to the laptop/kiosk in the world when the workspace is closed.
 */

import './native.css';
import { closeAllModals, closeTopModal, h, modalOpen, onModalChange, refusedModals, setModalGate } from '../ui/dom';
import { closeFloorMenu, floorMenuOpen } from '../ui/floormenu';
import { openTerminalFor } from '../ui/terminal';
import { installNativeSelects } from './select';
import type { CarriedIssue } from '../../shared/protocol';
import { isNativeSearch } from './mode';

export { isNativeSearch };

/** The page was opened for the headset app. */
export function isNativeMode(): boolean {
  return isNativeSearch(location.search);
}

/**
 * What the headset app's compositor workspace shows. Its producer is stopped when nothing is open.
 */
export interface NativePanelState {
  open: boolean;
  home: boolean;
  modal: boolean;
  floorMenu: boolean;
  typing: boolean;
  terminal: string | null;
  /** The original shared board card carried by this player. */
  carrying: CarriedIssue | null;
}

export interface NativeUi {
  panelState(): NativePanelState;
  /** Hears every change of panelState; returns the unlisten. */
  onPanelChange(fn: (state: NativePanelState) => void): () => void;
  /** Shows the office navigation, or closes the workspace and its windows. */
  setPanelOpen(open: boolean): void;
  /** APK-owned settings block world input but do not open the page's workspace. */
  setNativeSettingsOpen(open: boolean): void;
  blocked(): boolean;
  /** Goes back one window, floor list or workspace step. */
  back(): boolean;
  setCarrying(card: CarriedIssue | null): void;
  /** Diagnostic count of windows refused by a modal gate. */
  refused(): number;
}

let instance: NativeUi | null = null;

/** Sets up the headset page. Call once, early, only on `/?native=1` (see isNativeMode). Calling it again returns the same one. */
export function initNativeUi(): NativeUi {
  if (instance) return instance;
  document.documentElement.classList.add('native-xr');
  document.body.classList.add('native-xr');
  noPointerLock();
  setModalGate(null);
  installNativeSelects();

  const listeners = new Set<(s: NativePanelState) => void>();
  let home = false;
  let nativeSettings = false;
  let carrying: CarriedIssue | null = null;
  const panelState = (): NativePanelState => {
    const modal = modalOpen();
    const floorMenu = floorMenuOpen();
    const field = document.activeElement as HTMLElement | null;
    const typing = !!field && (field.matches('input, textarea, select') || field.isContentEditable);
    return { open: home || modal || floorMenu, home, modal, floorMenu, typing, terminal: openTerminalFor(), carrying };
  };
  const notify = () => {
    const s = panelState();
    document.body.classList.toggle('native-workspace-open', s.open);
    for (const fn of listeners) fn(s);
  };
  onModalChange(notify);
  document.addEventListener('focusin', notify);
  document.addEventListener('focusout', notify);
  const close = h('button.btn.native-workspace-close', { type: 'button', 'aria-label': 'Close workspace', onclick: () => instance?.setPanelOpen(false) }, 'Close workspace');
  document.body.append(close);

  instance = {
    panelState: () => {
      const state = panelState();
      document.body.classList.toggle('native-workspace-open', state.open);
      return state;
    },
    onPanelChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setPanelOpen(open) {
      home = open;
      if (!open) {
        closeAllModals();
        closeFloorMenu();
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      notify();
    },
    setNativeSettingsOpen(open) {
      nativeSettings = open;
    },
    blocked: () => nativeSettings || panelState().open,
    back() {
      if (closeTopModal()) return true;
      if (floorMenuOpen()) {
        closeFloorMenu();
        notify();
        return true;
      }
      if (!home) return false;
      instance!.setPanelOpen(false);
      return true;
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
