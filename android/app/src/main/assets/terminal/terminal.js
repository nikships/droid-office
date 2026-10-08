// A worker's terminal on the phone: xterm.js fed the office's `term.snapshot` and `term.data` by the
// app (ui/worker/TerminalPage.kt), so its scrollback holds the history the office's PTY host kept.
// It never types: the app's composer and quick keys do. Messages to the app go through
// `OfficeBridge.post`, messages from it arrive at `office.receive`.

import { Unicode11Addon } from './vendor/addon-unicode11.mjs';
import { Terminal } from './vendor/xterm.mjs';
import { coast, fitGrid, fitScale, nextEncoding, RowAccumulator, swipeGoesToProgram, swipeInput } from './input.js';
import { THEME } from './theme.js';

/** Readable text, in CSS pixels before the phone's font scale (the native app's 12.5 sp). */
const READABLE_PX = 12.5;
/** The desktop view grows a narrow terminal on a tablet up to 24 sp, no further. */
const MAX_SCALE = 24 / READABLE_PX;
const PAD = 8;
const FONT = "'Geist Mono', 'Droid Office Terminal Symbols', monospace";

const post = (msg) => window.OfficeBridge?.post(JSON.stringify(msg));
const host = document.getElementById('term');

// xterm measures its cells when it opens: with a font still loading, it measures the fallback.
await Promise.allSettled([document.fonts.load(`400 ${READABLE_PX}px 'Geist Mono'`), document.fonts.load(`400 ${READABLE_PX}px 'Droid Office Terminal Symbols'`, '\ue0b0')]);

const term = new Terminal({
  fontFamily: FONT,
  fontSize: READABLE_PX,
  lineHeight: 1.1,
  theme: THEME,
  scrollback: 5000,
  allowProposedApi: true,
  disableStdin: true,
  cursorBlink: false,
  cursorInactiveStyle: 'block',
});
const unicode = new Unicode11Addon();
term.loadAddon(unicode);
term.unicode.activeVersion = '11';

// The serialize addon leaves the mouse encoding out, so the office appends it to each snapshot
// (src/server/screen.ts); follow it here to answer a swipe in the encoding the program reads.
let encoding = 0;
term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
  encoding = nextEncoding(encoding, params, true);
  return false;
});
term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
  encoding = nextEncoding(encoding, params, false);
  return false;
});

term.open(host);
// Taps must not raise the keyboard: the terminal shows the program, the composer types.
term.textarea.readOnly = true;
term.textarea.tabIndex = -1;
term.textarea.setAttribute('inputmode', 'none');

let view = 'desktop';
let scale = 1;
let lastFit = '';

/** The grid's size in CSS pixels before scaling, as xterm's renderer laid it out. */
function gridSize() {
  const el = host.querySelector('.xterm-screen');
  return { w: Number.parseFloat(el?.style.width) || el?.offsetWidth || 0, h: Number.parseFloat(el?.style.height) || el?.offsetHeight || 0 };
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
term.onScroll(checkBottom);
term.onWriteParsed(checkBottom);

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

// Captured before xterm sees them: one finger scrolls, and nothing focuses or selects.
const opts = { passive: false, capture: true };
document.addEventListener(
  'touchstart',
  (e) => {
    e.preventDefault();
    stopFlick();
    rows.reset();
    const p = e.touches.length === 1 ? e.touches[0] : undefined;
    touch = p ? { x: p.clientX, y: p.clientY, t: e.timeStamp, v: 0 } : null;
  },
  opts,
);
document.addEventListener(
  'touchmove',
  (e) => {
    e.preventDefault();
    if (!touch || e.touches.length !== 1) return;
    const p = e.touches[0];
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
    const t = touch;
    touch = null;
    // A flick coasts through history; a full-screen program gets only what the finger moved.
    if (!t || e.timeStamp - t.t > 80 || swipeGoesToProgram(programState())) return;
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
        term.reset();
        if (msg.cols !== term.cols || msg.rows !== term.rows) term.resize(msg.cols, msg.rows);
        term.write(msg.data, () => {
          term.scrollToBottom();
          checkBottom();
          relayout();
          post({ t: 'drawn' });
        });
        break;
      case 'data':
        term.write(msg.data);
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
post({ t: 'ready' });
