import type { Terminal } from '@xterm/xterm';
import {
  cellUnderlineId,
  decodePlaceholderCell,
  encodeKittyKey,
  isKittyPlaceholderCell,
  KITTY_PLACEHOLDER_CHAR,
  KittyApcSplitter,
  type KittyGraphicsStore,
  KittyKeyboardState,
  type DecodedPlaceholder,
  type KittyKeyEvent,
} from '../../src/shared/kitty';
import type { KeyAction } from '../../src/shared/csi-enter';
import { pixelScrollOf } from '../../src/client/term-pixel-scroll';
import { createKittyOverlay, type KittyTerminalOptions } from '../../src/client/term-kitty-overlay';
export {
  decodeScreenBitmap,
  hitTestKittyRect,
  isKittyModClick,
  isKittyPlainPress,
  isNormalKittyShell,
  kittyPlacementBounds,
  shouldExpandKittyClick,
  type DrawnKittyRect,
  type KittyClickInput,
  type KittyShellState,
  type ExpandedKittyImage,
  type KittyTerminalOptions,
} from '../../src/client/term-kitty-overlay';
const ALT_BUFFER_MODES = [47, 1047, 1049];
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** Width-1 plain ASCII `' '` content word in xterm's `BufferLine._data`, avoiding DOM-renderer negative letter-spacing on `U+10EEEE`. */
const XTERM_SPACE_CONTENT = 0x20 | (1 << 22);
/** Bit 30 (`FgFlags.INVISIBLE`) marks converted placeholder spaces so overwriting a cell invalidates its cached placeholder. */
const XTERM_FG_INVISIBLE = 0x40000000;

interface RawBufferLine {
  _data?: Uint32Array;
  _combined?: Record<number, string>;
}

interface RawLine {
  _line?: RawBufferLine;
  _data?: Uint32Array;
  _combined?: Record<number, string>;
}

interface XtermInternal {
  _core?: {
    buffers?: {
      active?: {
        lines?: {
          length: number;
          get(index: number): { _data?: Uint32Array } | undefined;
        };
      };
    };
    buffer?: {
      lines?: {
        length: number;
        get(index: number): { _data?: Uint32Array } | undefined;
      };
    };
    _renderService?: {
      dimensions?: {
        css?: {
          canvas?: { width: number; height: number };
          cell?: { width: number; height: number };
        };
      };
    };
  };
}

export interface KittyTerminalAttachment {
  readonly keyboard: KittyKeyboardState;
  readonly graphics: KittyGraphicsStore;
  /** Encodes a DOM `KeyboardEvent` according to negotiated Kitty `CSI u` flags (or fallback `csiEnter`). */
  keyAction(e: KittyKeyEvent, csiEnter: boolean): KeyAction;
  dispose(): void;
}

function extractLinePlaceholders(term: Terminal, y: number, cache: WeakMap<RawBufferLine, Map<number, DecodedPlaceholder>>): { mutated: boolean; map: Map<number, DecodedPlaceholder> | undefined } {
  const buf = term.buffer.active;
  const line = buf.getLine(y);
  if (!line) return { mutated: false, map: undefined };
  const internal = (term as unknown as XtermInternal)._core;
  const fallbackLines = internal?.buffers?.active?.lines ?? internal?.buffer?.lines;
  const rawLine: RawBufferLine | undefined = (line as unknown as RawLine)._line ?? fallbackLines?.get(y);
  const raw = rawLine?._data;
  if (!rawLine || !raw) return { mutated: false, map: undefined };

  let map = cache.get(rawLine);
  const hasNew = line.translateToString(true).includes(KITTY_PLACEHOLDER_CHAR);
  if (!hasNew && !map?.size) return { mutated: false, map: undefined };

  let mutated = false;
  if (hasNew) {
    const cell = buf.getNullCell();
    let prevPh: DecodedPlaceholder | undefined;
    for (let x = 0; x < term.cols; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars();
      if (isKittyPlaceholderCell(chars)) {
        const fgLow24 = cell.isFgDefault() ? 0 : cell.getFgColor();
        const ph = decodePlaceholderCell(chars, fgLow24, cellUnderlineId(cell), prevPh);
        prevPh = ph;
        if (ph) {
          if (!map) {
            map = new Map();
            cache.set(rawLine, map);
          }
          map.set(x, ph);
        }
        const base = x * 3;
        if (base + 1 < raw.length) {
          raw[base] = XTERM_SPACE_CONTENT;
          raw[base + 1] |= XTERM_FG_INVISIBLE;
        }
        if (rawLine._combined) delete rawLine._combined[x];
        mutated = true;
      } else if (map?.has(x)) {
        const fgIdx = x * 3 + 1;
        if (fgIdx < raw.length && (raw[fgIdx] & XTERM_FG_INVISIBLE) !== 0) {
          prevPh = map.get(x);
        } else {
          map.delete(x);
          prevPh = undefined;
        }
      } else {
        prevPh = undefined;
      }
    }
  } else if (map) {
    for (const x of [...map.keys()]) {
      const fgIdx = x * 3 + 1;
      if (fgIdx >= raw.length || (raw[fgIdx] & XTERM_FG_INVISIBLE) === 0) {
        map.delete(x);
      }
    }
  }
  return { mutated, map: map?.size ? map : undefined };
}

