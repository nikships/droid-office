// The phone's Whiteboard card surface: what src/client/ui/whiteboard-surface.ts does in the office's
// window, for one card in the app's WebView (core/WbPage.kt describes the routes and the bridge).
//
// An html card loads in a sandboxed iframe from /card/<cap>/<entry>#wb=<nonce>, with the office's
// sandbox flags and never allow-same-origin, laid out at the canonical width. The frame is as tall as
// the WebView's layout viewport and scrolls itself; the marks layer sits over it in page coordinates,
// moved by the frame's scroll from its `layout` messages. A message counts only when it comes from
// that frame's contentWindow with that load's nonce, and every operation it makes is for this card.
// A canvas card is a blank surface the page itself scrolls. The WebView's own pinch zoom zooms both;
// pins and handles keep a finger's size at any zoom (--unzoom).
//
// The app talks to this page only: `board.receive` takes its messages, `OfficeBridge.postMessage`
// carries this page's (a web message listener the app allows for this page's origin alone).

import {
  BRIDGE_CHANNEL,
  CANONICAL_WIDTH,
  CARD_ALLOW,
  CARD_SANDBOX,
  STICKY_COLORS,
  STICKY_SIZE,
  actionOp,
  anchorKey,
  applyLocal,
  authorColor,
  authorName,
  canvasBounds,
  contentRev,
  copy,
  dragMarkOps,
  dragPreview,
  findMark,
  isAnchor,
  isNum,
  isObj,
  isPoint,
  jsonEqual,
  kindOf,
  normalize,
  pictureSize,
  reattachMarkOps,
  stateChanges,
  stateWith,
  writeOp,
} from './marks.js';

const TYPING_IDLE_MS = 1000;
const LOCATE_DEBOUNCE_MS = 150;
const RESOLVE_SETTLE_MS = 800;
const HOLD_MS = 500;
/** How far a finger moves (dp) before a tap becomes a drag. */
const SLOP_DP = 10;
/** How long a card from before the owner's own change waits, at most, for the board that has it. */
const SETTLE_MS = 3000;

const root = document.documentElement;
const boardEl = document.getElementById('board');

const send = (msg) => window.OfficeBridge?.postMessage(JSON.stringify(msg));

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(text, onClick) {
  const b = h('button', '', text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function place(el, x, y, w, ht) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  if (w !== undefined) el.style.width = `${w}px`;
  if (ht !== undefined) el.style.height = `${ht}px`;
}

function randomId(prefix) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => abc[b % abc.length]).join('');
}

function makeNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const toSet = (list) => new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);

// ---- What the page holds ----

let card = null;
/** The newest card the app sent while the owner's own changes were on their way. */
let latest = null;
let cap = null;
let secret = '';
let mode = 'use';
let live = false;
let widthDp = 400;
let changed = new Set();
let draft = null;
let picking = null;
let selected = null;
let flashId = null;

let opSeq = 0;
let inflight = 0;
/** The board revision that has every change the office acknowledged from this page. */
let need = 0;
let settleTimer = 0;

let page = null;
let catcher = null;
let marks = null;
let stage = null;
let canvasBox = null;
let draftEl = null;
const banner = h('div', 'banner hidden');
const placeholder = h('div', 'placeholder hidden');

let slot = null;
let incoming = null;
/** The card's state as the frame has it: what it was given plus its own writes. */
let frameState = {};
let scrollY = 0;
let viewH = 720;
let lastSize = { w: 0, h: 0 };
let reqSeq = 0;
let locateTimer = 0;
let resolveTimer = 0;
let reloadWait = null;
const located = new Map();
const reqs = new Map();
const sentResolve = new Map();
const markEls = new Map();

// ---- Zoom: CSS px are canonical px; the WebView scales them to the phone ----

/** Device-independent pixels per canonical pixel, as the WebView shows the page now. */
function zoom() {
  const w = window.visualViewport?.width ?? window.innerWidth;
  return w > 0 ? widthDp / w : 1;
}

const slop = () => SLOP_DP / zoom();

function applyZoom() {
  root.style.setProperty('--unzoom', String(Math.max(1, Math.min(6, 1 / zoom()))));
}

window.visualViewport?.addEventListener('resize', applyZoom);

// ---- The app's messages ----

