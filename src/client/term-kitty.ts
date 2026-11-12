import type { Terminal } from '@xterm/xterm';
import {
  cellUnderlineId,
  decodeBase64,
  decodePlaceholderCell,
  encodeKittyKey,
  isKittyPlaceholderCell,
  KITTY_PLACEHOLDER_CHAR,
  KittyApcSplitter,
  KittyGraphicsStore,
  kittyImageSignature,
  KittyKeyboardState,
  type DecodedPlaceholder,
  type KittyImageFormat,
  type KittyImageRecord,
  type KittyKeyEvent,
  type KittyPlaceRequest,
} from '../shared/kitty';
import type { KeyAction } from '../shared/csi-enter';
import type { ScreenImage } from '../shared/protocol';

const ALT_BUFFER_MODES = [47, 1047, 1049];
const MAX_DIRECT_PLACEMENTS = 128;
/** Width-1 plain ASCII `' '` content word in xterm's `BufferLine._data`, avoiding DOM-renderer negative letter-spacing on `U+10EEEE`. */
const XTERM_SPACE_CONTENT = 0x20 | (1 << 22);
/** Bit 30 (`FgFlags.INVISIBLE`) marks converted placeholder spaces so overwriting a cell invalidates its cached placeholder. */
const XTERM_FG_INVISIBLE = 0x40000000;

interface DecodedEntry {
  sig: string;
  root: ImageBitmap | null;
  frames: ImageBitmap[];
  frameIdx: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface DirectPlacement {
  imageId: number;
  placementId: number;
  marker: NonNullable<ReturnType<Terminal['registerMarker']>>;
  col: number;
  cols: number;
  rows: number;
  z: number;
}

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

async function inflateBytes(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      const writeDone = writer.write(compressed as unknown as BufferSource).then(() => writer.close());
      const buf = await new Response(ds.readable).arrayBuffer();
      await writeDone;
      return new Uint8Array(buf);
    } catch {
      // try raw deflate fallback
    }
  }
  throw new Error('Failed to inflate Kitty image payload');
}

/** Decodes a Kitty image payload (`f=24|32|100`, optional `o='z'`) into a GPU-backed `ImageBitmap`. */
export async function decodeKittyImageBitmap(format: KittyImageFormat, compression: 'z' | undefined, width: number, height: number, b64: string): Promise<ImageBitmap | null> {
  if (!b64 || typeof createImageBitmap === 'undefined') return null;
  try {
    let bytes = decodeBase64(b64);
    if (compression === 'z') bytes = await inflateBytes(bytes);
    if (format === 100) {
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
      return await createImageBitmap(blob);
    }
    if (width <= 0 || height <= 0) return null;
    const pixelCount = width * height;
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    if (format === 32) {
      rgba.set(bytes.subarray(0, Math.min(bytes.length, rgba.length)));
    } else {
      const limit = Math.min(pixelCount, Math.floor(bytes.length / 3));
      for (let i = 0, s = 0, d = 0; i < limit; i++, s += 3, d += 4) {
        rgba[d] = bytes[s];
        rgba[d + 1] = bytes[s + 1];
        rgba[d + 2] = bytes[s + 2];
        rgba[d + 3] = 255;
      }
    }
    return await createImageBitmap(new ImageData(rgba, width, height));
  } catch {
    return null;
  }
}

/** Convenience wrapper for decoding `ScreenImage` payloads on 3D laptop and monitor textures. */
export function decodeScreenBitmap(img: ScreenImage): Promise<ImageBitmap | null> {
  return decodeKittyImageBitmap(img.format, img.compression, img.width, img.height, img.data);
}

export interface KittyTerminalAttachment {
  readonly keyboard: KittyKeyboardState;
  readonly graphics: KittyGraphicsStore;
  /** Encodes a DOM `KeyboardEvent` according to negotiated Kitty `CSI u` flags (or fallback `csiEnter`). */
  keyAction(e: KittyKeyEvent, csiEnter: boolean): KeyAction;
  dispose(): void;
}

