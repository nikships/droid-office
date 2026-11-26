import type { GhosttyAdapter } from './ghostty';

/** Called after Kitty key handling. snap() finishes an immediate scroll without starting a glide. */
export function attachGhosttyScroll(_adapter: GhosttyAdapter) {
  return { handleKey: (_event: KeyboardEvent): boolean => false, snap: (): void => {} };
}
