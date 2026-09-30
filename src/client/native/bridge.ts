/**
 * `window.officeNative`: the native app's pull interface to the page. Android's host calls
 * `evaluateJavascript('window.officeNative.frame(...)')` at the gameplay rate and gets back one JSON
 * object: the next scene packet, the page's control state and the panel state. Nothing is installed
 * on import; the page calls installOfficeNative in native mode.
 */

import type { NativeScene, NativeSceneReport } from './scene';
import { DEFAULT_BUDGET, type Packet } from './wire';

export interface FrameArgs {
  /** Passed through to `control`. */
  frames?: number;
  /** Restart the scene stream: the packet carries a full snapshot with `reset: true`. */
  sceneReset?: boolean;
  /** The native queue is full: capture, but do not drain (nothing is lost, the state is kept). */
  skipScene?: boolean;
  /** JSON characters for this scene packet. */
  budget?: number;
}

export interface FrameResult<C, P> {
  scene: Packet | null;
  control: C;
  panel: P;
}

export interface OfficeNative<C, P> {
  frame(arg?: number | FrameArgs): FrameResult<C, P>;
  drain(budget?: number): Packet | null;
  capture(): void;
  reset(): void;
  report(): NativeSceneReport;
}

export interface OfficeNativeHooks<C, P> {
  scene: NativeScene;
  control: (frames: number | undefined) => C;
  panel: () => P;
}

/** Budgets outside this range are clamped (the native bridge's own packet limit sits above the top). */
const MIN_BUDGET = 16 * 1024;
const MAX_BUDGET = 3 * 1024 * 1024;

export function officeNative<C, P>(hooks: OfficeNativeHooks<C, P>): OfficeNative<C, P> {
  const { scene } = hooks;
  const clampBudget = (b: number | undefined) => Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, Number.isFinite(b) ? Number(b) : DEFAULT_BUDGET));
  return {
    frame(arg) {
      const a: FrameArgs = typeof arg === 'number' ? { frames: arg } : (arg ?? {});
      if (a.sceneReset) scene.reset();
      scene.capture();
      const packet = a.skipScene ? null : scene.drain(clampBudget(a.budget));
      return { scene: packet, control: hooks.control(a.frames), panel: hooks.panel() };
    },
    drain: (budget) => scene.drain(clampBudget(budget)),
    capture: () => scene.capture(),
    reset: () => scene.reset(),
    report: () => scene.report(),
  };
}

/** Defines `target.officeNative` (normally `window`) and returns it. */
export function installOfficeNative<C, P>(target: object, hooks: OfficeNativeHooks<C, P>): OfficeNative<C, P> {
  const api = officeNative(hooks);
  Object.defineProperty(target, 'officeNative', { value: api, configurable: true, writable: false, enumerable: false });
  return api;
}
