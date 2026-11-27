import type { GhosttyCell, GhosttyTerminal } from 'ghostty-web';
import { decodePlaceholderCell, KITTY_PLACEHOLDER_CHAR, type DecodedPlaceholder } from '../../shared/kitty';
import { VtScanner } from '../../shared/vt-scanner';
import type { KittyRowAnchor } from '../term-kitty-overlay';

const placeholder = KITTY_PLACEHOLDER_CHAR.codePointAt(0);
export const switchesScreen = (params: (number | number[])[]) => params.some((p) => p === 47 || p === 1047 || p === 1049);

/** Read the grapheme at its actual physical cell, including history. Unlike translateToString,
 * this preserves omitted diacritics, wide-cell spacers and overwritten cells after a reflow. */
export function placeholderRow(core: GhosttyTerminal, line: number, history: number, viewport: GhosttyCell[]) {
  const live = line >= history;
  const y = live ? line - history : line;
  const cells = live ? viewport : core.getScrollbackLine(y);
  const offset = live ? y * core.cols : 0;
  let map: Map<number, DecodedPlaceholder> | undefined;
  let prev: DecodedPlaceholder | undefined;
  for (let x = 0; cells && x < core.cols && offset + x < cells.length; x++) {
    const c = cells[offset + x];
    if (!c.width) continue;
    if (c.codepoint !== placeholder) {
      prev = undefined;
      continue;
    }
    const chars = live ? core.getGraphemeString(y, x) : core.getScrollbackGraphemeString(y, x);
    // The public cell provides resolved RGB, but not the underline color or palette index.
    prev = decodePlaceholderCell(chars, (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b, 0, prev);
    if (prev) (map ??= new Map()).set(x, prev);
  }
  return { mutated: false, map };
}

interface Position {
  x: number;
  y: number;
  history: number;
}

/** ASCII shell output without soft wraps has an exact line-advance count, even when every
 * row has identical text and the history limit trims a whole page in a single write. */
function lineAdvances(data: string, startX: number, cols: number) {
  let x = startX;
  let count = 0;
  for (const ch of data) {
    if (ch === '\n' || ch === '\v' || ch === '\f') count++;
    else if (ch === '\r') x = 0;
    else if (ch === '\b') x = Math.max(0, x - 1);
    else if (ch >= ' ' && ch <= '~' && x < cols - 1) x++;
    else return undefined;
  }
  return count;
}

export class GraphicsRows {
  private readonly anchors = new Set<{ line: number }>();
  private before?: Position;
  private readonly boundaries = new VtScanner();
  private spans: string[] = [];
  private span = 0;
  private region = false;
  private horizontalMargins = false;
  private savedPrimary?: Position;
  private safeWidth = Infinity;
  constructor(private readonly core: GhosttyTerminal) {
    // onBeforeWrite brackets the complete write, not each native text span. Use the same
    // framing rules to account for only the text between callbacks, including split APC/ST.
    this.boundaries.registerApcHandler(() => {
      this.spans.push('');
      return true;
    });
    for (const final of ['h', 'l'])
      this.boundaries.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (!switchesScreen(params)) return false;
        this.spans.push('');
        return true;
      });
  }

  anchor(): KittyRowAnchor | undefined {
    if (this.core.isAlternateScreen() || this.region || this.horizontalMargins) return;
    const anchor = { line: this.core.getScrollbackLength() + this.core.getCursor().y };
    this.anchors.add(anchor);
    return {
      get line() {
        return anchor.line;
      },
      get isDisposed() {
        return anchor.line < 0;
      },
      dispose: () => {
        anchor.line = -1;
        this.anchors.delete(anchor);
      },
    };
  }

  invalidate(screenOnly = false) {
    const start = screenOnly ? this.core.getScrollbackLength() : 0;
    for (const a of this.anchors)
      if (a.line >= start) {
        a.line = -1;
        this.anchors.delete(a);
      }
  }

  setRegion(active: boolean) {
    if (this.core.isAlternateScreen()) return;
    this.region = active;
    if (active) this.invalidate(true);
  }

  mode(params: (number | number[])[], set: boolean) {
    if (params.includes(69) && !this.core.isAlternateScreen()) {
      this.horizontalMargins = set;
      if (set) this.invalidate(true);
    }
    if (!switchesScreen(params)) return;
    this.advance(this.spans[this.span++] ?? '');
    if (set && !this.core.isAlternateScreen()) {
      this.checkpoint();
      this.savedPrimary = this.before;
      this.before = undefined;
    } else if (!set && this.core.isAlternateScreen()) {
      // 1049 restores the normal cursor. 47/1047 do not promise the same cursor identity.
      if (!params.includes(1049)) this.invalidate();
      this.before = this.savedPrimary;
      this.savedPrimary = undefined;
    }
  }

  begin(raw: string) {
    this.spans = [''];
    this.span = 0;
    this.boundaries.write(raw, (s) => {
      this.spans[this.spans.length - 1] += s;
    });
    this.checkpoint();
  }

  private checkpoint() {
    this.before = this.anchors.size && !this.core.isAlternateScreen() ? { ...this.core.getCursor(), history: this.core.getScrollbackLength() } : undefined;
  }

  /** A scanner callback runs after the preceding output but before the following text. Split
   * there so a placement midway through one PTY write sees only the output AFTER its anchor. */
  apc() {
    this.advance(this.spans[this.span++] ?? '');
    this.checkpoint();
  }

  move(data: string, write: (data: string) => void) {
    this.checkpoint();
    write(data);
    this.advance(data);
    this.checkpoint();
  }

  placed() {
    this.checkpoint();
  }

  end() {
    this.advance(this.spans[this.span] ?? '');
    this.spans = [];
    this.before = undefined;
    this.rememberWidth();
  }

  reset() {
    this.invalidate();
    this.boundaries.reset();
    this.region = false;
    this.horizontalMargins = false;
    this.savedPrimary = undefined;
    this.safeWidth = Infinity;
  }

  /** With no history and no wrapped rows, a grid wide enough to contain every used cell
   * cannot reflow any preceding line. Otherwise we have no public old-to-new line mapping. */
  private rememberWidth() {
    this.safeWidth = Infinity;
    if (!this.anchors.size || this.core.isAlternateScreen() || this.core.getScrollbackLength()) return;
    this.core.update();
    const cells = this.core.getViewport();
    let width = 0;
    for (let y = 0; y < this.core.rows; y++) {
      if (this.core.isRowWrapped(y)) return;
      for (let x = this.core.cols - 1; x >= width; x--) {
        const cell = cells[y * this.core.cols + x];
        if (cell?.codepoint) {
          width = x + Math.max(1, cell.width);
          break;
        }
      }
    }
    this.safeWidth = width;
  }

  resized() {
    if (this.core.getScrollbackLength() || this.core.cols < this.safeWidth) this.invalidate();
    else
      for (const a of this.anchors)
        if (a.line >= this.core.rows) {
          a.line = -1;
          this.anchors.delete(a);
        }
    this.rememberWidth();
  }

  private advance(data: string) {
    const before = this.before;
    if (!before || !data || !this.anchors.size || this.core.isAlternateScreen()) return;
    const history = this.core.getScrollbackLength();
    const delta = history - before.history;
    const after = this.core.getCursor();
    // Styling, OSC titles and shell-integration metadata, private mode toggles, horizontal
    // absolute positioning and erase-in-line do not themselves add or remove physical rows.
    const plain = data.replace(/\x1b\][^\x07\x18\x1a\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|\x1b\[[\d:;]*m|\x1b\[\?(?:(?:1|7|9|12|25|100[0-7]|101[56]|2004);?)+[hl]|\x1b\[\d*K/g, '');
    const advances = lineAdvances(plain.replace(/\x1b\[\d*G$/, ''), before.x, this.core.cols);
    let trimmed: number;
    if (advances !== undefined && !this.region && !this.horizontalMargins) {
      trimmed = before.y + advances - after.y - delta;
    } else {
      // The core exposes neither a trim counter nor stable row handles. Only accept a
      // displacement we can prove. Fast path for soft-wrapped output: each printable
      // UTF-16 unit occupies at most two cells; controls below move the cursor but do not
      // scroll. If even the upper bound cannot cross the bottom, no trim was possible.
      const cursorMotion = /\x1b(?:[78]|\[[\d;]*[GKCDHfABsu])/g;
      const rest = plain.replace(cursorMotion, '');
      const positions = rest !== plain;
      const pieces = plain.split(cursorMotion).flatMap((s) => s.split(/[\r\n]/));
      const wraps = pieces.reduce((sum, piece) => sum + (piece ? Math.ceil((2 * piece.length) / Math.max(1, this.core.cols - 1)) : 0), 0);
      const max = (rest.match(/\n/g)?.length ?? 0) + wraps;
      const appended = positions ? max : Math.max(0, before.y + max - this.core.rows + 1);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\t]/.test(rest) || appended !== delta) {
        this.invalidate();
        return;
      }
      trimmed = 0;
    }
    if (trimmed < 0) {
      this.invalidate();
      return;
    }
    for (const a of this.anchors) {
      a.line -= trimmed;
      if (a.line < 0) this.anchors.delete(a);
    }
  }
}
