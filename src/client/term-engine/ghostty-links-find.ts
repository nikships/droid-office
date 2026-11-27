import type { Terminal } from 'ghostty-web';
import { findLine, searchKey } from '../../shared/search';
import { stripKittyPlaceholders } from '../../shared/kitty';
import type { GhosttyAdapter } from './ghostty';
import { ghosttyLines } from './ghostty-links-lines';
import type { TerminalFind } from './types';

export const missingLine = 'That line has scrolled out of the terminal since';

/** Stock CanvasRenderer displays whole rows, flooring the bottom-relative offset. */
export const viewportTop = (term: Terminal) => term.getScrollbackLength() - Math.floor(term.getViewportY());

export function searchGhostty(adapter: GhosttyAdapter, term: Terminal, lifetime: AbortSignal) {
  let cleanup: (() => void) | undefined;
  lifetime.addEventListener('abort', () => cleanup?.(), { once: true });
  return (hit: TerminalFind): string | undefined => {
    cleanup?.();
    const { renderer, wasmTerm: core, element } = term;
    if (!renderer || !core || !element) return missingLine;
    const locate = () => {
      const { buffer, wrapped } = ghosttyLines(core);
      const row = findLine(buffer, hit.needle, hit.fromEnd);
      if (row === undefined) return;
      let end = row;
      while (wrapped(end + 1)) end++;
      return { row, end };
    };
    let range = locate();
    if (!range) return missingLine;
    const mark = document.createElement('div');
    mark.className = 'ghostty-find-line';
    if (adapter.options.theme?.yellow) mark.style.backgroundColor = adapter.options.theme.yellow;
    mark.setAttribute('aria-hidden', 'true');
    element.append(mark);
    const draw = () => {
      const top = viewportTop(term);
      const first = Math.max(0, (range?.row ?? -1) - top);
      const end = Math.min(term.rows, (range?.end ?? -1) - top + 1);
      mark.hidden = first >= end;
      if (mark.hidden) return;
      const canvas = renderer.getCanvas();
      const { height, width } = renderer.getMetrics();
      mark.style.top = `${canvas.offsetTop + first * height}px`;
      mark.style.left = `${canvas.offsetLeft}px`;
      mark.style.width = `${width * term.cols}px`;
      mark.style.height = `${height * (end - first)}px`;
    };
    const center = () => {
      if (range) term.scrollToLine(term.getScrollbackLength() - Math.max(0, range.row - Math.floor(term.rows / 3)));
      draw();
    };
    center();
    const settleUntil = performance.now() + 1500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resize = term.onResize(() => {
      const settling = performance.now() <= settleUntil;
      clearTimeout(timer);
      timer = setTimeout(() => {
        range = locate();
        if (settling) center();
        else draw();
      }, 50);
    });
    const scroll = term.onScroll(draw);
    // Do not leave a decoration on unrelated output after replacement or history trimming.
    const parsed = adapter.onWriteParsed(() => {
      if (!range) return;
      const { buffer } = ghosttyLines(core);
      let text = '';
      for (let row = range.row; row <= range.end; row++) text += buffer.getLine(row)?.translateToString(row === range.end) ?? '';
      if (!searchKey(stripKittyPlaceholders(text)).includes(hit.needle)) range = undefined;
      draw();
    });
    const stop = () => {
      clearTimeout(timer);
      clearTimeout(expiry);
      resize.dispose();
      scroll.dispose();
      parsed.dispose();
      reset.dispose();
      mark.remove();
      cleanup = undefined;
    };
    const reset = adapter.onReset(stop);
    const expiry = setTimeout(stop, 8000);
    cleanup = stop;
    return undefined;
  };
}
