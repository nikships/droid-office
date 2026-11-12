// A worker's terminal on the phone: xterm.js fed the office's `term.snapshot` and `term.data` by the
// app (ui/worker/TerminalPage.kt), so its scrollback holds the history the office's PTY host kept.
// It never types: the app's composer and quick keys do. Messages to the app go through
// `OfficeBridge.post`, messages from it arrive at `office.receive`.

import { Unicode11Addon } from './vendor/addon-unicode11.mjs';
import { Terminal } from './vendor/xterm.mjs';
import { coast, fitGrid, fitScale, hitTestKittyTap, isKittyTap, nextEncoding, RowAccumulator, swipeGoesToProgram, swipeInput, TAP_SLOP_PX } from './input.js';
import { ALT_BUFFER_MODES, cellUnderlineId, decodeBase64, decodePlaceholderCell, isKittyPlaceholderCell, KITTY_PLACEHOLDER_CHAR, KittyApcSplitter, KittyGraphicsStore, kittyImageSignature, KittyKeyboardState } from './kitty.js';
import { THEME } from './theme.js';

/** Readable text, in CSS pixels before the phone's font scale (the native app's 12.5 sp). */
const READABLE_PX = 12.5;
/** The desktop view grows a narrow terminal on a tablet up to 24 sp, no further. */
const MAX_SCALE = 24 / READABLE_PX;
const PAD = 8;
const FONT = "'Geist Mono', 'Droid Office Terminal Symbols', monospace";
const MAX_DIRECT_PLACEMENTS = 128;
const XTERM_SPACE_CONTENT = 0x20 | (1 << 22);
const XTERM_FG_INVISIBLE = 0x40000000;
const linePlaceholders = new WeakMap();

const post = (msg) => window.OfficeBridge?.post(JSON.stringify(msg));
const host = document.getElementById('term');

// xterm measures its cells when it opens: with a font still loading, it measures the fallback.
await Promise.allSettled([document.fonts.load(`400 ${READABLE_PX}px 'Geist Mono'`), document.fonts.load(`400 ${READABLE_PX}px 'Droid Office Terminal Symbols'`, '\ue0b0')]);

const term = new Terminal({
  fontFamily: FONT,
  fontSize: READABLE_PX,
  lineHeight: 1.1,
  theme: THEME,
  // Droid can draw in its light theme's near-black (its queue hint's key names, a reply), which
  // vanishes on this black: lift any text that can't be read against its own background.
  minimumContrastRatio: 4.5,
  scrollback: 5000,
  allowProposedApi: true,
  disableStdin: true,
  cursorBlink: false,
  cursorInactiveStyle: 'block',
});
const unicode = new Unicode11Addon();
term.loadAddon(unicode);
term.unicode.activeVersion = '11';

const kittyKb = new KittyKeyboardState();
const kittyGraphics = new KittyGraphicsStore();
const kittySplitter = new KittyApcSplitter();
const kittyDecoded = new Map();
const directPlacements = [];
let lastKittyFlags = -1;
let scannedLength = 0;

function reportKittyFlags() {
  const f = kittyKb.flags;
  if (f === lastKittyFlags) return;
  lastKittyFlags = f;
  post({ t: 'kitty', flags: f });
}

// The serialize addon leaves the mouse encoding out, so the office appends it to each snapshot
// (src/server/screen.ts); follow it here to answer a swipe in the encoding the program reads.
let encoding = 0;
term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
  encoding = nextEncoding(encoding, params, true);
  for (const p of params) if (typeof p === 'number' && ALT_BUFFER_MODES.includes(p)) kittyKb.setAlternate(true);
  reportKittyFlags();
  return false;
});
term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
  encoding = nextEncoding(encoding, params, false);
  for (const p of params) if (typeof p === 'number' && ALT_BUFFER_MODES.includes(p)) kittyKb.setAlternate(false);
  reportKittyFlags();
  return false;
});
term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
  kittyKb.set(typeof params[0] === 'number' ? params[0] : 0, typeof params[1] === 'number' ? params[1] : 1);
  reportKittyFlags();
  return true;
});
term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
  kittyKb.push(typeof params[0] === 'number' ? params[0] : 0);
  reportKittyFlags();
  return true;
});
term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
  kittyKb.pop(typeof params[0] === 'number' ? params[0] : 1);
  reportKittyFlags();
  return true;
});
term.parser.registerEscHandler({ final: 'c' }, () => {
  encoding = 0;
  resetKitty();
  return false;
});

