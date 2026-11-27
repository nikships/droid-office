import type { WTermAdapter } from './wterm';

export function attachWtermScroll(_adapter: WTermAdapter) {
  return { handleKey: (_event: KeyboardEvent) => false, snap() {} };
}
