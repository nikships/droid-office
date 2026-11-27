import { enterKeyAction } from '../term-keys';
import type { WTermAdapter } from './wterm';

export function attachWtermKeys(_adapter: WTermAdapter) {
  return { keyAction: (event: KeyboardEvent, csiEnter: boolean) => enterKeyAction(csiEnter, event) };
}
