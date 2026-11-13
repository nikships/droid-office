import type headless from '@xterm/headless';
import type serialize from '@xterm/addon-serialize';
import { cellUnderlineId, decodePlaceholderCell, isKittyPlaceholderCell, KITTY_CELL_PX_H, KITTY_CELL_PX_W, KITTY_PLACEHOLDER_CHAR, KittyApcSplitter, KittyGraphicsStore, KittyKeyboardState, type KittyPlaceRequest } from '../shared/kitty.js';
import { SCROLLBACK } from './ptys.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type Marker = NonNullable<ReturnType<HeadlessTerminal['registerMarker']>>;

/** The DECSET modes xterm.js reads as a mouse report encoding: SGR and SGR pixels. */
const MOUSE_ENCODINGS = [1006, 1016];
/** DECSET modes that switch between normal and alternate screen buffers. */
const ALT_BUFFER_MODES = [47, 1047, 1049];

/** Cell pixel size reported for CSI 14t / 16t queries (see `KITTY_CELL_PX_W`). */
export const SERVER_CELL_PX_W = KITTY_CELL_PX_W;
export const SERVER_CELL_PX_H = KITTY_CELL_PX_H;

export interface DirectKittyPlacement {
  imageId: number;
  placementId: number;
  marker: Marker;
  col: number;
  cols: number;
  rows: number;
  z: number;
}

export interface ServerTerminalKitty {
  readonly keyboard: KittyKeyboardState;
  readonly graphics: KittyGraphicsStore;
  readonly directPlacements: DirectKittyPlacement[];
  /** Incremented whenever stored images or animation frames mutate, for ScreenFrame cache invalidation. */
  imageGeneration: number;
  setReply(fn: ((data: string) => void) | undefined): void;
}

const terminalKitty = new WeakMap<HeadlessTerminal, ServerTerminalKitty>();

export function getTerminalKitty(term: HeadlessTerminal): ServerTerminalKitty | undefined {
  return terminalKitty.get(term);
}

/** Wires the authoritative PTY reply sink once any restored scrollback prelude has finished parsing. */
export function setTerminalResponder(term: HeadlessTerminal, reply: ((data: string) => void) | undefined): void {
  const state = terminalKitty.get(term);
  if (!state) return;
  term.write('', () => state.setReply(reply));
}

const MAX_DIRECT_PLACEMENTS = 128;

function collectReferencedImageIds(term: HeadlessTerminal, direct: readonly DirectKittyPlacement[]): Set<number> {
  const ids = new Set<number>();
  for (const p of direct) {
    if (!p.marker.isDisposed && p.marker.line >= 0) ids.add(p.imageId);
  }
  const buffers = [term.buffer.normal, term.buffer.alternate];
  for (const buf of buffers) {
    const cell = buf.getNullCell();
    const start = Math.max(0, buf.length - SCROLLBACK - term.rows);
    for (let y = start; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line?.translateToString(true).includes(KITTY_PLACEHOLDER_CHAR)) continue;
      let prev: ReturnType<typeof decodePlaceholderCell>;
      for (let x = 0; x < term.cols; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars();
        if (isKittyPlaceholderCell(chars)) {
          const fg = cell.isFgDefault() ? 0 : cell.getFgColor();
          prev = decodePlaceholderCell(chars, fg, cellUnderlineId(cell), prev);
          if (prev) ids.add(prev.imageId);
        } else {
          prev = undefined;
        }
      }
    }
  }
  return ids;
}

/**
 * A snapshot of `term` that a fresh terminal replays into the same screen: mouse encoding,
 * Kitty keyboard stacks (`CSI u`), and Kitty inline graphics (`APC G` + `U=1` / direct placements).
 *
 * Also intercepts `APC G` sequences in exact write order and, when `setTerminalResponder` is active,
 * answers terminal capability queries (`CSI ? u`, `APC G a=q`, `OSC 10/11`, `CSI 14/16/18 t`,
 * `XTVERSION`, and xterm's own `DA1`/`CPR`/`DECRQM`).
 */