function receive(m) {
  if (!isObj(m)) return;
  switch (m.t) {
    case 'open':
      open(m);
      break;
    case 'card':
      if (!card || !isObj(m.card) || m.card.id !== card.id) return;
      if (typeof m.cap === 'string') cap = m.cap;
      changed = toSet(m.changed);
      offer(m.card, isNum(m.rev) ? m.rev : 0);
      break;
    case 'mode':
      setMode(m.mode === 'markup' ? 'markup' : 'use');
      break;
    case 'live':
      live = m.live === true;
      if (live) scheduleLocate();
      break;
    case 'draft':
      draft = isPoint(m.point) ? m.point : null;
      drawDraft();
      break;
    case 'focus':
      if (typeof m.id === 'string') focusMark(m.id);
      break;
    case 'width':
      if (isNum(m.widthDp) && m.widthDp > 0) widthDp = m.widthDp;
      applyZoom();
      break;
    case 'done':
      settled(m.ok === true, isNum(m.rev) ? m.rev : 0);
      break;
    case 'pick':
      if (['thread', 'sticky', 'picture'].includes(m.kind) && typeof m.id === 'string') startPicking(m.kind, m.id);
      break;
    case 'picture':
      if (isObj(m.file) && /^[0-9a-f]{64}$/.test(m.file.hash) && isNum(m.w) && isNum(m.h)) addPicture(m.file, m.w, m.h);
      break;
  }
}

function open(m) {
  if (!isObj(m.card) || typeof m.card.id !== 'string') return;
  card = normalize(copy(m.card));
  cap = typeof m.cap === 'string' ? m.cap : null;
  secret = typeof m.secret === 'string' ? m.secret : '';
  mode = m.mode === 'markup' ? 'markup' : 'use';
  live = m.live === true;
  changed = toSet(m.changed);
  if (isNum(m.widthDp) && m.widthDp > 0) widthDp = m.widthDp;
  need = isNum(m.rev) ? m.rev : 0;
  frameState = card.state;
  const canvas = card.kind === 'canvas';
  root.classList.toggle('canvas', canvas);
  root.classList.toggle('html', !canvas);
  root.classList.toggle('markup', mode === 'markup');
  boardEl.replaceChildren();
  marks = h('div', 'marks');
  if (canvas) {
    stage = h('div', 'canvas-stage');
    stage.append(marks);
    boardEl.append(stage);
    stage.addEventListener('pointerdown', (e) => e.target === stage && press(e, stage, false));
  } else {
    page = h('div', 'page');
    catcher = h('div', 'catcher');
    page.append(catcher, marks);
    boardEl.append(page);
    catcher.addEventListener('pointerdown', (e) => press(e, catcher, true));
    measure();
    load();
  }
  document.body.append(placeholder, banner);
  applyZoom();
  renderMarks();
}

/** The board's card: shown now, unless it may be from before one of the owner's own changes. */
function offer(c, rev) {
  const next = { card: normalize(copy(c)), rev };
  if (inflight > 0 || rev < need) {
    if (!latest || rev >= latest.rev) latest = next;
    if (inflight === 0) armSettle();
    return;
  }
  latest = null;
  adopt(next.card);
}

function armSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (inflight === 0 && latest) adoptLatest();
  }, SETTLE_MS);
}

function adoptLatest() {
  const l = latest;
  latest = null;
  adopt(l.card);
}

/** The office answered one of the page's batches: committed at board revision `rev`, or refused. */
function settled(ok, rev) {
  inflight = Math.max(0, inflight - 1);
  if (ok) need = Math.max(need, rev);
  if (inflight > 0) return;
  // A refused change: the board's card, without it, is the truth again.
  if (latest && (!ok || latest.rev >= need)) adoptLatest();
  else armSettle();
}

function adopt(next) {
  const before = card;
  card = next;
  if (card.kind !== 'canvas') {
    const rev = contentRev(card);
    if (slot && rev !== slot.contentRev && (!incoming || incoming.contentRev !== rev)) requestReload();
    else if (!slot && !incoming) load();
    if (!jsonEqual(card.state, frameState)) pushState(before, card);
  }
  renderMarks();
  scheduleLocate();
}

/** Sends the page's operations for this card; they show here at once. */
function apply(ops, what, action) {
  if (!ops.length) return;
  inflight++;
  clearTimeout(settleTimer);
  for (const op of ops) applyLocal(card, op);
  send({ t: 'ops', id: ++opSeq, ops, what, ...(action ? { action } : {}) });
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  root.classList.toggle('markup', mode === 'markup');
  for (const s of [slot, incoming]) if (s?.ready) post(s, { type: 'mode', mode });
}