function hideBufferPlaceholders(term: Terminal, fromY: number, toY: number, cache: WeakMap<RawBufferLine, Map<number, DecodedPlaceholder>>): boolean {
  const buf = term.buffer.active;
  const start = Math.max(0, fromY);
  const end = Math.min(buf.length - 1, toY);
  let mutated = false;
  for (let y = start; y <= end; y++) {
    if (extractLinePlaceholders(term, y, cache).mutated) mutated = true;
  }
  return mutated;
}

/**
 * Attaches Kitty keyboard (`CSI u`) and Kitty graphics (`APC G` + `U=1` Unicode placeholders +
 * direct placements + GIF animation) to a browser `@xterm/xterm` instance.
 */
export function attachKittyTerminal(term: Terminal, opts: KittyTerminalOptions = {}): KittyTerminalAttachment {
  const keyboard = new KittyKeyboardState();
  const splitter = new KittyApcSplitter();
  const linePlaceholders = new WeakMap<RawBufferLine, Map<number, DecodedPlaceholder>>();
  let scannedLength = 0;
  let sawPlaceholder = false;
  const cellGeometry = (screenEl: HTMLElement): { cssW: number; cssH: number; cellW: number; cellH: number } | null => {
    if (!screenEl || !term.cols || !term.rows) return null;
    const dims = (term as unknown as XtermInternal)._core?._renderService?.dimensions?.css;
    const cssW = dims?.canvas?.width || screenEl.clientWidth;
    const cssH = dims?.canvas?.height || screenEl.clientHeight;
    if (cssW <= 0 || cssH <= 0) return null;
    const cellW = dims?.cell?.width || cssW / term.cols;
    const cellH = dims?.cell?.height || cssH / term.rows;
    if (cellW <= 0 || cellH <= 0) return null;
    return { cssW, cssH, cellW, cellH };
  };

  const overlay = createKittyOverlay(
    {
      get cols() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
      cursorColumn: () => term.buffer.active.cursorX,
      anchorRow: () => term.registerMarker(0),
      viewportTop: () => term.buffer.active.viewportY,
      placeholders: (line) => extractLinePlaceholders(term, line, linePlaceholders),
      cellGeometry,
      extraRows: () => (pixelScrollOf(term)?.drawsExtraRows() ? 1 : 0),
      refresh: () => term.refresh(0, term.rows - 1),
      shellState: () => ({ mouseTrackingMode: term.modes.mouseTrackingMode, bufferType: term.buffer.active.type }),
      focus: () => term.focus(),
      hasSelection: () => term.hasSelection(),
      hasPlaceholder: () => sawPlaceholder,
    },
    opts,
  );
  const { graphics, handleApcBody, clearPlacements, clearDecoded, schedulePaint, paintNow } = overlay;
  // Wrap `term.write` to intercept APC G sequences in strict FIFO stream order.
  const origWrite = term.write.bind(term);
  type WriteJob = { kind: 'raw'; data: Uint8Array; cb?: () => void } | { kind: 'segs'; segs: ReturnType<typeof splitter.feed>; idx: number; cb?: () => void };
  const writeQueue: WriteJob[] = [];
  let writing = false;

  const pumpWrites = () => {
    if (writing) return;
    const job = writeQueue[0];
    if (!job) return;
    if (job.kind === 'raw') {
      writeQueue.shift();
      writing = true;
      origWrite(job.data, () => {
        writing = false;
        job.cb?.();
        pumpWrites();
      });
      return;
    }
    if (job.idx >= job.segs.length) {
      writeQueue.shift();
      if (job.cb) {
        writing = true;
        origWrite('', () => {
          writing = false;
          job.cb?.();
          pumpWrites();
        });
      } else {
        pumpWrites();
      }
      return;
    }
    const seg = job.segs[job.idx++];
    const isLast = job.idx >= job.segs.length;
    writing = true;
    if (seg.type === 'text') {
      origWrite(seg.data, () => {
        writing = false;
        if (isLast) {
          writeQueue.shift();
          job.cb?.();
        }
        pumpWrites();
      });
    } else {
      origWrite('', () => {
        const cursorMove = handleApcBody(seg.body);
        if (cursorMove) {
          origWrite(cursorMove, () => {
            writing = false;
            if (isLast) {
              writeQueue.shift();
              job.cb?.();
            }
            pumpWrites();
          });
        } else {
          writing = false;
          if (isLast) {
            writeQueue.shift();
            job.cb?.();
          }
          pumpWrites();
        }
      });
    }
  };

  term.write = ((data: string | Uint8Array, cb?: () => void) => {
    if (typeof data !== 'string') {
      writeQueue.push({ kind: 'raw', data, cb });
      pumpWrites();
      return;
    }
    const segs = splitter.feed(data);
    writeQueue.push({ kind: 'segs', segs, idx: 0, cb });
    pumpWrites();
  }) as typeof term.write;

  // Wrap `term.reset` so snapshots (`TerminalMirror.snapshot`, `changes.ts`) cleanly reset Kitty state.
  const origReset = term.reset.bind(term);
  term.reset = () => {
    keyboard.reset();
    graphics.reset();
    splitter.reset();
    clearPlacements();
    clearDecoded();
    scannedLength = 0;
    origReset();
    schedulePaint();
  };

  // Wrap `term.open` to mount the overlay `<canvas>` (and optional expand control) inside `.xterm-screen`.
  const origOpen = term.open.bind(term);
  term.open = (parent: HTMLElement) => {
    origOpen(parent);
    const screenEl = term.element?.querySelector<HTMLElement>('.xterm-screen') ?? parent;
    const clip = screenEl.parentElement;
    overlay.mount(screenEl, clip?.classList.contains('xterm-scrollable-element') ? clip : screenEl);
  };
  // Register parser hooks for Kitty keyboard mode & RIS reset.
  const parserDisposables = [
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      for (const p of params) if (typeof p === 'number' && ALT_BUFFER_MODES.includes(p)) keyboard.setAlternate(true);
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      for (const p of params) if (typeof p === 'number' && ALT_BUFFER_MODES.includes(p)) keyboard.setAlternate(false);
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
      keyboard.set(typeof params[0] === 'number' ? params[0] : 0, typeof params[1] === 'number' ? params[1] : 1);
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      keyboard.push(typeof params[0] === 'number' ? params[0] : 0);
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      keyboard.pop(typeof params[0] === 'number' ? params[0] : 1);
      return true;
    }),
    term.parser.registerEscHandler({ final: 'c' }, () => {
      keyboard.reset();
      graphics.reset();
      splitter.reset();
      clearPlacements();
      clearDecoded();
      scannedLength = 0;
      sawPlaceholder = false;
      schedulePaint();
      return false;
    }),
    term.onWriteParsed(() => {
      const buf = term.buffer.active;
      const from = Math.max(0, Math.min(scannedLength - term.rows, buf.baseY));
      if (hideBufferPlaceholders(term, from, buf.length - 1, linePlaceholders)) {
        sawPlaceholder = true;
        term.refresh(0, term.rows - 1);
      }
      scannedLength = buf.length;
      if (overlay.needsPaint()) schedulePaint();
    }),
    // Painted in the frame xterm drew its rows in, so images move with their rows when it scrolls.
    term.onRender(() => paintNow()),
    term.onResize(() => schedulePaint()),
  ];

  const dispose = () => {
    for (const d of parserDisposables) d.dispose();
    overlay.dispose();
  };

  const origDispose = term.dispose.bind(term);
  term.dispose = () => {
    dispose();
    origDispose();
  };

  return {
    keyboard,
    graphics,
    keyAction(e: KittyKeyEvent, csiEnter: boolean): KeyAction {
      return encodeKittyKey(e, keyboard.flags, {
        csiEnter,
        appCursor: term.modes.applicationCursorKeysMode,
        optionTypes: IS_MAC && term.options.macOptionIsMeta === false,
      });
    },
    dispose,
  };
}