term.open(host);
// Taps must not raise the keyboard: the terminal shows the program, the composer types.
term.textarea.readOnly = true;
term.textarea.tabIndex = -1;
term.textarea.setAttribute('inputmode', 'none');

const screenEl = host.querySelector('.xterm-screen') ?? host;
const kittyCanvas = document.createElement('canvas');
kittyCanvas.className = 'term-kitty-layer';
kittyCanvas.setAttribute('aria-hidden', 'true');
screenEl.appendChild(kittyCanvas);
const kittyCtx = kittyCanvas.getContext('2d');

const MAX_EXPORT_SIDE = 2048;
const PNG_DATA_PREFIX = 'data:image/png;base64,';

let view = 'desktop';
let scale = 1;
let lastFit = '';
let paintRaf = 0;
let drawnKittyRects = [];

function closeDecodedEntry(entry) {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.root?.close?.();
  for (const f of entry.frames) f?.close?.();
}

function clearDirectPlacements(match) {
  for (let i = directPlacements.length - 1; i >= 0; i--) {
    if (!match || match(directPlacements[i])) {
      directPlacements[i].marker.dispose();
      directPlacements.splice(i, 1);
    }
  }
}

function resetKitty() {
  kittyKb.reset();
  kittyGraphics.reset();
  kittySplitter.reset();
  clearDirectPlacements();
  for (const e of kittyDecoded.values()) closeDecodedEntry(e);
  kittyDecoded.clear();
  drawnKittyRects = [];
  scannedLength = 0;
  reportKittyFlags();
  scheduleKittyPaint();
}

async function inflateBytes(compressed) {
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      const done = writer.write(compressed).then(() => writer.close());
      const buf = await new Response(ds.readable).arrayBuffer();
      await done;
      return new Uint8Array(buf);
    } catch {
      // try fallback
    }
  }
  throw new Error('Inflate failed');
}