// ---- The frame ----

function cardUrl(nonce) {
  const entry = card.content?.entry;
  if (!cap || typeof entry !== 'string' || !entry) return null;
  return `/card/${cap}/${entry.split('/').map(encodeURIComponent).join('/')}#wb=${encodeURIComponent(nonce)}`;
}

function measure() {
  const hgt = Math.max(160, root.clientHeight || window.innerHeight || 720);
  if (hgt === viewH && page?.style.height) return;
  viewH = hgt;
  if (!page) return;
  page.style.height = `${viewH}px`;
  for (const s of [slot, incoming]) if (s) s.iframe.style.height = `${viewH}px`;
  scheduleLocate();
}

window.addEventListener('resize', () => {
  if (!card) return;
  if (card.kind === 'canvas') layoutCanvas();
  else measure();
  applyZoom();
});

function load() {
  const nonce = makeNonce();
  const url = cardUrl(nonce);
  if (!url) {
    showPlaceholder('Waiting for the office to send this card…');
    return;
  }
  const iframe = h('iframe', 'frame');
  iframe.setAttribute('sandbox', CARD_SANDBOX);
  iframe.setAttribute('allow', CARD_ALLOW);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.title = card.title || 'Card';
  iframe.style.width = `${CANONICAL_WIDTH}px`;
  iframe.style.height = `${viewH}px`;
  const s = { iframe, nonce, contentRev: contentRev(card), ready: false, loadedAt: performance.now(), typedAt: 0, layout: null, scrollSeq: 0, focus: null, sendFocus: null, restore: null };
  if (!slot) {
    slot = s;
    showPlaceholder('Loading…');
    s.restore = { x: 0, y: scrollY };
  } else {
    incoming = s;
    iframe.classList.add('incoming');
    s.restore = { x: slot.layout?.scrollX ?? 0, y: slot.layout?.scrollY ?? scrollY };
    // A page that never says it's ready still comes in.
    setTimeout(() => incoming === s && swapIn(s), 5000);
  }
  iframe.src = url;
  page.insertBefore(iframe, catcher);
}

/** A content change: reload now, or once the owner stops typing in the frame. */
function requestReload() {
  if (incoming) {
    incoming.iframe.remove();
    incoming = null;
  }
  if (reloadWait) return;
  if (!typing()) return load();
  // The frame reports what's focused, with any unsaved value: a second without typing (when the SDK saves the field), or focus leaving the frame, is the moment.
  reloadWait = { poll: setInterval(() => !typing() && reloadNow(), 200) };
  showReloadBanner();
}

function showReloadBanner() {
  showBanner('This card changed. It reloads when you stop typing.', button('Reload now', reloadNow));
}

function reloadNow() {
  if (reloadWait) clearInterval(reloadWait.poll);
  reloadWait = null;
  hideBanner();
  load();
}

/** The owner is typing in a field of the frame: an IME composition is open, or they typed in the last second and it isn't saved. */
function typing() {
  const s = slot;
  if (!s || document.activeElement !== s.iframe || !s.focus) return false;
  if (s.focus.composing) return true;
  return s.focus.value !== undefined && performance.now() - s.typedAt < TYPING_IDLE_MS;
}

function swapIn(s) {
  if (incoming !== s) return;
  const old = slot;
  const hadFocus = !!old && document.activeElement === old.iframe;
  incoming = null;
  slot = s;
  s.iframe.classList.remove('incoming');
  old?.iframe.remove();
  if (hadFocus) {
    s.iframe.focus({ preventScroll: true });
    if (old.focus) refocus(s, old.focus);
  }
  if (s.layout) onLayout(s, s.layout, true);
  scheduleLocate();
}

/** Writes what the frame says was typed in its focused field and not saved yet. */
function saveTyped(f) {
  if (f?.key === undefined || f.value === undefined) return;
  const fields = frameState.fields;
  if (jsonEqual(isObj(fields) ? fields[f.key] : undefined, f.value)) return;
  const op = writeOp(card.id, { op: 'set', path: ['fields', f.key], value: f.value });
  frameState = stateWith(frameState, op);
  apply([op], 'Saving the form');
}

