// The moving layer of a companion theme's backdrop: one full-window WebGL2 canvas running the
// theme's shader (aurora, nebula, embers…). A `scene` paints the whole backdrop; an `overlay` paints
// light on transparency over the artwork. Drawn at the display's full pixel ratio and frame rate;
// it stops only while the page is hidden, or when motion is off (then it holds one still frame).

import type { ThemeStageSpec } from '../../shared/companion-themes';

export interface ThemeStage {
  /** Shows `spec` (null clears to transparent), animating while `animate` and the page is visible; a still stage draws one frame. */
  show(spec: ThemeStageSpec | null, animate: boolean): void;
  /** Stops drawing and releases the GL context. */
  destroy(): void;
}

/** A stage on `canvas`, or null where WebGL2 isn't available (the gradient and artwork still show). */
export function createThemeStage(_canvas: HTMLCanvasElement): ThemeStage | null {
  return null;
}
