import type { GhosttyCell, GhosttyTerminal } from 'ghostty-web';
import { decodePlaceholderCell, KITTY_PLACEHOLDER_CHAR, type DecodedPlaceholder } from '../../shared/kitty';
import { VtScanner } from '../../shared/vt-scanner';
import type { KittyRowAnchor } from '../term-kitty-overlay';

const placeholder = KITTY_PLACEHOLDER_CHAR.codePointAt(0);
const passiveModes = new Set(['1', '7', '9', '12', '25', '1000', '1001', '1002', '1003', '1004', '1005', '1006', '1007', '1015', '1016', '2004', '2027']);
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
  autowrap: boolean;
}

/** ASCII shell output has an exact line-advance count, even when every
 * row has identical text and the history limit trims a whole page in a single write. */
function lineAdvances(data: string, startX: number, cols: number, autowrap: boolean, previous: boolean | undefined) {
  let x = startX;
  const eraseOrColumn = /\x1b\[(?:[012]?K|[01]?J|(\d{0,4})G)/y;
  // A cursor already on the margin may or may not have a wrap pending from an earlier write.
  let pending = x === cols - 1 ? previous : false;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\x1b') {
      eraseOrColumn.lastIndex = i;
      const move = eraseOrColumn.exec(data);
      if (move) {
        if (move[1] !== undefined) x = Math.min(cols, Number(move[1]) || 1) - 1;
        pending = false;
        i = eraseOrColumn.lastIndex - 1;
        continue;
      }
      if (data.startsWith('\x1b[?7h', i) || data.startsWith('\x1b[?7l', i)) {
        autowrap = data[i + 4] === 'h';
        i += 4;
        continue;
      }
    }
    if (ch >= ' ' && ch <= '~') {
      if (autowrap && pending === undefined) return undefined;
      if (autowrap && pending) {
        count++;
        x = 0;
      }
      pending = x === cols - 1;
      x = Math.min(cols - 1, x + 1);
      continue;
    }
    pending = false;
    if (ch === '\n' || ch === '\v' || ch === '\f') count++;
    else if (ch === '\r') x = 0;
    else if (ch === '\b') x = Math.max(0, x - 1);
    else return undefined;
  }
  return { count, pending, x };
}