interface CoalescedRect {
  imageId: number;
  placementId: number;
  x: number;
  y: number;
  cols: number;
  rows: number;
  srcCol: number;
  srcRow: number;
  z: number;
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
export function attachKittyTerminal(term: Terminal): KittyTerminalAttachment {
  const keyboard = new KittyKeyboardState();
  const graphics = new KittyGraphicsStore();
  const splitter = new KittyApcSplitter();
  const decoded = new Map<number, DecodedEntry>();
  const directPlacements: DirectPlacement[] = [];
  const linePlaceholders = new WeakMap<RawBufferLine, Map<number, DecodedPlaceholder>>();

  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let screenEl: HTMLElement | null = null;
  let rafId = 0;
  let disposed = false;
  let scannedLength = 0;

  const closeEntry = (entry: DecodedEntry) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.root?.close?.();
    for (const f of entry.frames) f?.close?.();
  };

  const clearDecoded = () => {
    for (const entry of decoded.values()) closeEntry(entry);
    decoded.clear();
  };

  const pruneDecoded = () => {
    for (const [id, entry] of decoded) {
      if (!graphics.get(id)) {
        closeEntry(entry);
        decoded.delete(id);
      }
    }
  };

  const clearPlacements = (match?: (p: DirectPlacement) => boolean) => {
    for (let i = directPlacements.length - 1; i >= 0; i--) {
      if (!match || match(directPlacements[i])) {
        directPlacements[i].marker.dispose();
        directPlacements.splice(i, 1);
      }
    }
  };