function refocus(s, f) {
  saveTyped(f);
  if (s.ready) post(s, { type: 'focus', field: f });
  else s.sendFocus = f;
}

function post(s, msg) {
  s.iframe.contentWindow?.postMessage({ ...msg, channel: BRIDGE_CHANNEL, nonce: s.nonce }, '*');
}

window.addEventListener('message', (e) => {
  const s = [slot, incoming].find((x) => x && e.source === x.iframe.contentWindow);
  const d = e.data;
  if (!s || !isObj(d) || d.channel !== BRIDGE_CHANNEL || typeof d.nonce !== 'string' || d.nonce !== s.nonce) return;
  onFrame(s, d);
});

function onFrame(s, d) {
  switch (d.type) {
    case 'ready':
      if (!isNum(d.version)) return;
      s.ready = true;
      post(s, { type: 'init', card: { id: card.id, title: card.title ?? '', author: card.author ?? { kind: 'owner' } }, state: card.state, rendering: false, mode, width: CANONICAL_WIDTH });
      if (s === slot) frameState = card.state;
      if (s.sendFocus) {
        post(s, { type: 'focus', field: s.sendFocus });
        s.sendFocus = null;
      }
      break;
    case 'focus': {
      const f = isObj(d.field) ? d.field : null;
      if (f?.value !== s.focus?.value || f?.composing !== s.focus?.composing) s.typedAt = performance.now();
      s.focus = f;
      break;
    }
    case 'layout': {
      if (!isNum(d.width) || !isNum(d.height) || !isNum(d.scrollX) || !isNum(d.scrollY)) return;
      const first = !s.layout;
      s.layout = { width: d.width, height: d.height, scrollX: d.scrollX, scrollY: d.scrollY, seq: Number.isSafeInteger(d.seq) ? d.seq : 0 };
      if (first && s.restore && (s.restore.y > 0 || s.restore.x > 0)) post(s, { type: 'scrollTo', x: s.restore.x, y: s.restore.y });
      if (s === incoming) {
        if (first) {
          // The old content stays up until the new one has its scroll back.
          frameState = card.state;
          setTimeout(() => swapIn(s), 120);
        }
        break;
      }
      if (first) hidePlaceholder();
      onLayout(s, s.layout, first);
      break;
    }
    case 'write': {
      if (s !== slot) break;
      const op = writeOp(card.id, d.write);
      if (!op) return;
      frameState = stateWith(frameState, op);
      apply([op], 'Saving the form');
      break;
    }
    case 'action': {
      if (s !== slot || typeof d.name !== 'string' || !d.name) break;
      const op = actionOp(card.id, d.name, d.data);
      frameState = stateWith(frameState, op);
      apply([op], 'Recording the action', d.name);
      break;
    }
    case 'anchor':
    case 'positions': {
      const done = reqs.get(d.req);
      if (done) {
        reqs.delete(d.req);
        done(d);
      }
      break;
    }
    case 'wheel':
      // A mouse or trackpad on the phone: the frame leaves its scrolling to the host.
      if (s !== slot || d.zoom || !isNum(d.dy)) break;
      scrollFrame(scrollY + d.dy * (d.deltaMode === 1 ? 16 : d.deltaMode === 2 ? viewH : 1));
      break;
    case 'shortcut':
      if (s === slot && (d.key === 'm' || d.key === 'f')) send({ t: 'shortcut', key: d.key });
      break;
  }
}

function pushState(before, next) {
  frameState = next.state;
  if (slot?.ready) post(slot, { type: 'state', state: next.state, changes: stateChanges(before, next) });
}

function onLayout(s, l, first) {
  // A resize or an earlier scroll acknowledgement must not rewind an in-flight gesture.
  if ((l.seq ?? 0) >= (s.scrollSeq ?? 0)) scrollY = l.scrollY;
  positionMarks();
  if (first || l.width !== lastSize.w || l.height !== lastSize.h) {
    lastSize = { w: l.width, h: l.height };
    scheduleLocate();
  }
}

function scrollFrame(y) {
  const s = slot;
  if (!s) return;
  const maxY = Math.max(0, (s.layout?.height ?? 0) - viewH);
  scrollY = Math.max(0, Math.min(maxY, y));
  if (s.ready) {
    s.scrollSeq = (s.scrollSeq ?? 0) + 1;
    post(s, { type: 'scrollTo', x: s.layout?.scrollX ?? 0, y: scrollY, seq: s.scrollSeq });
  }
  positionMarks();
}

