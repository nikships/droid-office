import type { TerminalCore } from '@wterm/core';
import type { WTermAdapter } from './wterm';

/** Display-only view; the original cell data remains available to graphics and links. */
export function wtermAppearance(core: TerminalCore, _adapter: WTermAdapter): TerminalCore {
  return core;
}