  const schedulePaint = () => {
    if (disposed || !canvas || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      paintOverlay();
    });
  };

  const syncAnimation = (img: KittyImageRecord, entry: DecodedEntry) => {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const totalFrames = 1 + entry.frames.length;
    if (disposed || totalFrames <= 1 || img.animState === 1) return;
    const step = () => {
      entry.timer = undefined;
      if (disposed || decoded.get(img.id) !== entry) return;
      const count = 1 + entry.frames.length;
      if (count <= 1 || img.animState === 1) return;
      entry.frameIdx = (entry.frameIdx + 1) % count;
      schedulePaint();
      const delay = entry.frameIdx === 0 ? (img.rootDelayMs ?? 100) : (img.frames[entry.frameIdx - 1]?.delayMs ?? 100);
      entry.timer = setTimeout(step, Math.max(16, delay));
    };
    const initialDelay = entry.frameIdx === 0 ? (img.rootDelayMs ?? 100) : (img.frames[entry.frameIdx - 1]?.delayMs ?? 100);
    entry.timer = setTimeout(step, Math.max(16, initialDelay));
  };

  const decodeRecord = (img: KittyImageRecord) => {
    pruneDecoded();
    const sig = kittyImageSignature(img);
    const existing = decoded.get(img.id);
    if (existing?.sig === sig) return;
    void (async () => {
      const root = await decodeKittyImageBitmap(img.format, img.compression, img.width, img.height, img.data);
      if (disposed || graphics.get(img.id) !== img) {
        root?.close?.();
        return;
      }
      const frames: ImageBitmap[] = [];
      for (const f of img.frames) {
        const bmp = await decodeKittyImageBitmap(f.format, f.compression, f.width, f.height, f.data);
        if (disposed || graphics.get(img.id) !== img) {
          root?.close?.();
          for (const prev of frames) prev.close?.();
          bmp?.close?.();
          return;
        }
        if (bmp) frames.push(bmp);
      }
      const prev = decoded.get(img.id);
      if (prev) closeEntry(prev);
      const entry: DecodedEntry = { sig, root, frames, frameIdx: 0 };
      decoded.set(img.id, entry);
      if (frames.length > 0 && img.animState !== 1) syncAnimation(img, entry);
      schedulePaint();
    })();
  };

  const cellGeometry = (): { cssW: number; cssH: number; cellW: number; cellH: number } | null => {
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

  const placeDirect = (img: KittyImageRecord, req: KittyPlaceRequest): string | undefined => {
    if (req.unicode) return undefined;
    const geom = cellGeometry();
    const cellW = geom?.cellW ?? 9;
    const cellH = geom?.cellH ?? 18;
    const cols = Math.max(1, req.cols ?? (img.width > 0 ? Math.ceil(img.width / cellW) : 10));
    const rows = Math.max(1, req.rows ?? (img.height > 0 ? Math.ceil(img.height / cellH) : 5));
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

  const collectViewportRects = (): { rects: CoalescedRect[]; mutated: boolean } => {
    const buf = term.buffer.active;
    const rects: CoalescedRect[] = [];
    const active = new Map<string, CoalescedRect>();
    let mutated = false;

    for (let y = 0; y < term.rows; y++) {
      const { mutated: lineMut, map } = extractLinePlaceholders(term, buf.viewportY + y, linePlaceholders);
      if (lineMut) mutated = true;
      const nextActive = new Map<string, CoalescedRect>();
      if (map) {
        let rowSpan: CoalescedRect | null = null;
        const rowSpans: CoalescedRect[] = [];
        for (let x = 0; x < term.cols; x++) {
          const ph = map.get(x);
          if (ph) {
            if (rowSpan && rowSpan.imageId === ph.imageId && rowSpan.placementId === ph.placementId && rowSpan.srcRow === ph.row && rowSpan.x + rowSpan.cols === x && rowSpan.srcCol + rowSpan.cols === ph.col) {
              rowSpan.cols++;
            } else {
              rowSpan = {
                imageId: ph.imageId,
                placementId: ph.placementId,
                x,
                y,
                cols: 1,
                rows: 1,
                srcCol: ph.col,
                srcRow: ph.row,
                z: 0,
              };
              rowSpans.push(rowSpan);
            }
          } else {
            rowSpan = null;
          }
        }
        for (const s of rowSpans) {
          const key = `${s.imageId}:${s.placementId}:${s.x}:${s.cols}:${s.srcCol}`;
          const above = active.get(key);
          if (above && above.y + above.rows === y && above.srcRow + above.rows === s.srcRow) {
            above.rows++;
            nextActive.set(key, above);
          } else {
            rects.push(s);
            nextActive.set(key, s);
          }
        }
      }
      active.clear();
      for (const [k, v] of nextActive) active.set(k, v);
    }

    // Add visible direct (`U !== 1`) placements.
    if (directPlacements.length && buf.type === 'normal') {
      for (let i = directPlacements.length - 1; i >= 0; i--) {
        const p = directPlacements[i];
        if (p.marker.isDisposed || p.marker.line < 0) {
          p.marker.dispose();
          directPlacements.splice(i, 1);
          continue;
        }
        const yRel = p.marker.line - buf.viewportY;
        if (yRel + p.rows <= 0 || yRel >= term.rows) continue;
        const visY0 = Math.max(0, yRel);
        const visY1 = Math.min(term.rows, yRel + p.rows);
        rects.push({
          imageId: p.imageId,
          placementId: p.placementId,
          x: p.col,
          y: visY0,
          cols: p.cols,
          rows: visY1 - visY0,
          srcCol: 0,
          srcRow: visY0 - yRel,
          z: p.z,
        });
      }
    }

    return { rects, mutated };
  };

  const paintOverlay = () => {
    if (disposed || !canvas || !ctx || !screenEl) return;
    const geom = cellGeometry();
    if (!geom) return;
    const { rects, mutated } = collectViewportRects();
    if (mutated) term.refresh(0, term.rows - 1);
    pruneDecoded();
    const visibleRects = graphics.size > 0 ? rects : [];
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const devW = Math.max(1, Math.round(geom.cssW * dpr));
    const devH = Math.max(1, Math.round(geom.cssH * dpr));
    if (canvas.width !== devW || canvas.height !== devH) {
      canvas.width = devW;
      canvas.height = devH;
      canvas.style.width = `${geom.cssW}px`;
      canvas.style.height = `${geom.cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, geom.cssW, geom.cssH);
    if (!visibleRects.length) return;

    // Max observed dimensions for virtual placements that omitted `c`/`r` on `a=T`.
    const observed = new Map<number, { cols: number; rows: number }>();
    for (const r of visibleRects) {
      const mc = r.srcCol + r.cols;
      const mr = r.srcRow + r.rows;
      const prev = observed.get(r.imageId);
      if (!prev) observed.set(r.imageId, { cols: mc, rows: mr });
      else {
        if (mc > prev.cols) prev.cols = mc;
        if (mr > prev.rows) prev.rows = mr;
      }
    }

    for (const r of visibleRects) {
      const rec = graphics.get(r.imageId);
      if (!rec) continue;
      const entry = decoded.get(r.imageId);
      if (!entry) {
        decodeRecord(rec);
        continue;
      }
      const bmp = entry.frameIdx === 0 || !entry.frames.length ? entry.root : (entry.frames[entry.frameIdx - 1] ?? entry.root);
      if (!bmp) continue;

      const obs = observed.get(r.imageId);
      const totalCols = Math.max(obs?.cols ?? r.cols, rec.cols ?? Math.ceil(bmp.width / geom.cellW));
      const totalRows = Math.max(obs?.rows ?? r.rows, rec.rows ?? Math.ceil(bmp.height / geom.cellH));

      const sx = (r.srcCol / totalCols) * bmp.width;
      const sy = (r.srcRow / totalRows) * bmp.height;
      const sw = (r.cols / totalCols) * bmp.width;
      const sh = (r.rows / totalRows) * bmp.height;
      const dx = r.x * geom.cellW;
      const dy = r.y * geom.cellH;
      const dw = r.cols * geom.cellW;
      const dh = r.rows * geom.cellH;
      if (sw > 0 && sh > 0 && dw > 0 && dh > 0) {
        ctx.drawImage(bmp, sx, sy, sw, sh, dx, dy, dw, dh);
      }
    }
  };

  // Wrap `term.write` to intercept APC G sequences in strict FIFO stream order.
  const origWrite = term.write.bind(term);
  type WriteJob = { kind: 'raw'; data: Uint8Array; cb?: () => void } | { kind: 'segs'; segs: ReturnType<typeof splitter.feed>; idx: number; cb?: () => void };
  const writeQueue: WriteJob[] = [];
  let writing = false;

  const handleApcBody = (body: string): string | undefined => {
    const { effect } = graphics.processApc(body);
    let cursorMove: string | undefined;
    if (effect.type === 'image') {
      decodeRecord(effect.image);
      if (effect.display) cursorMove = placeDirect(effect.image, effect.display);
      schedulePaint();
    } else if (effect.type === 'place') {
      decodeRecord(effect.image);
      cursorMove = placeDirect(effect.image, effect.display);
      schedulePaint();
    } else if (effect.type === 'animate') {
      decodeRecord(effect.image);
      schedulePaint();
    } else if (effect.type === 'delete') {
      if (effect.selector.toLowerCase() === 'a') {
        clearPlacements();
        if (effect.free) clearDecoded();
      } else if (effect.imageId !== undefined) {
        clearPlacements((p) => p.imageId === effect.imageId && (!effect.placementId || p.placementId === effect.placementId));
      }
      pruneDecoded();
      schedulePaint();
    }
    return cursorMove;
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

  // Wrap `term.open` to mount the overlay `<canvas>` inside `.xterm-screen`.
  const origOpen = term.open.bind(term);
  term.open = (parent: HTMLElement) => {
    origOpen(parent);
    screenEl = term.element?.querySelector<HTMLElement>('.xterm-screen') ?? parent;
    canvas?.remove();
    const c = document.createElement('canvas');
    c.className = 'term-kitty-layer';
    c.setAttribute('aria-hidden', 'true');
    screenEl.appendChild(c);
    canvas = c;
    ctx = c.getContext('2d');
    schedulePaint();
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
      schedulePaint();
      return false;
    }),
    term.onWriteParsed(() => {
      const buf = term.buffer.active;
      const from = Math.max(0, Math.min(scannedLength - term.rows, buf.baseY));
      if (hideBufferPlaceholders(term, from, buf.length - 1, linePlaceholders)) {
        term.refresh(0, term.rows - 1);
      }
      scannedLength = buf.length;
      schedulePaint();
    }),
    term.onRender(() => schedulePaint()),
    term.onScroll(() => schedulePaint()),
    term.onResize(() => schedulePaint()),
  ];

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    for (const d of parserDisposables) d.dispose();
    clearPlacements();
    clearDecoded();
    canvas?.remove();
    canvas = null;
    ctx = null;
    screenEl = null;
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
      });
    },
    dispose,
  };
}
