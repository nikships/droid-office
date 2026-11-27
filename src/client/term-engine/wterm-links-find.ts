import type { GhosttyCore } from '@wterm/ghostty';
import { findLine } from '../../shared/search';
import type { TerminalFind } from './types';
import type { WTermAdapter } from './wterm';
import { retainedRows } from './wterm-links-lines';
import { searchStarting } from './wterm-search-controls';

export const missingLine = 'That line has scrolled out of the terminal since';

export function installFind(adapter: WTermAdapter, core: GhosttyCore, grid: HTMLElement, signal: AbortSignal) {
  const root = grid.parentElement!;
  let clear: (() => void) | undefined;
  root.addEventListener(searchStarting, () => clear?.(), { signal });
  adapter.onReset(() => clear?.());
  signal.addEventListener('abort', () => clear?.(), { once: true });
  return ({ needle, fromEnd }: TerminalFind) => {
    const rows = retainedRows(core);
    const row = findLine(rows, needle, fromEnd);
    if (row === undefined) return missingLine;
    clear?.();
    const marker = core.trackPosition({ row, col: 0 });
    if (!marker) return missingLine;
    adapter.cancelReaderRestore();
    root.dispatchEvent(new Event(searchStarting));
    const text = rows.logical(row)!.text;
    let previousSize = '',
      scrolled = false;
    function paint() {
      const pos = marker?.resolve();
      const line = pos && retainedRows(core).logical(pos.row);
      if (!line || line.text !== text) return clear?.();
      const height = parseFloat(getComputedStyle(root).getPropertyValue('--term-row-height'));
      const size = `${adapter.cols}:${adapter.rows}:${height}`;
      if (previousSize !== size || !scrolled) {
        const top = Math.max(0, line.start - Math.floor(adapter.rows / 3)) * height;
        root.scrollTop = top;
        // wterm materializes virtual history on the next render after a write/resize.
        scrolled = root.scrollTop >= Math.min(top, core.getScrollbackCount() * height) - 1;
        previousSize = size;
      }
      for (const el of grid.querySelectorAll<HTMLElement>(':scope > .term-row')) {
        const y = Math.round(el.offsetTop / height);
        el.classList.toggle('wterm-find-line', y >= line.start && y <= line.end);
      }
    }
    // The initial snapshot has parsed before its virtual rows and follow-tail
    // scroll are committed. Even a requested offset of zero must wait for paint.
    const frame = requestAnimationFrame(() => {
      scrolled = false;
      paint();
    });
    const observer = new MutationObserver(paint);
    // Virtual rows are mounted/unmounted as the user scrolls; resize replaces them.
    observer.observe(grid, { childList: true });
    const sub = adapter.onWriteParsed(paint);
    const timer = setTimeout(() => clear?.(), 8000);
    clear = () => {
      clear = undefined;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      sub.dispose();
      marker.dispose();
      for (const el of grid.querySelectorAll('.wterm-find-line')) el.classList.remove('wterm-find-line');
    };
    paint();
    return undefined;
  };
}