function positionMarks() {
  if (!card || card.kind === 'canvas' || !marks) return;
  marks.style.transform = `translate(${-(slot?.layout?.scrollX ?? 0)}px, ${-scrollY}px)`;
}

/** Which anchor a page point lands on: the frame's answer on an artifact, the point itself on a canvas. */
function anchorAt(p) {
  const point = { x: Math.round(p.x), y: Math.round(p.y) };
  const fallback = { kind: 'point', point };
  const s = slot;
  if (card.kind === 'canvas' || !s?.ready) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const req = ++reqSeq;
    const timer = setTimeout(() => {
      reqs.delete(req);
      resolve(fallback);
    }, 1500);
    reqs.set(req, (msg) => {
      clearTimeout(timer);
      resolve(msg.type === 'anchor' && isAnchor(msg.anchor) ? msg.anchor : fallback);
    });
    post(s, { type: 'anchorAt', req, point });
  });
}

// ---- Locating marks ----

const allMarks = () => [...card.threads, ...card.stickies, ...card.pictures];

function scheduleLocate() {
  clearTimeout(locateTimer);
  locateTimer = setTimeout(locate, LOCATE_DEBOUNCE_MS);
}

function locate() {
  const s = slot;
  if (!card || card.kind === 'canvas' || !s?.ready || !s.layout) return;
  const items = allMarks()
    .filter((m) => isAnchor(m.anchor))
    .map((m) => ({ id: m.id, anchor: m.anchor }));
  if (!items.length) return;
  const keys = new Map(items.map((i) => [i.id, anchorKey(i.anchor)]));
  const req = ++reqSeq;
  const timer = setTimeout(() => reqs.delete(req), 2000);
  reqs.set(req, (msg) => {
    clearTimeout(timer);
    if (msg.type !== 'positions' || !Array.isArray(msg.positions) || s !== slot) return;
    for (const p of msg.positions) {
      const key = isObj(p) && keys.get(p.id);
      if (!key) continue;
      const point = isPoint(p.point) ? p.point : (located.get(p.id)?.point ?? { x: 0, y: 0 });
      located.set(p.id, { point, detached: p.detached === true || !isPoint(p.point), key });
    }
    renderMarks();
    // The verdict goes on the board once the page has settled, so a page still loading doesn't flap it.
    clearTimeout(resolveTimer);
    const wait = Math.max(0, RESOLVE_SETTLE_MS - (performance.now() - s.loadedAt));
    resolveTimer = setTimeout(resolveMarks, wait + 200);
  });
  post(s, { type: 'locate', req, anchors: items });
}

/** Tells the board which marks are detached now, and which are back. */
function resolveMarks() {
  if (!live || !card) return;
  const out = [];
  for (const mark of allMarks()) {
    const l = located.get(mark.id);
    if (!l || l.key !== anchorKey(mark.anchor)) continue;
    if (l.detached === !!mark.detached || sentResolve.get(mark.id) === l.detached) continue;
    out.push({ id: mark.id, detached: l.detached });
  }
  if (!out.length) return;
  for (const m of out) sentResolve.set(m.id, m.detached);
  apply([{ op: 'marks.resolve', card: card.id, marks: out }], 'Placing the marks');
}

function isDetached(mark) {
  const l = located.get(mark.id);
  if (l && l.key === anchorKey(mark.anchor)) return l.detached;
  return !!mark.detached;
}

/** Where a mark's anchor is on the page now (canonical px). */
function markPoint(mark) {
  if (!isPoint(mark.anchor?.point)) return { x: 0, y: 0 };
  if (mark.anchor.kind === 'point' || card.kind === 'canvas') return mark.anchor.point;
  const l = located.get(mark.id);
  return l && l.key === anchorKey(mark.anchor) && !l.detached ? l.point : mark.anchor.point;
}

// ---- A canvas card ----

