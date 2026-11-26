import type { KittyTerminalOptions } from '../term-kitty';
import type { GhosttyAdapter } from './ghostty';

/** Install APC, placement and expansion handling. A read-only Changes log has no expand callback. */
export function attachGhosttyGraphics(_adapter: GhosttyAdapter, _images?: KittyTerminalOptions): void {}
