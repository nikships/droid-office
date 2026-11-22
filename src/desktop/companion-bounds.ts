export const COMPANION_DEFAULT_WIDTH = 1200;
export const COMPANION_DEFAULT_HEIGHT = 800;
export const COMPANION_MIN_WIDTH = 720;
export const COMPANION_MIN_HEIGHT = 480;

export interface CompanionBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  fullScreen?: boolean;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolvedCompanionBounds extends CompanionBounds {
  maximized: boolean;
  fullScreen: boolean;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function parseCompanionBounds(raw: unknown): CompanionBounds | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { x, y, width, height, maximized, fullScreen } = raw as Record<string, unknown>;
  if (!integer(width) || !integer(height)) return undefined;
  const hasPosition = integer(x) && integer(y);
  if (!hasPosition && (x !== undefined || y !== undefined)) return undefined;
  if (maximized !== undefined && typeof maximized !== 'boolean') return undefined;
  if (fullScreen !== undefined && typeof fullScreen !== 'boolean') return undefined;
  return {
    width: Math.max(COMPANION_MIN_WIDTH, width),
    height: Math.max(COMPANION_MIN_HEIGHT, height),
    ...(hasPosition ? { x, y } : {}),
    ...(maximized === undefined ? {} : { maximized }),
    ...(fullScreen === undefined ? {} : { fullScreen }),
  };
}

function overlap(origin: number, size: number, workOrigin: number, workSize: number): number {
  return Math.max(0, Math.min(origin + size, workOrigin + workSize) - Math.max(origin, workOrigin));
}

/** Keep the window on the display with the most overlap, or center it on the first (primary) display. */
export function resolveCompanionBounds(saved: CompanionBounds | undefined, workAreas: readonly Rect[]): ResolvedCompanionBounds {
  const { x, y, maximized = false, fullScreen = false } = saved ?? {};
  let width = Math.max(saved?.width ?? COMPANION_DEFAULT_WIDTH, COMPANION_MIN_WIDTH);
  let height = Math.max(saved?.height ?? COMPANION_DEFAULT_HEIGHT, COMPANION_MIN_HEIGHT);
  let matched: Rect | undefined;
  if (x !== undefined && y !== undefined) {
    let largestOverlap = 0;
    for (const area of workAreas) {
      const size = overlap(x, width, area.x, area.width) * overlap(y, height, area.y, area.height);
      if (size > largestOverlap) {
        matched = area;
        largestOverlap = size;
      }
    }
  }
  const area = matched ?? workAreas[0];
  if (!area) return { width, height, maximized, fullScreen };
  width = Math.min(width, area.width);
  height = Math.min(height, area.height);
  const left = matched && x !== undefined ? Math.max(area.x, Math.min(x, area.x + area.width - width)) : area.x + Math.floor((area.width - width) / 2);
  const top = matched && y !== undefined ? Math.max(area.y, Math.min(y, area.y + area.height - height)) : area.y + Math.floor((area.height - height) / 2);
  return { x: left, y: top, width, height, maximized, fullScreen };
}