/** The surface covers every mark and at least the screen; it grows but never shrinks while open, so nothing jumps. */
function layoutCanvas() {
  if (!stage) return;
  const b = canvasBounds(card, undefined, markPoint);
  let x0 = Math.min(b.x, 0);
  let y0 = Math.min(b.y, 0);
  let x1 = Math.max(b.x + b.w, CANONICAL_WIDTH);
  let y1 = Math.max(b.y + b.h, root.clientHeight || 720);
  if (canvasBox) {
    x0 = Math.min(x0, canvasBox.x);
    y0 = Math.min(y0, canvasBox.y);
    x1 = Math.max(x1, canvasBox.x + canvasBox.w);
    y1 = Math.max(y1, canvasBox.y + canvasBox.h);
  }
  const shiftX = canvasBox ? canvasBox.x - x0 : 0;
  const shiftY = canvasBox ? canvasBox.y - y0 : 0;
  canvasBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  stage.style.width = `${canvasBox.w}px`;
  stage.style.height = `${canvasBox.h}px`;
  marks.style.transform = `translate(${-x0}px, ${-y0}px)`;
  if (shiftX || shiftY) window.scrollBy(shiftX, shiftY);
}

// ---- Points ----

/** A layout-viewport point (clientX/Y) as a page point (canonical px). */
function pagePoint(cx, cy) {
  if (card.kind === 'canvas') {
    const r = stage.getBoundingClientRect();
    return { x: cx - r.left + canvasBox.x, y: cy - r.top + canvasBox.y };
  }
  const r = page.getBoundingClientRect();
  return { x: cx - r.left + (slot?.layout?.scrollX ?? 0), y: cy - r.top + scrollY };
}

/** The middle of what the phone shows now, as a page point. */
function viewCenter() {
  const vv = window.visualViewport;
  const p = pagePoint(vv ? vv.offsetLeft + vv.width / 2 : window.innerWidth / 2, vv ? vv.offsetTop + vv.height / 2 : window.innerHeight / 2);
  if (card.kind !== 'canvas') p.x = Math.max(0, Math.min(CANONICAL_WIDTH, p.x));
  return p;
}

// ---- Mark up: a tap pins a comment, a long press places a sticky; on an artifact a drag scrolls it ----

function press(e, target, scrolls) {
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (mode !== 'markup' && !picking) return;
  if (scrolls) {
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
  }
  const start = { x: e.clientX, y: e.clientY };
  const startScroll = scrollY;
  const at = pagePoint(e.clientX, e.clientY);
  let moved = false;
  let held = false;
  let done = false;
  const hold = picking
    ? 0
    : setTimeout(() => {
        if (moved || done) return;
        held = true;
        placeSticky(at);
      }, HOLD_MS);
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < slop()) return;
    moved = true;
    clearTimeout(hold);
    if (scrolls) scrollFrame(startScroll - (ev.clientY - start.y));
  };
  const end = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    done = true;
    clearTimeout(hold);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    if (ev.type === 'pointercancel' || moved || held) return;
    if (picking) pickAt(at);
    else if (mode === 'markup') comment(at);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

// A long press is the board's (a sticky), never the WebView's text selection or menu.
document.addEventListener('contextmenu', (e) => e.preventDefault());

async function comment(at) {
  draft = { x: Math.round(at.x), y: Math.round(at.y) };
  drawDraft();
  send({ t: 'comment', anchor: await anchorAt(at) });
}

async function placeSticky(at) {
  const anchor = await anchorAt(at);
  const id = randomId('s');
  apply([{ op: 'sticky.add', card: card.id, id, anchor, box: { x: 0, y: 0, ...STICKY_SIZE }, text: '', color: 'yellow' }], 'Adding the sticky');
  renderMarks();
  send({ t: 'sticky', id });
}

async function addPicture(file, w, ht) {
  const size = pictureSize({ w, h: ht });
  const c = viewCenter();
  const anchor = await anchorAt({ x: c.x - size.w / 2, y: c.y - size.h / 2 });
  apply([{ op: 'picture.add', card: card.id, id: randomId('p'), file: { hash: file.hash, size: file.size ?? 0, mime: file.mime ?? '' }, anchor, box: { x: 0, y: 0, ...size } }], 'Adding the picture');
  renderMarks();
}

// ---- Reattaching a mark ----

function startPicking(kind, id) {
  picking = { kind, id };
  root.classList.add('picking');
  showBanner(`Tap the new spot for this ${kind === 'thread' ? 'comment' : kind}.`, button('Cancel', stopPicking));
}

function stopPicking() {
  picking = null;
  root.classList.remove('picking');
  hideBanner();
}