export function screenSnapshot(term: HeadlessTerminal, ser: InstanceType<typeof serialize.SerializeAddon>): () => string {
  let encoding: number | undefined;
  let reply: ((data: string) => void) | undefined;
  const keyboard = new KittyKeyboardState();
  const graphics = new KittyGraphicsStore();
  const splitter = new KittyApcSplitter();
  const directPlacements: DirectKittyPlacement[] = [];
  const uploadedAt = new Map<number, number>();

  const state: ServerTerminalKitty = {
    keyboard,
    graphics,
    directPlacements,
    imageGeneration: 0,
    setReply(fn) {
      reply = fn;
    },
  };
  terminalKitty.set(term, state);

  // Unlock CSI 14/16/18 t so xterm's InputHandler delegates pixel/cell size queries to our CSI 't' handler.
  term.options.windowOptions = {
    ...term.options.windowOptions,
    getWinSizePixels: true,
    getCellSizePixels: true,
    getWinSizeChars: true,
  };

  // Forward xterm's native query responses (DA1 `\x1b[?1;2c`, CPR `\x1b[row;colR`, DECRQM, etc.)
  // only when this terminal instance owns the live PTY.
  term.onData((data) => reply?.(data));

  const prunePlacements = () => {
    for (let i = directPlacements.length - 1; i >= 0; i--) {
      const m = directPlacements[i].marker;
      if (m.isDisposed || m.line < 0) {
        m.dispose();
        directPlacements.splice(i, 1);
      }
    }
  };

  const clearPlacements = (match?: (p: DirectKittyPlacement) => boolean) => {
    for (let i = directPlacements.length - 1; i >= 0; i--) {
      if (!match || match(directPlacements[i])) {
        directPlacements[i].marker.dispose();
        directPlacements.splice(i, 1);
      }
    }
  };

  const placeDirect = (imageWidth: number, imageHeight: number, req: KittyPlaceRequest): string | undefined => {
    if (req.unicode) return undefined;
    prunePlacements();
    const cols = Math.max(1, req.cols ?? (imageWidth > 0 ? Math.ceil(imageWidth / SERVER_CELL_PX_W) : 10));
    const rows = Math.max(1, req.rows ?? (imageHeight > 0 ? Math.ceil(imageHeight / SERVER_CELL_PX_H) : 5));
    // Per Kitty spec, explicit non-zero `p=` replaces an existing placement with the same `(i, p)`.
    if (req.placementId > 0) {
      clearPlacements((p) => p.imageId === req.imageId && p.placementId === req.placementId);
    }
    const startCol = term.buffer.active.cursorX;
    const marker = term.registerMarker(0);
    if (!marker) return undefined;
    directPlacements.push({
      imageId: req.imageId,
      placementId: req.placementId,
      marker,
      col: startCol,
      cols,
      rows,
      z: req.z,
    });
    while (directPlacements.length > MAX_DIRECT_PLACEMENTS) {
      directPlacements.shift()?.marker.dispose();
    }
    if (!req.noCursorMove) {
      const down = rows > 1 ? '\n'.repeat(rows - 1) : '';
      const targetCol = Math.min(term.cols, startCol + cols + 1);
      return `${down}\x1b[${targetCol}G`;
    }
    return undefined;
  };

  // Intercept APC G sequences in strict FIFO stream order alongside xterm's parser.
  const origWrite = term.write.bind(term);
  type WriteJob = { kind: 'raw'; data: Uint8Array; cb?: () => void } | { kind: 'segs'; segs: ReturnType<typeof splitter.feed>; idx: number; cb?: () => void };
  const writeQueue: WriteJob[] = [];
  let writing = false;

  const handleApcBody = (body: string): string | undefined => {
    const res = graphics.processApc(body);
    if (res.reply) reply?.(res.reply);
    const eff = res.effect;
    if (eff.type === 'image') {
      uploadedAt.set(eff.image.id, Date.now());
      state.imageGeneration++;
      if (eff.display) return placeDirect(eff.image.width, eff.image.height, eff.display);
    } else if (eff.type === 'place') {
      uploadedAt.set(eff.image.id, Date.now());
      state.imageGeneration++;
      return placeDirect(eff.image.width, eff.image.height, eff.display);
    } else if (eff.type === 'animate') {
      state.imageGeneration++;
    } else if (eff.type === 'delete') {
      state.imageGeneration++;
      if (eff.selector.toLowerCase() === 'a') clearPlacements();
      else if (eff.imageId !== undefined) {
        clearPlacements((p) => p.imageId === eff.imageId && (!eff.placementId || p.placementId === eff.placementId));
      }
    }
    return undefined;
  };

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

  const decset = (on: boolean) => (params: (number | number[])[]) => {
    for (const p of params) {
      if (typeof p !== 'number') continue;
      if (MOUSE_ENCODINGS.includes(p)) encoding = on ? p : undefined;
      if (ALT_BUFFER_MODES.includes(p)) keyboard.setAlternate(on);
    }
    return false; // xterm.js still switches the mode itself
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, decset(true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, decset(false));

  // Kitty keyboard progressive enhancement sequences (`CSI ?|=|>|< u`).
  term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
    reply?.(keyboard.queryReply());
    return true;
  });
  term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
    const flags = typeof params[0] === 'number' ? params[0] : 0;
    const mode = typeof params[1] === 'number' ? params[1] : 1;
    keyboard.set(flags, mode);
    return true;
  });
  term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
    const flags = typeof params[0] === 'number' ? params[0] : 0;
    keyboard.push(flags);
    return true;
  });
  term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
    const count = typeof params[0] === 'number' ? params[0] : 1;
    keyboard.pop(count);
    return true;
  });

  // Window / cell pixel geometry queries (`CSI 14 t`, `CSI 16 t`, `CSI 18 t`) used by Droid and Kitty image CLIs.
  term.parser.registerCsiHandler({ final: 't' }, (params) => {
    const op = params[0];
    if (op === 16) {
      reply?.(`\x1b[6;${SERVER_CELL_PX_H};${SERVER_CELL_PX_W}t`);
      return true;
    }
    if (op === 14) {
      reply?.(`\x1b[4;${term.rows * SERVER_CELL_PX_H};${term.cols * SERVER_CELL_PX_W}t`);
      return true;
    }
    if (op === 18) {
      reply?.(`\x1b[8;${term.rows};${term.cols}t`);
      return true;
    }
    return false;
  });

  // XTVERSION (`CSI > 0 q`).
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
    if (!params.length || params[0] === 0) {
      reply?.('\x1bP>|droid-office(1.0)\x1b\\');
      return true;
    }
    return false;
  });

  // Foreground / background color queries (`OSC 10 ; ?` and `OSC 11 ; ?`), matching TERM_THEME (#e6edf3 on #000000).
  term.parser.registerOscHandler(10, (data) => {
    if (data.trim() !== '?') return false;
    reply?.('\x1b]10;rgb:e6e6/eded/f3f3\x1b\\');
    return true;
  });
  term.parser.registerOscHandler(11, (data) => {
    if (data.trim() !== '?') return false;
    reply?.('\x1b]11;rgb:0000/0000/0000\x1b\\');
    return true;
  });

  term.parser.registerEscHandler({ final: 'c' }, () => {
    encoding = undefined;
    keyboard.reset();
    graphics.reset();
    splitter.reset();
    clearPlacements();
    uploadedAt.clear();
    state.imageGeneration++;
    return false;
  });

  return () => {
    prunePlacements();
    let imgPrefix = '';
    if (graphics.size > 0) {
      const keep = collectReferencedImageIds(term, directPlacements);
      const now = Date.now();
      for (const [id, at] of uploadedAt) {
        if (now - at < 15_000) keep.add(id);
      }
      imgPrefix = graphics.serialize(keep);
    }
    const body = ser.serialize({ scrollback: SCROLLBACK });
    let directSuffix = '';
    if (directPlacements.length > 0 && term.buffer.active.type === 'normal') {
      const baseY = term.buffer.normal.baseY;
      let cmds = '';
      for (const p of directPlacements) {
        const viewRow = p.marker.line - baseY;
        if (viewRow >= 0 && viewRow < term.rows && graphics.get(p.imageId)) {
          cmds += `\x1b[${viewRow + 1};${p.col + 1}H\x1b_Ga=p,i=${p.imageId}${p.placementId ? `,p=${p.placementId}` : ''},c=${p.cols},r=${p.rows},z=${p.z},C=1,q=2\x1b\\`;
        }
      }
      if (cmds) directSuffix = `\x1b7${cmds}\x1b8`;
    }
    const mouseSuffix = encoding ? `\x1b[?${encoding}h` : '';
    const kbSuffix = keyboard.serialize();
    return imgPrefix + body + directSuffix + mouseSuffix + kbSuffix;
  };
}
