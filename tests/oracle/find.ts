import type { Terminal } from '@xterm/xterm';
import { findLine } from '../../src/shared/search';
import { TERM_THEME } from '../../src/client/term-theme';
import { scrollAtOnce } from '../../src/client/ui/terminal-prefs';
import type { TerminalFind } from '../../src/client/term-engine/types';

export function findInXterm(term: Terminal, f: TerminalFind): string | undefined {
  const buf = term.buffer.active;
  const row = findLine(buf, f.needle, f.fromEnd);
  if (row === undefined) return 'That line has scrolled out of the terminal since';
  let end = row;
  while (buf.getLine(end + 1)?.isWrapped) end++;
  // A marker follows the line when the terminal reflows, which it does as the window settles.
  const marker = term.registerMarker(row - (buf.baseY + buf.cursorY));
  if (!marker) return;
  const mark = term.registerDecoration({ marker, width: term.cols, height: end - row + 1, backgroundColor: TERM_THEME.yellow, foregroundColor: TERM_THEME.background });
  const scroll = () => {
    if (marker.line < 0) return;
    // xterm scrolls from where its scrollbar is, which lags behind a resize; from the top is exact.
    scrollAtOnce(term, () => {
      term.scrollLines(-term.buffer.active.length);
      term.scrollLines(Math.max(0, marker.line - Math.floor(term.rows / 3)));
    });
  };
  scroll();
  // The window settles its size just after it opens; stay on the line through that.
  const follow = term.onResize(() => setTimeout(scroll, 50));
  setTimeout(() => follow.dispose(), 1500);
  setTimeout(() => {
    mark?.dispose();
    marker.dispose();
  }, 8000);
}