async function decodeBitmap(format, compression, width, height, b64) {
  if (!b64 || typeof createImageBitmap === 'undefined') return null;
  try {
    let bytes = decodeBase64(b64);
    if (compression === 'z') bytes = await inflateBytes(bytes);
    if (format === 100) return await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    if (width <= 0 || height <= 0) return null;
    const pixelCount = width * height;
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    if (format === 32) rgba.set(bytes.subarray(0, Math.min(bytes.length, rgba.length)));
    else {
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

function syncAnimation(img, entry) {
  if (entry.timer !== undefined) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  const total = 1 + entry.frames.length;
  if (total <= 1 || img.animState === 1) return;
  const stepAnim = () => {
    entry.timer = undefined;
    if (kittyDecoded.get(img.id) !== entry) return;
    const count = 1 + entry.frames.length;
    if (count <= 1 || img.animState === 1) return;
    entry.frameIdx = (entry.frameIdx + 1) % count;
    scheduleKittyPaint();
    const delay = entry.frameIdx === 0 ? (img.rootDelayMs ?? 100) : (img.frames[entry.frameIdx - 1]?.delayMs ?? 100);
    entry.timer = setTimeout(stepAnim, Math.max(16, delay));
  };
  const firstDelay = entry.frameIdx === 0 ? (img.rootDelayMs ?? 100) : (img.frames[entry.frameIdx - 1]?.delayMs ?? 100);
  entry.timer = setTimeout(stepAnim, Math.max(16, firstDelay));
}

function pruneDecoded() {
  for (const [id, entry] of kittyDecoded) {
    if (!kittyGraphics.get(id)) {
      closeDecodedEntry(entry);
      kittyDecoded.delete(id);
    }
  }
}

function decodeImageRecord(img) {
  pruneDecoded();
  const sig = kittyImageSignature(img);
  if (kittyDecoded.get(img.id)?.sig === sig) return;
  void (async () => {
    const root = await decodeBitmap(img.format, img.compression, img.width, img.height, img.data);
    if (kittyGraphics.get(img.id) !== img) {
      root?.close?.();
      return;
    }
    const frames = [];
    for (const f of img.frames) {
      const bmp = await decodeBitmap(f.format, f.compression, f.width, f.height, f.data);
      if (kittyGraphics.get(img.id) !== img) {
        root?.close?.();
        for (const prev of frames) prev.close?.();
        bmp?.close?.();
        return;
      }
      if (bmp) frames.push(bmp);
    }
    const prev = kittyDecoded.get(img.id);
    if (prev) closeDecodedEntry(prev);
    const entry = { sig, root, frames, frameIdx: 0 };
    kittyDecoded.set(img.id, entry);
    if (frames.length > 0 && img.animState !== 1) syncAnimation(img, entry);
    scheduleKittyPaint();
  })();
}

function extractLinePlaceholders(y) {
  const buf = term.buffer.active;
  const line = buf.getLine(y);
  if (!line) return { mutated: false, map: undefined };
  const fallbackLines = term._core?.buffers?.active?.lines ?? term._core?.buffer?.lines;
  const rawLine = line._line ?? fallbackLines?.get(y);
  const raw = rawLine?._data;
  if (!rawLine || !raw) return { mutated: false, map: undefined };

  let map = linePlaceholders.get(rawLine);
  const hasNew = line.translateToString(true).includes(KITTY_PLACEHOLDER_CHAR);
  if (!hasNew && !map?.size) return { mutated: false, map: undefined };

  let mutated = false;
  if (hasNew) {
    const cell = buf.getNullCell();
    let prevPh;
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
            linePlaceholders.set(rawLine, map);
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

function hidePlaceholders(fromY, toY) {
  const buf = term.buffer.active;
  const start = Math.max(0, fromY);
  const end = Math.min(buf.length - 1, toY);
  let mutated = false;
  for (let y = start; y <= end; y++) {
    if (extractLinePlaceholders(y).mutated) mutated = true;
  }
  return mutated;
}

/** The grid's size in CSS pixels before scaling, as xterm's renderer laid it out. */
function gridSize() {
  const dims = term._core?._renderService?.dimensions?.css;
  const w = dims?.canvas?.width || Number.parseFloat(screenEl?.style.width) || screenEl?.offsetWidth || 0;
  const h = dims?.canvas?.height || Number.parseFloat(screenEl?.style.height) || screenEl?.offsetHeight || 0;
  return { w, h, cellW: dims?.cell?.width || (term.cols ? w / term.cols : 0), cellH: dims?.cell?.height || (term.rows ? h / term.rows : 0) };
}

function placeDirect(img, req) {
  if (req.unicode) return undefined;
  const { cellW, cellH } = gridSize();
  const cw = cellW || 9;
  const ch = cellH || 18;
  const cols = Math.max(1, req.cols ?? (img.width > 0 ? Math.ceil(img.width / cw) : 10));
  const rows = Math.max(1, req.rows ?? (img.height > 0 ? Math.ceil(img.height / ch) : 5));
  if (req.placementId > 0) clearDirectPlacements((p) => p.imageId === req.imageId && p.placementId === req.placementId);
  const startCol = term.buffer.active.cursorX;
  const marker = term.registerMarker(0);
  if (!marker) return undefined;
  directPlacements.push({ imageId: req.imageId, placementId: req.placementId, marker, col: startCol, cols, rows, z: req.z });
  while (directPlacements.length > MAX_DIRECT_PLACEMENTS) {
    directPlacements.shift()?.marker.dispose();
  }
  if (!req.noCursorMove) {
    const down = rows > 1 ? '\n'.repeat(rows - 1) : '';
    const targetCol = Math.min(term.cols, startCol + cols + 1);
    return `${down}\x1b[${targetCol}G`;
  }
  return undefined;
}

function collectViewportRects() {
  const buf = term.buffer.active;
  const rects = [];
  const active = new Map();
  let mutated = false;
  for (let y = 0; y < term.rows; y++) {
    const { mutated: lineMut, map } = extractLinePlaceholders(buf.viewportY + y);
    if (lineMut) mutated = true;
    const nextActive = new Map();
    if (map) {
      let rowSpan = null;
      const rowSpans = [];
      for (let x = 0; x < term.cols; x++) {
        const ph = map.get(x);
        if (ph) {
          if (rowSpan && rowSpan.imageId === ph.imageId && rowSpan.placementId === ph.placementId && rowSpan.srcRow === ph.row && rowSpan.x + rowSpan.cols === x && rowSpan.srcCol + rowSpan.cols === ph.col) {
            rowSpan.cols++;
          } else {
            rowSpan = { imageId: ph.imageId, placementId: ph.placementId, x, y, cols: 1, rows: 1, srcCol: ph.col, srcRow: ph.row, z: 0 };
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
      rects.push({ imageId: p.imageId, placementId: p.placementId, x: p.col, y: visY0, cols: p.cols, rows: visY1 - visY0, srcCol: 0, srcRow: visY0 - yRel, z: p.z });
    }
  }
  return { rects, mutated };
}

function paintKittyOverlay() {
  if (!kittyCtx) return;
  const { w, h, cellW, cellH } = gridSize();
  if (w <= 0 || h <= 0 || cellW <= 0 || cellH <= 0) return;
  const { rects, mutated } = collectViewportRects();
  if (mutated) term.refresh(0, term.rows - 1);
  pruneDecoded();
  const visibleRects = kittyGraphics.size > 0 ? rects : [];
  const dpr = (window.devicePixelRatio || 1) * Math.max(1, scale);
  const devW = Math.max(1, Math.round(w * dpr));
  const devH = Math.max(1, Math.round(h * dpr));
  if (kittyCanvas.width !== devW || kittyCanvas.height !== devH) {
    kittyCanvas.width = devW;
    kittyCanvas.height = devH;
    kittyCanvas.style.width = `${w}px`;
    kittyCanvas.style.height = `${h}px`;
  }
  kittyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  kittyCtx.clearRect(0, 0, w, h);
  drawnKittyRects = [];
  if (!visibleRects.length) return;

  const observed = new Map();
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
  const ordered = visibleRects.some((r) => r.z !== 0) ? [...visibleRects].sort((a, b) => a.z - b.z) : visibleRects;
  for (const r of ordered) {
    const rec = kittyGraphics.get(r.imageId);
    if (!rec) continue;
    const entry = kittyDecoded.get(r.imageId);
    if (!entry) {
      decodeImageRecord(rec);
      continue;
    }
    const bmp = entry.frameIdx === 0 || !entry.frames.length ? entry.root : (entry.frames[entry.frameIdx - 1] ?? entry.root);
    if (!bmp || !entry.root) continue;
    const obs = observed.get(r.imageId);
    const totalCols = Math.max(obs?.cols ?? r.cols, rec.cols ?? Math.ceil(bmp.width / cellW));
    const totalRows = Math.max(obs?.rows ?? r.rows, rec.rows ?? Math.ceil(bmp.height / cellH));
    const sx = (r.srcCol / totalCols) * bmp.width;
    const sy = (r.srcRow / totalRows) * bmp.height;
    const sw = (r.cols / totalCols) * bmp.width;
    const sh = (r.rows / totalRows) * bmp.height;
    const dw = r.cols * cellW;
    const dh = r.rows * cellH;
    if (sw > 0 && sh > 0 && dw > 0 && dh > 0) {
      kittyCtx.drawImage(bmp, sx, sy, sw, sh, r.x * cellW, r.y * cellH, dw, dh);
      drawnKittyRects.push({ imageId: r.imageId, placementId: r.placementId, x: r.x, y: r.y, cols: r.cols, rows: r.rows, z: r.z });
    }
  }
}

function openTappedKittyImage(imageId) {
  const rec = kittyGraphics.get(imageId);
  const root = kittyDecoded.get(imageId)?.root;
  if (!rec || !root || root.width <= 0 || root.height <= 0) return;
  if (rec.format === 100 && !rec.compression && Math.max(root.width, root.height) <= MAX_EXPORT_SIDE && rec.data) {
    post({ t: 'image', width: root.width, height: root.height, data: rec.data });
    return;
  }
  const maxSide = Math.max(root.width, root.height);
  const k = maxSide > MAX_EXPORT_SIDE ? MAX_EXPORT_SIDE / maxSide : 1;
  const outW = Math.max(1, Math.round(root.width * k));
  const outH = Math.max(1, Math.round(root.height * k));
  const off = document.createElement('canvas');
  off.width = outW;
  off.height = outH;
  const g = off.getContext('2d');
  if (!g) return;
  g.drawImage(root, 0, 0, outW, outH);
  const url = off.toDataURL('image/png');
  if (!url.startsWith(PNG_DATA_PREFIX)) return;
  post({ t: 'image', width: root.width, height: root.height, data: url.slice(PNG_DATA_PREFIX.length) });
}

function scheduleKittyPaint() {
  if (paintRaf) return;
  paintRaf = requestAnimationFrame(() => {
    paintRaf = 0;
    paintKittyOverlay();
  });
}

const kittyWriteQueue = [];
let kittyWriting = false;

function handleKittyApc(body) {
  const { effect } = kittyGraphics.processApc(body);
  let cursorMove;
  if (effect.type === 'image') {
    decodeImageRecord(effect.image);
    if (effect.display) cursorMove = placeDirect(effect.image, effect.display);
    scheduleKittyPaint();
  } else if (effect.type === 'place') {
    decodeImageRecord(effect.image);
    cursorMove = placeDirect(effect.image, effect.display);
    scheduleKittyPaint();
  } else if (effect.type === 'animate') {
    decodeImageRecord(effect.image);
    scheduleKittyPaint();
  } else if (effect.type === 'delete') {
    if (effect.selector.toLowerCase() === 'a') {
      clearDirectPlacements();
      if (effect.free) {
        for (const e of kittyDecoded.values()) closeDecodedEntry(e);
        kittyDecoded.clear();
      }
    } else if (effect.imageId !== undefined) {
      clearDirectPlacements((p) => p.imageId === effect.imageId && (!effect.placementId || p.placementId === effect.placementId));
    }
    pruneDecoded();
    scheduleKittyPaint();
  }
  return cursorMove;
}

function pumpKittyWrites() {
  if (kittyWriting) return;
  const job = kittyWriteQueue[0];
  if (!job) return;
  if (job.idx >= job.segs.length) {
    kittyWriteQueue.shift();
    if (job.cb) {
      kittyWriting = true;
      term.write('', () => {
        kittyWriting = false;
        job.cb?.();
        pumpKittyWrites();
      });
    } else {
      pumpKittyWrites();
    }
    return;
  }
  const seg = job.segs[job.idx++];
  const isLast = job.idx >= job.segs.length;
  kittyWriting = true;
  if (seg.type === 'text') {
    term.write(seg.data, () => {
      kittyWriting = false;
      if (isLast) {
        kittyWriteQueue.shift();
        job.cb?.();
      }
      pumpKittyWrites();
    });
  } else {
    term.write('', () => {
      const cursorMove = handleKittyApc(seg.body);
      if (cursorMove) {
        term.write(cursorMove, () => {
          kittyWriting = false;
          if (isLast) {
            kittyWriteQueue.shift();
            job.cb?.();
          }
          pumpKittyWrites();
        });
      } else {
        kittyWriting = false;
        if (isLast) {
          kittyWriteQueue.shift();
          job.cb?.();
        }
        pumpKittyWrites();
      }
    });
  }
}

function writeKittyStream(data, cb) {
  const segs = kittySplitter.feed(data);
  kittyWriteQueue.push({ segs, idx: 0, cb });
  pumpKittyWrites();
}

function layout() {
  const viewW = window.innerWidth - PAD * 2;
  const viewH = window.innerHeight - PAD * 2;
  const { w, h } = gridSize();
  host.style.width = `${w}px`;
  host.style.height = `${h}px`;
  scale = fitScale(view, viewW, viewH, w, h, MAX_SCALE);
  host.style.transform = `scale(${scale})`;
  // The grid that would fit at readable size, for the phone view to resize the PTY to.
  const fit = fitGrid(viewW, viewH, w / term.cols, h / term.rows);
  const key = fit ? `${fit.cols}x${fit.rows}` : '';
  if (fit && key !== lastFit) {
    lastFit = key;
    post({ t: 'fit', cols: fit.cols, rows: fit.rows });
  }
  scheduleKittyPaint();
}

let queued = false;
function relayout() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    layout();
  });
}
window.addEventListener('resize', relayout);
term.onResize(relayout);

let atBottom = true;
function checkBottom() {
  const b = term.buffer.active;
  const at = b.viewportY >= b.baseY;
  if (at === atBottom) return;
  atBottom = at;
  post({ t: 'bottom', at });
}
term.onScroll(() => {
  checkBottom();
  scheduleKittyPaint();
});
term.onRender(scheduleKittyPaint);
term.onWriteParsed(() => {
  const buf = term.buffer.active;
  const from = Math.max(0, Math.min(scannedLength - term.rows, buf.baseY));
  if (hidePlaceholders(from, buf.length - 1)) {
    term.refresh(0, term.rows - 1);
  }
  scannedLength = buf.length;
  checkBottom();
  scheduleKittyPaint();
});

const programState = () => ({
  alternate: term.buffer.active.type === 'alternate',
  mouse: term.modes.mouseTrackingMode,
  appCursor: term.modes.applicationCursorKeysMode,
  encoding,
});

/** The 1-based cell under a point on the page. */
function cellAt(x, y) {
  const r = host.getBoundingClientRect();
  const col = Math.floor((x - r.left) / (r.width / term.cols)) + 1;
  const row = Math.floor((y - r.top) / (r.height / term.rows)) + 1;
  return { col: Math.min(term.cols, Math.max(1, col)), row: Math.min(term.rows, Math.max(1, row)) };
}

const rows = new RowAccumulator();
/** Scrolls by `px` dragged at a point (positive is toward newer lines); false once nothing moves. */
function scrollBy(px, x, y) {
  const n = rows.add(px, (gridSize().h / term.rows) * scale);
  if (!n) return true;
  const state = programState();
  if (swipeGoesToProgram(state)) {
    const { col, row } = cellAt(x, y);
    const data = swipeInput(n, state, col, row);
    if (data) post({ t: 'input', data });
    return true;
  }
  const before = term.buffer.active.viewportY;
  term.scrollLines(n);
  checkBottom();
  return term.buffer.active.viewportY !== before;
}

let touch = null;
let flick = 0;
const stopFlick = () => {
  if (flick) cancelAnimationFrame(flick);
  flick = 0;
};

// Captured before xterm sees them: one finger scrolls (or taps a Kitty image), and nothing focuses or selects.
const opts = { passive: false, capture: true };
document.addEventListener(
  'touchstart',
  (e) => {
    e.preventDefault();
    const wasFlicking = flick !== 0;
    stopFlick();
    rows.reset();
    if (e.touches.length === 1) {
      const p = e.touches[0];
      touch = {
        x: p.clientX,
        y: p.clientY,
        startX: p.clientX,
        startY: p.clientY,
        startTime: e.timeStamp,
        maxMove: 0,
        dragging: false,
        wasFlicking,
        multiTouch: false,
        t: e.timeStamp,
        v: 0,
      };
    } else if (touch) {
      touch.multiTouch = true;
    } else {
      touch = null;
    }
  },
  opts,
);
document.addEventListener(
  'touchmove',
  (e) => {
    e.preventDefault();
    if (!touch) return;
    if (e.touches.length !== 1) {
      touch.multiTouch = true;
      return;
    }
    const p = e.touches[0];
    const totalMove = Math.hypot(p.clientX - touch.startX, p.clientY - touch.startY);
    if (totalMove > touch.maxMove) touch.maxMove = totalMove;
    if (!touch.dragging) {
      if (totalMove <= TAP_SLOP_PX) return;
      touch.dragging = true;
      touch.x = p.clientX;
      touch.y = p.clientY;
      touch.t = e.timeStamp;
      return;
    }
    const dy = touch.y - p.clientY;
    const dt = Math.max(1, e.timeStamp - touch.t);
    touch.v = 0.8 * (dy / dt) + 0.2 * touch.v;
    touch.y = p.clientY;
    touch.t = e.timeStamp;
    scrollBy(dy, touch.x, touch.y);
  },
  opts,
);
document.addEventListener(
  'touchend',
  (e) => {
    e.preventDefault();
    if (e.touches.length > 0) {
      if (touch) touch.multiTouch = true;
      return;
    }
    const t = touch;
    touch = null;
    if (!t) return;
    if (
      !t.dragging &&
      isKittyTap({
        movedPx: t.maxMove,
        durationMs: e.timeStamp - t.startTime,
        wasFlicking: t.wasFlicking,
        multiTouch: t.multiTouch,
      })
    ) {
      const hit = hitTestKittyTap(drawnKittyRects, host.getBoundingClientRect(), term.cols, term.rows, t.startX, t.startY);
      if (hit) openTappedKittyImage(hit.imageId);
      return;
    }
    // A flick coasts through history; a full-screen program gets only what the finger moved.
    if (!t.dragging || e.timeStamp - t.t > 80 || swipeGoesToProgram(programState())) return;
    let speed = t.v;
    let last = performance.now();
    const step = (now) => {
      const dt = now - last;
      last = now;
      const moved = scrollBy(speed * dt, t.x, t.y);
      speed = moved ? coast(speed, dt) : 0;
      flick = speed ? requestAnimationFrame(step) : 0;
    };
    if (coast(speed, 0)) flick = requestAnimationFrame(step);
  },
  opts,
);
document.addEventListener(
  'touchcancel',
  () => {
    touch = null;
  },
  opts,
);

window.office = {
  receive(msg) {
    switch (msg.t) {
      case 'config':
        term.options.fontSize = READABLE_PX * (msg.fontScale > 0 ? msg.fontScale : 1);
        view = msg.view;
        relayout();
        break;
      case 'view':
        view = msg.view;
        relayout();
        break;
      case 'snapshot':
        stopFlick();
        encoding = 0;
        resetKitty();
        term.reset();
        if (msg.cols !== term.cols || msg.rows !== term.rows) term.resize(msg.cols, msg.rows);
        writeKittyStream(msg.data, () => {
          term.scrollToBottom();
          checkBottom();
          relayout();
          post({ t: 'drawn' });
        });
        break;
      case 'data':
        writeKittyStream(msg.data);
        break;
      case 'size':
        if (msg.cols !== term.cols || msg.rows !== term.rows) term.resize(msg.cols, msg.rows);
        break;
      case 'bottom':
        stopFlick();
        term.scrollToBottom();
        checkBottom();
        break;
    }
  },
};

relayout();
reportKittyFlags();
post({ t: 'ready' });
