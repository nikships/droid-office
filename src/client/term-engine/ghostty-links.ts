import type { ILink, ITheme } from '@xterm/xterm';
import type { Terminal } from 'ghostty-web';
import { TERM_THEME } from '../term-theme';
import type { TerminalPathLinksAddon } from '../ui/terminal-path-links';
import type { GhosttyAdapter } from './ghostty';
import { installAppearance } from './ghostty-links-appearance';
import { missingLine, searchGhostty, viewportTop } from './ghostty-links-find';
import { type CellPosition, ghosttyLines } from './ghostty-links-lines';
import type { TerminalFind } from './types';

/** CanvasRenderer clears each row and skips the core's default black cell backgrounds,
 * so its RGBA row ground can show the companion pane through the canvas. */
export function ghosttyTheme(theme: ITheme | undefined): ITheme {
  return { ...TERM_THEME, ...theme, cursorAccent: theme?.cursorAccent ?? TERM_THEME.background, selectionForeground: theme?.selectionForeground ?? theme?.foreground ?? TERM_THEME.foreground };
}

const contains = ({ start, end }: ILink['range'], { x, y }: CellPosition) => (y > start.y || (y === start.y && x >= start.x)) && (y < end.y || (y === end.y && x <= end.x));

function installLinks(adapter: GhosttyAdapter, term: Terminal, signal: AbortSignal, paths?: TerminalPathLinksAddon) {
  const { wasmTerm: core, renderer, element } = term;
  if (!element || !renderer || !core) return;
  const canvas = renderer.getCanvas();
  const position = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const { height, width } = renderer.getMetrics();
    let x = Math.floor((event.clientX - rect.left) / width);
    const y = Math.floor((event.clientY - rect.top) / height);
    if (x < 0 || y < 0 || x >= term.cols || y >= term.rows) return;
    const absolute = y + viewportTop(term);
    const active = absolute - term.getScrollbackLength();
    const line = active < 0 ? core.getScrollbackLine(absolute) : core.getLine(active);
    if (x > 0 && line?.[x].width === 0 && line[x - 1].width === 2) x--;
    return { x: x + 1, y: absolute + 1 };
  };
  let generation = 0;
  function resolve(at: CellPosition, reply: (link?: ILink) => void) {
    if (!paths || !core) return reply();
    const history = core.getScrollbackLength();
    const linkUri = ({ x, y }: CellPosition) => (y <= history ? core.getScrollbackHyperlinkUri(y - 1, x - 1) : core.getHyperlinkUri(y - history - 1, x - 1));
    const uri = linkUri(at);
    if (uri) {
      // hyperlink_id is a boolean on this core. Adjacent OSC 8 links can have different URIs.
      const { wrapped } = ghosttyLines(core);
      const top = viewportTop(term);
      const start = { ...at };
      const end = { ...at };
      while (start.y > top) {
        const prev = start.x > 1 ? { x: start.x - 1, y: start.y } : { x: term.cols, y: start.y - 1 };
        if ((start.x === 1 && (!wrapped(start.y - 1) || prev.y <= top)) || linkUri(prev) !== uri) break;
        Object.assign(start, prev);
      }
      while (end.y <= top + term.rows) {
        const next = end.x < term.cols ? { x: end.x + 1, y: end.y } : { x: 1, y: end.y + 1 };
        if ((end.x === term.cols && (!wrapped(end.y) || next.y > top + term.rows)) || linkUri(next) !== uri) break;
        Object.assign(end, next);
      }
      const range = { start, end };
      return reply({ text: uri, range, activate: (e, text) => paths.linkHandler.activate(e, text, range) });
    }
    const read = () => ghosttyLines(core).logical(at.y);
    const line = read();
    // Match the web-links add-on's URL boundaries, including trailing prose punctuation.
    for (const match of line.text.matchAll(/https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/gi)) {
      if (!URL.canParse(match[0])) continue;
      const range = { start: line.cells[match.index], end: line.cells[match.index + match[0].length - 1] };
      if (contains(range, at))
        return reply({
          text: match[0],
          range,
          activate: (e, text) => {
            if (e.metaKey || e.ctrlKey) window.open(text, '_blank', 'noopener,noreferrer');
          },
        });
    }
    const epoch = generation;
    paths.providePathLinks(
      at.y,
      () => (!signal.aborted && generation === epoch ? read() : undefined),
      (links) => reply(links?.find((l) => contains(l.range, at))),
    );
  }
  let hovered: CellPosition | undefined;
  function clear() {
    if (!hovered) return;
    hovered = undefined;
    renderer?.setHoveredLinkRange(null);
    canvas.classList.remove('ghostty-link');
    canvas.removeAttribute('title');
  }
  canvas.addEventListener(
    'mousemove',
    (event) => {
      // Keep native selection, TUI mouse reporting and scrollbar drags. Suppress only the
      // root's built-in link hover, which trusts a different set of schemes/cell coordinates.
      if (event.buttons || core.hasMouseTracking()) return;
      event.stopPropagation();
      const at = position(event);
      if (!at || !paths) return clear();
      if (at.x === hovered?.x && at.y === hovered.y) return;
      clear();
      hovered = at;
      resolve(at, (link) => {
        if (signal.aborted || hovered !== at || !link) return;
        const top = viewportTop(term);
        const { start, end } = link.range;
        renderer.setHoveredLinkRange({ startX: start.x - 1, endX: end.x - 1, startY: start.y - top - 1, endY: end.y - top - 1 });
        canvas.classList.add('ghostty-link');
        canvas.title = `Cmd/Ctrl-click to open ${link.text}`;
      });
    },
    { signal },
  );
  element.addEventListener('mouseleave', clear, { signal });
  element.addEventListener(
    'click',
    (event) => {
      if (event.target !== canvas && event.target !== element) {
        // Let other feature controls receive the click, without bubbling to native activation.
        event.target?.addEventListener('click', (e) => e.stopPropagation(), { once: true });
        return;
      }
      event.stopImmediatePropagation();
      if (!paths || event.button || !(event.metaKey || event.ctrlKey)) return;
      const at = position(event);
      const epoch = generation;
      if (at)
        resolve(at, (link) => {
          if (!signal.aborted && epoch === generation) link?.activate(event, link.text);
        });
    },
    { capture: true, signal },
  );
  const invalidate = () => {
    generation++;
    clear();
  };
  const subscriptions = [term.onScroll(invalidate), term.onResize(invalidate), adapter.onWriteParsed(invalidate), adapter.onReset(invalidate)];
  signal.addEventListener(
    'abort',
    () => {
      for (const sub of subscriptions) sub.dispose();
      paths?.dispose();
    },
    { once: true },
  );
}

export function attachGhosttyLinks(adapter: GhosttyAdapter, paths?: TerminalPathLinksAddon) {
  let find: (hit: TerminalFind) => string | undefined = () => missingLine;
  adapter.onOpen((native, lifetime) => {
    installAppearance(adapter, native, lifetime);
    installLinks(adapter, native, lifetime, paths);
    find = searchGhostty(adapter, native, lifetime);
  });
  return { find: (hit: TerminalFind) => find(hit) };
}