export class GraphicsRows {
  private readonly anchors = new Set<{ line: number }>();
  private before?: Position;
  private pendingWrap?: boolean;
  private readonly boundaries = new VtScanner();
  private spans: string[] = [];
  private span = 0;
  private region = false;
  private horizontalMargins = false;
  private savedPrimary?: Position;
  private safeWidth = Infinity;
  private lastCols = 0;
  private lastTotalRows = 0;
  constructor(private readonly core: GhosttyTerminal) {
    // onBeforeWrite brackets the complete write, not each native text span. Use the same
    // framing rules to account for only the text between callbacks, including split APC/ST.
    this.boundaries.registerApcHandler(() => {
      this.spans.push('');
      return true;
    });
    this.boundaries.registerCsiHandler({ final: 'J' }, ([mode]) => {
      // ED0/1 only erase cells. ED2/3 change markers at this point in the stream.
      if (mode !== 2 && mode !== 3) return false; // ED0/1 cancel pending wrap in stream order.
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
    this.pendingWrap = undefined;
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
    this.before = this.anchors.size && !this.core.isAlternateScreen() ? { ...this.core.getCursor(), history: this.core.getScrollbackLength(), autowrap: this.core.getMode(7) } : undefined;
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

  erase(mode: 2 | 3, write: () => void) {
    this.advance(this.spans[this.span++] ?? '');
    if (!this.core.isAlternateScreen()) {
      if (mode === 2)
        this.invalidate(true); // xterm removes screen markers, not history.
      else this.trim(this.core.getScrollbackLength()); // ED3 drops history but keeps screen rows.
    }
    write();
    this.pendingWrap = undefined;
    this.checkpoint();
  }

  end() {
    this.advance(this.spans[this.span] ?? '');
    this.spans = [];
    this.before = undefined;
    this.rememberWidth();
  }

  reset(snapshot: boolean) {
    this.pendingWrap = undefined;
    this.invalidate();
    if (snapshot) this.boundaries.reset(); // Streamed RIS can be followed by a partial control in this write.
    this.region = false;
    this.horizontalMargins = false;
    this.savedPrimary = undefined;
    this.safeWidth = Infinity;
  }

  /** With no history and no wrapped rows, a grid wide enough to contain every used cell
   * cannot reflow any preceding line. Otherwise we have no public old-to-new line mapping. */
  private rememberWidth() {
    this.lastCols = this.core.cols;
    this.lastTotalRows = this.core.rows + this.core.getScrollbackLength();
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
    this.pendingWrap = undefined;
    const totalRows = this.core.rows + this.core.getScrollbackLength();
    if (this.core.cols === this.lastCols && totalRows === this.lastTotalRows) return;
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
    if (!data) return;
    const previous = this.pendingWrap;
    this.pendingWrap = undefined;
    if (!before || !this.anchors.size || this.core.isAlternateScreen()) return;
    const history = this.core.getScrollbackLength();
    const delta = history - before.history;
    const after = this.core.getCursor();
    // Strip only measured wrap-neutral controls. Keep erases, column moves and
    // DECAWM in stream order; sharing a cursor row is not enough to preserve the latch.
    const text = data.replace(/\x1b\](?:[01278]|133);[^\x00-\x1f\x7f-\x9f]*(?:\x07|\x1b\\)|\x1b\[[\d:;]*m|\x1b\[\?([\d;]+)([hl])/g, (seq, modes: string | undefined, toggle: string) => {
      if (!modes) return '';
      const list = modes.split(';');
      if (!list.every((m) => passiveModes.has(m))) return seq;
      return list.includes('7') ? `\x1b[?7${toggle}` : '';
    });
    const reverseBackspace = text.includes('\b') && (this.core.getMode(45) || this.core.getMode(1045));
    const advances = reverseBackspace ? undefined : lineAdvances(text, before.x, this.core.cols, before.autowrap, previous);
    let trimmed: number;
    if (advances !== undefined && advances.x === after.x && !this.region && !this.horizontalMargins) {
      this.pendingWrap = advances.pending;
      trimmed = before.y + advances.count - after.y - delta;
    } else {
      // The core exposes neither a trim counter nor stable row handles. Only accept a
      // displacement we can prove. Fast path for soft-wrapped output: each printable
      // UTF-16 unit occupies at most two cells; controls below move the cursor but do not
      // scroll. If even the upper bound cannot cross the bottom, no trim was possible.
      const cursorMotion = /\x1b(?:[78]|\[[\d;]*[GCDHfABsu])/g;
      // zsh can echo a Unicode command after backing up over its first character. A
      // leading BS inside the row cannot reverse-wrap; do not assume that at the margin.
      // For the bound, a tab and a horizontal CSI can both put the next glyph at the
      // last column. CUB under reverse-wrap is not horizontal: it can cross a row.
      const plain = text
        .replace(/\x1b\[(?:[012]?K|[01]?J)/g, '')
        .replace(/\x1b\[\?7[hl]/g, '')
        .replace(/^\x08+/, (bs) => (this.horizontalMargins ? bs : bs.slice(before.x)))
        .replace(/\x1b\[\d*([CDG`])/g, (seq, final: string) => (final === 'D' && (this.core.getMode(45) || this.core.getMode(1045)) ? seq : '\t'));
      const rest = plain.replace(cursorMotion, '');
      const positions = rest !== plain;
      const pieces = plain.split(cursorMotion).flatMap((s) => s.split(/[\r\n]/));
      const wraps = pieces.reduce((sum, piece) => sum + (piece ? Math.ceil((2 * piece.length) / Math.max(1, this.core.cols - 1)) : 0), 0);
      const breaks = rest.match(/\n/g)?.length ?? 0;
      const tabs = rest.match(/\t/g)?.length ?? 0;
      const max = breaks + wraps + tabs;
      const appended = positions ? max : Math.max(0, before.y + max - this.core.rows + 1);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(rest) || (tabs && (positions || this.region || this.horizontalMargins))) {
        this.invalidate();
        return;
      }
      trimmed = 0;
      if (appended !== delta) {
        // The pinned WASM flags the continuation row, including the current cursor row.
        // If all possible destination rows remain on-screen and none is flagged, only
        // the literal newlines advanced. A pre-existing flag is ambiguous, never count it.
        // Tab-heavy listings can have a bound larger than a screen. If any soft wrap
        // occurred, the last one has at most `breaks` literal newlines after it.
        const check = tabs ? Math.min(max, breaks + 1) : max;
        // ED1 can erase evidence of a wrap on an earlier row in this same span.
        if (text.includes('\x1b[1J') || positions || this.region || this.horizontalMargins || check > after.y + 1) return this.invalidate();
        for (let row = after.y - check + 1; row <= after.y; row++) if (this.core.isRowWrapped(row)) return this.invalidate();
        trimmed = before.y + breaks - after.y - delta;
      }
    }
    if (trimmed < 0) {
      this.invalidate();
      return;
    }
    this.trim(trimmed);
  }

  private trim(count: number) {
    for (const a of this.anchors) {
      a.line = Math.max(-1, a.line - count);
      if (a.line < 0) this.anchors.delete(a);
    }
  }
}
