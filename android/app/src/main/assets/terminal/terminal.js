import { fitFont, fitGrid, fitScale, RowAccumulator, SGR, swipeInput, URXVT, UTF8 } from './input.js';
import { minimumContrast } from './theme.js';

const READABLE_PX = 12.5;
const PAD = 8;
const post = (msg) => window.OfficeBridge?.post(JSON.stringify(msg));

async function expandImage({ blob, width, height }) {
  // Bound the image handed to the Kotlin viewer (and its JavaScript bridge).
  if (Math.max(width, height) > 2048) {
    const ratio = 2048 / Math.max(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const bitmap = await createImageBitmap(blob, { resizeWidth: canvas.width, resizeHeight: canvas.height });
    try {
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    } finally {
      bitmap.close();
    }
  }
  if (!blob || blob.size > 12 * 1024 * 1024) return;
  const reader = new FileReader();
  reader.onload = () => post({ t: 'image', width, height, data: reader.result.split(',')[1] });
  reader.readAsDataURL(blob);
}

export async function start() {
  const [{ createAndroidTerminal, TERM_THEME }] = await Promise.all([
    import('./vendor/android-terminal.js'),
    document.fonts.load(`400 ${READABLE_PX}px 'Geist Mono'`),
    document.fonts.load(`400 ${READABLE_PX}px 'Droid Office Terminal Symbols'`, '\ue0b0'),
  ]);
  const host = document.querySelector('#term');
  const { term, expandAtClient } = createAndroidTerminal({ onExpandImage: expandImage });
  await term.open(host);
  const { core, native } = term;
  const root = native.element;
  term.textarea.readOnly = true;
  term.textarea.tabIndex = -1;
  term.textarea.inputMode = 'none';
  let view = 'desktop';
  let baseFont = READABLE_PX;
  let baseW = parseFloat(root.style.getPropertyValue('--term-cell-width'));
  let baseH = parseFloat(root.style.getPropertyValue('--term-row-height'));
  let lastFit = '';
  let lastLayout = '';
  let cellW = 0;
  let cellH = 0;
  function layout() {
    const availW = innerWidth - PAD * 2;
    const availH = innerHeight - PAD * 2;
    if (!(baseW > 0 && availW > 0 && availH > 0)) return;
    const dimensions = `${availW},${availH},${term.cols},${term.rows},${view}`;
    if (dimensions === lastLayout) return;
    lastLayout = dimensions;
    // Size the actual glyphs rather than transforming their parent. WTerm measures
    // a rendered glyph in viewport pixels for its cursor, hit targets and rows.
    const scale = fitScale(view, availW, availH, term.cols * baseW, term.rows * baseH, 24 / READABLE_PX);
    fitFont(baseFont * scale, (font) => {
      term.options.fontSize = font;
      cellW = parseFloat(root.style.getPropertyValue('--term-cell-width'));
      cellH = parseFloat(root.style.getPropertyValue('--term-row-height'));
      return cellW * term.cols <= availW && cellH * term.rows <= availH;
    });
    host.style.width = `${term.cols * cellW}px`;
    host.style.height = `${term.rows * cellH}px`;
    const fit = fitGrid(availW, availH, baseW, baseH);
    const key = `${fit.cols}x${fit.rows}`;
    if (key !== lastFit) post({ t: 'fit', ...fit });
    lastFit = key;
  }

  let atBottom = true;
  const bottom = () => {
    const at = root.scrollHeight - root.scrollTop - root.clientHeight < 1;
    if (at !== atBottom) post({ t: 'bottom', at });
    atBottom = at;
  };
  root.addEventListener('scroll', bottom, { passive: true });
  let hasMarks = false;
  let prompts = false;
  function updatePrompts(alternate) {
    const available = hasMarks && !alternate;
    if (available !== prompts) post({ t: 'prompts', available });
    prompts = available;
  }
  let lastFlags = -1;
  function modes() {
    const flags = core.kittyKeyboardFlags();
    if (lastFlags !== flags) post({ t: 'kitty', flags });
    lastFlags = flags;
    const alternate = core.usingAltScreen();
    root.classList.toggle('program-swipe', alternate || !!core.mouseTracking());
    updatePrompts(alternate);
  }
  term.onWriteParsed(modes);
  modes();
  native.onSearchChange = ({ activeIndex, count, searching, limited }) => post({ t: 'matches', active: activeIndex, count, searching, limited });
  native.onShellIntegration = (state) => {
    hasMarks = state.phase !== 'unknown';
    updatePrompts(core.usingAltScreen());
  };

  // History uses WebView's own pan and inertia. Only a program which consumes
  // swipes takes a gesture away from the browser. Do not send simulated inertia to a TUI.
  const accumulator = new RowAccumulator();
  let touch;
  let tap;
  let lastScroll = -Infinity;
  root.addEventListener(
    'scroll',
    () => {
      lastScroll = performance.now();
    },
    { passive: true },
  );
  root.addEventListener(
    'touchstart',
    (e) => {
      accumulator.reset();
      const p = e.touches[0];
      tap = e.touches.length === 1 && performance.now() - lastScroll > 80 ? { x: p.clientX, y: p.clientY, time: e.timeStamp } : null;
      touch = e.touches.length === 1 && root.classList.contains('program-swipe') ? e.touches[0] : null;
    },
    { passive: true },
  );
  root.addEventListener(
    'touchmove',
    (e) => {
      const pos = e.touches[0];
      if (tap && (e.touches.length !== 1 || Math.hypot(pos.clientX - tap.x, pos.clientY - tap.y) > 8)) tap = null;
      if (!touch || e.touches.length !== 1) {
        touch = null;
        return;
      }
      const p = e.touches[0];
      const count = accumulator.add(touch.clientY - p.clientY, cellH);
      touch = p;
      if (!count) return;
      const rect = root.getBoundingClientRect();
      const px = p.clientX - rect.left;
      const py = p.clientY - rect.top;
      const encoding = core.mouseEncoding();
      const col = Math.max(1, Math.min(term.cols, 1 + Math.floor(px / cellW)));
      const row = Math.max(1, Math.min(term.rows, 1 + Math.floor(py / cellH)));
      if (encoding === 'x10' && core.mouseTracking() && (col > 95 || row > 95)) return;
      const pixel = encoding === 'sgr-pixels';
      const state = { mouse: term.modes.mouseTrackingMode, appCursor: core.cursorKeysApp(), encoding: pixel || encoding === 'sgr' ? SGR : encoding === 'utf8' ? UTF8 : encoding === 'urxvt' ? URXVT : 0 };
      post({ t: 'input', data: swipeInput(count, state, pixel ? Math.floor(px) + 1 : col, pixel ? Math.floor(py) + 1 : row) });
    },
    { passive: true },
  );
  for (const name of ['touchend', 'touchcancel'])
    root.addEventListener(
      name,
      (e) => {
        if (name === 'touchend' && tap && e.changedTouches.length === 1 && e.timeStamp - tap.time <= 350 && expandAtClient(tap.x, tap.y)) {
          // Suppress the emulated mouse click after expanding by touch.
          e.preventDefault();
        }
        tap = null;
        touch = null;
      },
      { passive: false },
    );
  window.addEventListener('resize', layout);
  term.onResize(layout);
  document.addEventListener('visibilitychange', () => term.setRenderingPaused(document.hidden));
  window.addEventListener('pagehide', () => term.dispose(), { once: true });

  window.office = {
    receive(msg) {
      switch (msg.t) {
        case 'search':
          if (msg.query) native.search(msg.query);
          else native.clearSearch();
          break;
        case 'match':
          if (msg.direction === 1) native.findNext();
          else native.findPrevious();
          break;
        case 'prompt':
          native.scrollToPrompt(msg.direction);
          break;
        case 'colors': {
          const theme = { ...TERM_THEME, ...msg.theme };
          term.options.theme = theme;
          term.options.minimumContrastRatio = minimumContrast(theme.background);
          document.documentElement.style.setProperty('--terminal-ground', theme.background);
          break;
        }
        case 'config':
          lastLayout = '';
          baseFont = READABLE_PX * (msg.fontScale > 0 ? msg.fontScale : 1);
          term.options.fontSize = baseFont;
          baseW = parseFloat(root.style.getPropertyValue('--term-cell-width'));
          baseH = parseFloat(root.style.getPropertyValue('--term-row-height'));
          view = msg.view;
          layout();
          break;
        case 'view':
          view = msg.view;
          layout();
          break;
        case 'snapshot': {
          const restore = term.saveReader();
          term.reset();
          term.resize(msg.cols, msg.rows);
          term.write(msg.data, () => {
            layout();
            if (restore) restore();
            else term.scrollToBottom();
            post({ t: 'drawn' });
          });
          break;
        }
        case 'data':
          term.write(msg.data);
          break;
        case 'size':
          term.resize(msg.cols, msg.rows);
          break;
        case 'bottom':
          term.scrollToBottom();
          break;
      }
    },
  };
  layout();
  post({ t: 'ready' });
}