async function pickAt(p) {
  const pick = picking;
  if (!pick) return;
  stopPicking();
  const anchor = await anchorAt(p);
  const mark = findMark(card, pick.kind, pick.id);
  if (!mark) return;
  sentResolve.delete(pick.id);
  located.delete(pick.id);
  apply(reattachMarkOps({ card: card.id, kind: pick.kind, id: pick.id, anchor, box: mark.box }), 'Reattaching');
  renderMarks();
  scheduleLocate();
}

// ---- Focusing a mark ----

function focusMark(id) {
  const kind = kindOf(card, id);
  if (!kind) return;
  const mark = findMark(card, kind, id);
  selected = id;
  const p = markPoint(mark);
  const box = kind === 'thread' ? { x: 0, y: 0, w: 1, h: 1 } : mark.box;
  const cx = p.x + box.x + box.w / 2;
  const cy = p.y + box.y + box.h / 2;
  const vw = window.visualViewport?.width ?? window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  if (card.kind === 'canvas') window.scrollTo({ left: cx - canvasBox.x - vw / 2, top: cy - canvasBox.y - vh / 2, behavior: 'smooth' });
  else {
    if (cy < scrollY || cy > scrollY + viewH) scrollFrame(Math.max(0, cy - viewH / 3));
    // Zoomed in, the phone shows part of the page: bring that part to the mark too.
    if (vw < CANONICAL_WIDTH - 1) window.scrollTo({ left: cx - vw / 2, top: Math.max(0, cy - scrollY - vh / 2), behavior: 'smooth' });
  }
  flashId = id;
  renderMarks();
  setTimeout(() => {
    if (flashId === id) flashId = null;
    renderMarks();
  }, 1400);
}

// ---- Drawing ----

/** Draws every mark, reusing elements by id so a drag in progress isn't thrown away. */
function renderMarks() {
  if (!card || !marks) return;
  const keep = new Set();
  for (const p of card.pictures) {
    keep.add(p.id);
    drawPicture(p);
  }
  for (const s of card.stickies) {
    keep.add(s.id);
    drawSticky(s);
  }
  card.threads.forEach((t, i) => {
    keep.add(t.id);
    drawPin(t, i + 1);
  });
  for (const [id, el] of markEls) {
    if (keep.has(id)) continue;
    el.remove();
    markEls.delete(id);
  }
  drawDraft();
  if (card.kind === 'canvas') layoutCanvas();
}

function flags(el, mark, resolved = false) {
  el.classList.toggle('resolved', resolved);
  el.classList.toggle('detached', isDetached(mark));
  el.classList.toggle('changed', changed.has(mark.id));
  el.classList.toggle('on', selected === mark.id);
  el.classList.toggle('flash', flashId === mark.id);
}

function drawPin(t, n) {
  let el = markEls.get(t.id);
  if (!el) {
    el = button('', (e) => {
      e.stopPropagation();
      selected = t.id;
      renderMarks();
      send({ t: 'thread', id: t.id });
    });
    el.className = 'pin';
    el.dataset.mark = t.id;
    marks.append(el);
    markEls.set(t.id, el);
  }
  const p = markPoint(t);
  place(el, p.x, p.y);
  el.textContent = String(n);
  const first = t.messages?.[0];
  el.setAttribute('aria-label', `Comment ${n}${first ? `, ${authorName(first.author)}: ${first.text}` : ''}`);
  el.style.setProperty('--who', first ? authorColor(first.author) : '#eee');
  flags(el, t, !!t.resolved);
}

function drawDraft() {
  if (!marks) return;
  if (!draft) {
    draftEl?.remove();
    draftEl = null;
    return;
  }
  if (!draftEl) {
    draftEl = h('div', 'pin draft', '+');
    draftEl.setAttribute('aria-hidden', 'true');
  }
  place(draftEl, draft.x, draft.y);
  marks.append(draftEl);
}

function drawSticky(s) {
  let el = markEls.get(s.id);
  if (!el) {
    el = h('div', 'sticky');
    el.dataset.mark = s.id;
    const bar = h('div', 'sticky-bar');
    bar.append(h('span', 'dot'), h('span', 'who'));
    const grip = h('div', 'resize');
    el.append(bar, h('div', 'sticky-text'), grip);
    dragMark(el, el, 'sticky', s.id, 'move');
    dragMark(grip, el, 'sticky', s.id, 'resize');
    marks.append(el);
    markEls.set(s.id, el);
  }
  if (el.classList.contains('dragging')) return;
  const p = markPoint(s);
  place(el, p.x + s.box.x, p.y + s.box.y, s.box.w, s.box.h);
  el.style.setProperty('--sticky', STICKY_COLORS[s.color] ?? STICKY_COLORS.yellow);
  const text = el.querySelector('.sticky-text');
  text.textContent = s.text ?? '';
  text.classList.toggle('blank', !s.text);
  const author = s.stamps?.text?.author;
  el.querySelector('.dot').style.background = authorColor(author);
  el.querySelector('.who').textContent = authorName(author);
  el.setAttribute('aria-label', `Sticky note: ${s.text || 'empty'}`);
  flags(el, s);
}

function drawPicture(p) {
  let el = markEls.get(p.id);
  if (!el) {
    el = h('div', 'picture');
    el.dataset.mark = p.id;
    const img = h('img');
    img.alt = 'Picture';
    img.draggable = false;
    const del = button('✕', (e) => {
      e.stopPropagation();
      apply([{ op: 'picture.rm', card: card.id, id: p.id }], 'Deleting the picture');
      renderMarks();
    });
    del.className = 'mark-x';
    del.setAttribute('aria-label', 'Delete the picture');
    const grip = h('div', 'resize');
    el.append(img, del, grip);
    dragMark(el, el, 'picture', p.id, 'move');
    dragMark(grip, el, 'picture', p.id, 'resize');
    marks.append(el);
    markEls.set(p.id, el);
  }
  if (el.classList.contains('dragging')) return;
  const img = el.querySelector('img');
  const src = /^[0-9a-f]{64}$/.test(p.file?.hash ?? '') && secret ? `/file/${secret}/${p.file.hash}` : '';
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  const at = markPoint(p);
  place(el, at.x + p.box.x, at.y + p.box.y, p.box.w, p.box.h);
  el.setAttribute('aria-label', `Picture from ${authorName(p.stamps?.file?.author)}`);
  flags(el, p);
}

/** Moving or resizing a sticky or picture with a finger; it's sent when the finger lifts. A tap on a sticky opens it. */
function dragMark(handle, el, kind, id, what) {
  handle.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest('button') || (what === 'move' && e.target.classList.contains('resize'))) return;
    e.stopPropagation();
    const mark = findMark(card, kind, id);
    if (!mark) return;
    const start = { x: e.clientX, y: e.clientY };
    const box = { ...mark.box };
    const origin = markPoint(mark);
    let moved = false;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < slop()) return;
      moved = true;
      el.classList.add('dragging');
      const next = dragPreview(origin, box, ev.clientX - start.x, ev.clientY - start.y, what);
      place(el, next.x, next.y, next.w, next.h);
    };
    const end = async (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      if (!moved || ev.type === 'pointercancel') {
        el.classList.remove('dragging');
        if (ev.type === 'pointercancel') renderMarks();
        else if (kind === 'sticky' && !picking) {
          selected = id;
          renderMarks();
          send({ t: 'sticky', id });
        }
        return;
      }
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      // On an artifact a moved mark is anchored again where it was dropped, so it follows that element.
      const anchor = what === 'move' && card.kind !== 'canvas' && mark.anchor.kind !== 'point' ? await anchorAt(dragPreview(origin, box, dx, dy, 'move')) : undefined;
      if (anchor) located.delete(id);
      apply(dragMarkOps({ card: card.id, kind, id, what, box, dx, dy, anchor }), what === 'move' ? `Moving the ${kind}` : `Resizing the ${kind}`);
      el.classList.remove('dragging');
      renderMarks();
      scheduleLocate();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

// ---- Placeholder and banner ----

function showPlaceholder(text) {
  placeholder.replaceChildren(h('div', 'spinner'), h('span', '', text));
  placeholder.classList.remove('hidden');
}

function hidePlaceholder() {
  placeholder.classList.add('hidden');
}

function showBanner(text, extra) {
  banner.replaceChildren(h('span', '', text), extra);
  banner.classList.remove('hidden');
}

function hideBanner() {
  // While a reload waits for the owner to stop typing, its banner stays up.
  if (reloadWait) return showReloadBanner();
  banner.classList.add('hidden');
}

window.board = { receive };
applyZoom();
send({ t: 'ready' });
