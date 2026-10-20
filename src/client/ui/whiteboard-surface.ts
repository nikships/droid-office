// The Whiteboard window's card surface (docs/whiteboard.md, "The window" and "Isolation"): an html
// card in its sandboxed frame, laid out at CANONICAL_WIDTH and shown at Fit, 100% or a zoom, or a
// canvas card's blank pannable surface, with the card's comment pins, stickies and pictures on top.
//
// The frame is CANONICAL_WIDTH wide and as tall as the surface at the zoom, and scrolls itself; the
// marks layer sits over it in page coordinates, moved by the frame's scroll from its `layout`
// messages. Each load gets a fresh nonce in the frame URL (#wb=), and a message counts only when it
// comes from that frame's contentWindow with that nonce: its writes and actions apply to this card.
// Full screen promotes this element to the top layer, fits the card to that size, and puts the zoom
// and scroll back on the way out. The wall keeps the view from before, not the temporary fit.

import type { WhiteboardRenderInfo } from '../../shared/protocol';
import { CARD_FRAME, actionOp, parseFrameMsg, wrap, writeOp, type BridgeMode, type FocusedField, type FrameMsg, type HostMsg } from '../../shared/whiteboard-bridge';
import {
  CANONICAL_WIDTH,
  MAX_ASSET_BYTES,
  OWNER_AUTHOR,
  PICTURE_MIMES,
  STICKY_COLORS,
  STICKY_SIZE,
  applyOps,
  emptyBoard,
  findCard,
  jsonEqual,
  parseStatePathKey,
  type Anchor,
  type Author,
  type Card,
  type CardView,
  type FileRef,
  type Op,
  type Picture,
  type Point,
  type StateObject,
  type Sticky,
  type StickyColor,
  type Thread,
} from '../../shared/whiteboard';
import { canvasBounds, dragBox, dragMarkOps, dragPreview, pictureSize, reattachMarkOps } from '../../shared/whiteboard-marks';
import { withToken } from '../token';
import { claimEscape, h } from './dom';
import { colorDot } from './kit';
import {
  CANVAS_MARGIN,
  type ArtifactView,
  type CanvasView,
  type Size,
  type ZoomMode,
  artifactCardView,
  artifactFromCardView,
  artifactLayout,
  authorColor,
  authorName,
  canvasCardView,
  canvasFit,
  canvasFromCardView,
  clampZoom,
  fitZoom,
  newId,
  stepZoom,
  wheelNavigation,
  zoomArtifact,
  zoomCanvas,
} from './whiteboard-view';

export type MarkKind = 'thread' | 'sticky' | 'picture';
export type Mode = BridgeMode;

export interface SurfaceHost {
  floor: string;
  /** Applies the owner's batch (the window shows what went wrong). */
  apply(ops: Op[], what?: string): Promise<boolean>;
  /** Says something went wrong that isn't a batch: an upload, a file that isn't a picture. */
  notify(text: string): void;
  /** The card recorded a press of one of its actions (a `data-wb-action` button or `whiteboard.action`). */
  acted(name: string): void;
  /** The frame URL for a load with this nonce; undefined until the card's capability is known. */
  cardUrl(nonce: string): string | undefined;
  /** A card file's URL (a picture), by hash. */
  fileUrl(hash: string): string;
  /** Whether batches reach the office now (marks.resolve waits until they do). */
  live(): boolean;
  /** A comment pin was clicked, or a new thread was made. */
  selectMark(kind: MarkKind, id: string): void;
  /** The view, zoom or mode changed: the toolbar repaints. */
  changed(): void;
  /** The frame placed the marks again: the panel's detached list repaints. */
  located(): void;
  /** The region the owner looks at, settled, for `card.view`. */
  view(view: CardView): void;
  /** Marks someone else changed since the owner last looked, to highlight. */
  changedMarks(): Set<string>;
  /** The latest render, for a placeholder while the frame loads. */
  render(): WhiteboardRenderInfo | undefined;
}

interface Slot {
  iframe: HTMLIFrameElement;
  nonce: string;
  contentRev: number;
  ready: boolean;
  layout?: { width: number; height: number; scrollX: number; scrollY: number; seq?: number };
  scrollSeq?: number;
  restore?: Point;
  loadedAt: number;
  /** What has focus in the frame, as it last said. */
  focus?: FocusedField | null;
  /** When the owner last typed (or composed) in it: the unsaved value or the composition changed. */
  typedAt: number;
  /** Focus to put back once the frame is ready, when it was swapped in before it was. */
  sendFocus?: FocusedField;
}

interface Located {
  point: Point;
  detached: boolean;
  /** The anchor it was located for: a changed anchor shows at its own point until it's located again. */
  key: string;
}

type Saved = { fit: boolean; zoom: number; a?: number; b?: number };

const VIEW_KEY = 'droid-office.wb-view';
/** The pause in typing a content reload waits for: the SDK saves a field after the same second. */
const TYPING_IDLE_MS = 1000;
const LOCATE_DEBOUNCE_MS = 150;
const RESOLVE_SETTLE_MS = 800;
const VIEW_DEBOUNCE_MS = 900;
const DRAG_PX = 5;

/** A random nonce for one load of a frame, in the alphabet `nonceFromHash` takes. */
function makeNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadSaved(floor: string, card: string): Saved | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}');
    const v = all?.[`${floor}/${card}`];
    return v && typeof v.zoom === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

function save(floor: string, card: string, v: Saved) {
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') ?? {};
    all[`${floor}/${card}`] = v;
    // Only the most recent cards: the rest go.
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
    localStorage.setItem(VIEW_KEY, JSON.stringify(all));
  } catch {
    // Storage full or off: the view is only remembered for this page.
  }
}

/** Uploads a file the board will hold (a picture, a page, an asset) and answers with its FileRef. */
export async function uploadBlob(floor: string, body: Blob, mime: string): Promise<FileRef> {
  const q = new URLSearchParams({ floor, mime });
  const r = await fetch(withToken(`/api/whiteboard/blob?${q}`), { method: 'POST', headers: { 'content-type': mime }, body });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error ?? `The upload failed (HTTP ${r.status})`);
  return j as FileRef;
}

function imageSize(file: Blob): Promise<Size> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth || 320, h: img.naturalHeight || 240 });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ w: 320, h: 240 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

const anchorKey = (a: Anchor) => JSON.stringify(a);

export class Surface {
  readonly el: HTMLElement;
  card: Card;
  mode: Mode = 'use';
  zoomMode: ZoomMode = { fit: true };
  pan = false;
  private spacePan = false;
  private framePan: Point | null = null;
  private navigationFrame = 0;
  private navigation: { at: Point; x: number; y: number; factor: number }[] = [];
  private host: SurfaceHost;
  private stage = h('div.wb-stage');
  private page = h('div.wb-page');
  private marks = h('div.wb-marks');
  private catcher = h('div.wb-catcher');
  private banner = h('div.wb-banner.hidden');
  private placeholder = h('div.wb-placeholder.hidden');
  private viewport: Size = { w: 800, h: 600 };
  private art: ArtifactView = { zoom: 1, panX: 0, scrollY: 0 };
  private canvas: CanvasView = { zoom: 1, x: 0, y: 0 };
  private slot: Slot | null = null;
  private incoming: Slot | null = null;
  /** The card's state as the frame has it: what it was given plus its own writes. */
  private frameState: StateObject = {};
  private located = new Map<string, Located>();
  private reqs = new Map<number, (msg: FrameMsg) => void>();
  private reqSeq = 0;
  private locateTimer = 0;
  private resolveTimer = 0;
  private viewTimer = 0;
  private reloadWait: { poll: number } | null = null;
  private picking: { kind: MarkKind; id: string; release: () => void } | null = null;
  private composer: { el: HTMLElement; release: () => void } | null = null;
  private editing: { id: string; release: () => void } | null = null;
  private selected: string | null = null;
  private flashId: string | null = null;
  private sentResolve = new Map<string, boolean>();
  private markEls = new Map<string, HTMLElement>();
  private disposed = false;
  private ro: ResizeObserver;
  private offs: (() => void)[] = [];
  /** Zoom and scroll from before full screen, and the box they were laid out in. */
  private fsHold: { mode: ZoomMode; art: ArtifactView; canvas: CanvasView; viewport: Size } | null = null;
  private fsSeq = 0;
  private fsPending = false;
  /** Set when we asked to leave, so the Esc the browser already used isn't swallowed twice. */
  private leavingFs = false;
  /** Something inside the card (its own video) is full screen above it. */
  private nestedFs = false;
  /** The frame forwards Esc after the browser has already left full screen. Swallow that one. */
  private swallowEsc = false;
  private swallowTimer = 0;

  constructor(host: SurfaceHost, card: Card) {
    this.host = host;
    this.card = card;
    this.frameState = card.state;
    this.el = h(
      'div.wb-surface',
      { class: card.kind === 'canvas' ? 'canvas' : 'html', tabindex: '-1', 'aria-label': 'Whiteboard viewport' },
      this.stage,
      this.banner,
      this.placeholder,
      h('div.wb-navigation-hint', {}, 'Pinch to zoom', h('span', {}, '·'), 'Two fingers to pan', h('span', {}, '·'), h('span.key', {}, 'Space'), ' + drag'),
      h('button.btn.sm.wb-fs-exit', { type: 'button', title: 'Exit full screen', onclick: () => this.leaveFullscreen() }, 'Exit full screen', h('span.key', {}, 'Esc')),
    );
    if (card.kind === 'canvas') this.stage.append(this.marks);
    else {
      this.page.append(this.catcher, this.marks);
      this.stage.append(this.page);
    }
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(this.el);
    const onMsg = (e: MessageEvent) => this.onMessage(e);
    window.addEventListener('message', onMsg);
    this.offs.push(() => window.removeEventListener('message', onMsg));
    this.wire();
    const onFs = () => this.onFullscreenChange();
    document.addEventListener('fullscreenchange', onFs);
    this.offs.push(() => document.removeEventListener('fullscreenchange', onFs));
    this.offs.push(
      claimEscape(this.el, () => {
        if (document.fullscreenElement === this.el) {
          this.leaveFullscreen();
          return true;
        }
        // Esc inside the page makes the browser leave full screen before the frame can forward the key.
        if (this.swallowEsc) {
          this.swallowEsc = false;
          clearTimeout(this.swallowTimer);
          return true;
        }
        return false;
      }),
    );
    this.measure(true);
    if (card.kind === 'html') this.load();
    this.renderMarks();
  }

  dispose() {
    this.flushNavigation();
    cancelAnimationFrame(this.navigationFrame);
    // Closing the window (Esc in the frame, ✕, another card) removes the frame before its idle save: keep what was typed.
    this.saveTyped(this.slot?.focus);
    this.disposed = true;
    this.incoming = null;
    this.ro.disconnect();
    for (const off of this.offs) off();
    clearTimeout(this.locateTimer);
    clearTimeout(this.resolveTimer);
    if (this.viewTimer) {
      clearTimeout(this.viewTimer);
      this.emitView();
    }
    const exitFs = document.fullscreenElement === this.el;
    this.fsHold = null;
    this.fsSeq++;
    clearTimeout(this.swallowTimer);
    if (exitFs) void document.exitFullscreen();
    if (this.reloadWait) clearInterval(this.reloadWait.poll);
    this.picking?.release();
    this.composer?.release();
    this.editing?.release();
  }

  // ---- What the toolbar reads and does ----

  get zoom(): number {
    return this.card.kind === 'canvas' ? this.canvas.zoom : this.art.zoom;
  }

  /** A mark the frame couldn't place now (or the board says so, before the frame has looked). */
  detached(kind: MarkKind, id: string): boolean {
    const l = this.located.get(id);
    const mark = this.findMark(kind, id);
    if (!mark) return false;
    if (l && l.key === anchorKey(mark.anchor)) return l.detached;
    return !!mark.detached;
  }

  setMode(mode: Mode) {
    this.setPan(false);
    if (this.mode === mode) return;
    this.mode = mode;
    this.el.classList.toggle('markup', mode === 'markup');
    for (const s of [this.slot, this.incoming]) if (s?.ready) this.post(s, { type: 'mode', mode });
    this.host.changed();
  }

  setPan(pan: boolean) {
    this.pan = pan;
    this.el.classList.toggle('pan-tool', this.pan || this.spacePan);
    this.host.changed();
  }

  private setSpacePan(pressed: boolean) {
    this.spacePan = pressed;
    this.el.classList.toggle('pan-tool', this.pan || this.spacePan);
  }

  fit() {
    this.flushNavigation();
    this.zoomMode = { fit: true };
    if (this.card.kind === 'canvas') this.canvas = canvasFit(canvasBounds(this.card, CANVAS_MARGIN), this.viewport);
    else this.art = { ...this.art, zoom: fitZoom(this.viewport.w), panX: 0 };
    this.applyView(true);
  }

  actual() {
    this.zoomTo(1);
  }

  zoomBy(dir: 1 | -1) {
    this.zoomTo(stepZoom(this.zoom, dir));
  }

  zoomTo(z: number, at?: Point) {
    this.flushNavigation();
    const zoom = clampZoom(z);
    this.zoomMode = { fit: false, zoom };
    const c = at ?? { x: this.viewport.w / 2, y: this.viewport.h / 2 };
    if (this.card.kind === 'canvas') this.canvas = zoomCanvas(this.canvas, zoom, c);
    else this.art = zoomArtifact(this.art, this.viewport, zoom, c);
    this.applyView(true);
    if (this.card.kind === 'html') this.scrollFrame(this.art.scrollY);
  }

  /** Whether this card is the element on the top layer. */
  get fullscreen(): boolean {
    return document.fullscreenElement === this.el;
  }

  /** Fills the screen with this card, or leaves it. The view from before comes back on the way out. */
  async toggleFullscreen(): Promise<void> {
    if (this.fsPending) return;
    if (document.fullscreenElement === this.el) {
      this.leaveFullscreen();
      return;
    }
    if (!this.el.requestFullscreen) {
      this.host.notify('Full screen isn’t available in this browser');
      return;
    }
    this.holdFullscreen();
    this.fsPending = true;
    try {
      await this.el.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      this.fsHold = null;
      this.el.classList.remove('fs');
      this.host.notify('Full screen isn’t available in this browser');
    } finally {
      this.fsPending = false;
    }
  }

  private leaveFullscreen() {
    if (document.fullscreenElement !== this.el) return;
    this.leavingFs = true;
    void document.exitFullscreen();
  }

  private holdFullscreen() {
    if (this.fsHold) return;
    this.fsHold = {
      mode: this.zoomMode.fit ? { fit: true } : { fit: false, zoom: this.zoomMode.zoom },
      art: { zoom: this.art.zoom, panX: this.art.panX, scrollY: this.art.scrollY },
      canvas: { zoom: this.canvas.zoom, x: this.canvas.x, y: this.canvas.y },
      viewport: { w: this.viewport.w, h: this.viewport.h },
    };
  }

  /** Fit once the top layer has a real box, and put the held view back once it doesn't. */
  private onFullscreenChange() {
    const top = document.fullscreenElement;
    // The card's own video going full screen, above the card or not, and coming back from it: the card's view stays as it was.
    if (top && top !== this.el && this.el.contains(top)) {
      this.nestedFs = true;
      return;
    }
    if (this.nestedFs) {
      this.nestedFs = false;
      if ((top === this.el) === this.el.classList.contains('fs')) return;
    }
    const on = top === this.el;
    this.el.classList.toggle('fs', on);
    if (!on && this.fsHold && !this.leavingFs) {
      this.swallowEsc = true;
      clearTimeout(this.swallowTimer);
      this.swallowTimer = window.setTimeout(() => {
        this.swallowEsc = false;
      }, 500);
    }
    this.leavingFs = false;
    const seq = ++this.fsSeq;
    const settle = (attempt: number) => {
      if (this.disposed || seq !== this.fsSeq) return;
      const r = this.el.getBoundingClientRect();
      const held = this.fsHold;
      if (document.fullscreenElement === this.el) {
        if (!held) this.holdFullscreen();
        const base = this.fsHold?.viewport ?? this.viewport;
        const grown = r.width > base.w + 8 || r.height > base.h + 8;
        if ((!grown || r.width < 2) && attempt < 8) {
          requestAnimationFrame(() => settle(attempt + 1));
          return;
        }
        if (r.width > 0 && r.height > 0) this.viewport = { w: Math.max(200, Math.round(r.width)), h: Math.max(160, Math.round(r.height)) };
        this.fit();
        return;
      }
      if (!held) return;
      // Wait until the card is back in the window. Laying the old zoom out at the screen size would clamp the pan.
      if (r.width > held.viewport.w + 48 && attempt < 8) {
        requestAnimationFrame(() => settle(attempt + 1));
        return;
      }
      this.restoreFullscreen();
    };
    requestAnimationFrame(() => settle(0));
  }

  private restoreFullscreen() {
    const held = this.fsHold;
    if (!held) return;
    this.fsHold = null;
    const r = this.el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) this.viewport = { w: Math.max(200, Math.round(r.width)), h: Math.max(160, Math.round(r.height)) };
    else this.viewport = { ...held.viewport };
    this.art = { ...held.art };
    this.canvas = { ...held.canvas };
    this.zoomMode = held.mode.fit ? { fit: true } : { fit: false, zoom: held.mode.zoom };
    if (held.mode.fit) this.fit();
    else this.applyView(true);
    // Fit keeps an artifact's scroll in the model; the frame still has to be told, or a taller full-screen box leaves it where it scrolled.
    if (this.card.kind === 'html') this.scrollFrame(held.art.scrollY);
  }

  /** Brings a mark into view and flashes it. */
  focusMark(kind: MarkKind, id: string) {
    this.flushNavigation();
    const mark = this.findMark(kind, id);
    if (!mark) return;
    this.selected = id;
    const p = this.markPoint(mark);
    const box = kind === 'thread' ? { x: 0, y: 0, w: 1, h: 1 } : (mark as Sticky).box;
    const cx = p.x + box.x + box.w / 2;
    const cy = p.y + box.y + box.h / 2;
    if (this.card.kind === 'canvas') {
      const z = this.canvas.zoom;
      this.canvas = { zoom: z, x: cx - this.viewport.w / z / 2, y: cy - this.viewport.h / z / 2 };
      this.applyView(true);
    } else {
      const z = this.art.zoom;
      const top = Math.max(0, cy - this.viewport.h / z / 3);
      const inView = cy > this.art.scrollY && cy < this.art.scrollY + this.viewport.h / z;
      if (!inView) this.scrollFrame(top);
      const shownW = this.viewport.w / z;
      if (CANONICAL_WIDTH > shownW && (cx < this.art.panX || cx > this.art.panX + shownW)) {
        this.art = { ...this.art, panX: cx - shownW / 2 };
        this.applyView(true);
      }
    }
    this.flashId = id;
    this.renderMarks();
    setTimeout(() => {
      if (this.flashId === id) this.flashId = null;
      this.renderMarks();
    }, 1400);
  }

  /** Waits for the owner to click where a detached (or any) mark goes now. */
  startReattach(kind: MarkKind, id: string) {
    this.picking?.release();
    const release = claimEscape(this.el, () => {
      if (!this.picking) return false;
      this.stopPicking();
      return true;
    });
    this.picking = { kind, id, release };
    this.el.classList.add('picking');
    this.showBanner(`Click the new spot for this ${kind === 'thread' ? 'comment' : kind}.`, [h('span.key', {}, 'Esc'), 'cancels']);
  }

  private stopPicking() {
    this.picking?.release();
    this.picking = null;
    this.el.classList.remove('picking');
    this.hideBanner();
  }

  /** Puts pictures on the card: at `at` (page px), or in the middle of what's in view. */
  async addPictures(files: File[], at?: Point): Promise<void> {
    const ok = files.filter((f) => (PICTURE_MIMES as readonly string[]).includes(f.type));
    if (!ok.length) {
      if (files.length) this.host.notify('A picture must be a PNG, JPEG, WebP or GIF');
      return;
    }
    let spot = at ?? this.viewCenter();
    for (const f of ok) {
      if (f.size > MAX_ASSET_BYTES) {
        this.host.notify(`${f.name} is over ${MAX_ASSET_BYTES / 1024 / 1024} MB, the limit for a picture`);
        continue;
      }
      let file: FileRef;
      try {
        file = await uploadBlob(this.host.floor, f, f.type);
      } catch (err) {
        this.host.notify(`${f.name} couldn't be uploaded: ${(err as Error).message}`);
        continue;
      }
      const size = pictureSize(await imageSize(f));
      const topLeft = at ? spot : { x: spot.x - size.w / 2, y: spot.y - size.h / 2 };
      const anchor = await this.anchorAt(topLeft);
      if (this.disposed) return;
      void this.host.apply([{ op: 'picture.add', card: this.card.id, id: newId('p'), file, anchor, box: { x: 0, y: 0, w: size.w, h: size.h } }], 'Adding the picture');
      spot = { x: spot.x + 24, y: spot.y + 24 };
    }
  }

  // ---- Live updates ----

  /** The card as the board has it now. */
  update(card: Card) {
    const before = this.card;
    this.card = card;
    if (card.kind === 'html') {
      const rev = card.stamps.content?.rev ?? 0;
      if (this.slot && rev !== this.slot.contentRev && (!this.incoming || this.incoming.contentRev !== rev)) this.requestReload();
      else if (!this.slot && !this.incoming) this.load();
      if (!jsonEqual(card.state, this.frameState)) this.pushState(before, card);
    }
    const marksChanged = before.threads !== card.threads || before.stickies !== card.stickies || before.pictures !== card.pictures || before.revs.marks !== card.revs.marks;
    if (marksChanged) {
      this.renderMarks();
      this.scheduleLocate();
    }
    this.host.changed();
  }

  private pushState(before: Card, card: Card) {
    const changes: { path: string[]; author: Author }[] = [];
    for (const [key, stamp] of Object.entries(card.stamps.state)) {
      const was = before.stamps.state[key];
      if (!was || was.rev !== stamp.rev) changes.push({ path: parseStatePathKey(key), author: stamp.author });
    }
    this.frameState = card.state;
    const s = this.slot;
    if (s?.ready) this.post(s, { type: 'state', state: card.state, changes });
  }

  // ---- The frame ----

  private load() {
    const nonce = makeNonce();
    const url = this.host.cardUrl(nonce);
    if (!url) {
      this.showPlaceholder('Waiting for the office to send this card…');
      return;
    }
    const iframe = h('iframe.wb-frame', {
      ...CARD_FRAME,
      title: this.card.title,
      src: url,
    });
    const slot: Slot = { iframe, nonce, contentRev: this.card.stamps.content?.rev ?? 0, ready: false, loadedAt: performance.now(), typedAt: 0 };
    if (!this.slot) {
      this.slot = slot;
      this.showPlaceholder('Loading…');
      slot.restore = { x: 0, y: this.art.scrollY };
    } else {
      this.incoming = slot;
      iframe.classList.add('incoming');
      slot.restore = { x: this.slot.layout?.scrollX ?? 0, y: this.slot.layout?.scrollY ?? this.art.scrollY };
      // A page that never says it's ready still comes in.
      setTimeout(() => this.incoming === slot && this.swapIn(slot), 5000);
    }
    this.frameSize(iframe);
    this.page.insertBefore(iframe, this.catcher);
  }

  /** A content change: reload now, or once the owner stops typing in the frame. */
  private requestReload() {
    if (this.incoming) {
      this.incoming.iframe.remove();
      this.incoming = null;
    }
    if (this.reloadWait) return;
    if (!this.typing()) return this.load();
    // The frame reports what's focused, with any unsaved value: a second without typing (when the SDK saves the field), or focus leaving the frame, is the moment.
    const poll = window.setInterval(() => {
      if (!this.typing()) this.reloadNow();
    }, 200);
    this.reloadWait = { poll };
    this.showBanner('This card changed. It reloads when you stop typing.', [h('button.btn.sm', { type: 'button', onclick: () => this.reloadNow() }, 'Reload now')]);
  }

  private reloadNow() {
    if (this.reloadWait) clearInterval(this.reloadWait.poll);
    this.reloadWait = null;
    this.hideBanner();
    if (!this.disposed) this.load();
  }

  /** The owner is typing in a field of the frame: an IME composition is open, or they typed in the last second and it isn't saved. */
  private typing(): boolean {
    const s = this.slot;
    if (!s || document.activeElement !== s.iframe || !s.focus) return false;
    if (s.focus.composing) return true;
    return s.focus.value !== undefined && performance.now() - s.typedAt < TYPING_IDLE_MS;
  }

  private swapIn(slot: Slot) {
    // Its timers may still fire after the window closed.
    if (this.disposed || this.incoming !== slot) return;
    const old = this.slot;
    const hadFocus = !!old && document.activeElement === old.iframe;
    this.incoming = null;
    this.slot = slot;
    slot.iframe.classList.remove('incoming');
    old?.iframe.remove();
    if (hadFocus) {
      slot.iframe.focus({ preventScroll: true });
      if (old?.focus) this.refocus(slot, old.focus);
    }
    if (slot.layout) this.onLayout(slot, slot.layout);
    this.scheduleLocate();
  }

  /** Writes what the frame says was typed in its focused field and not saved yet (the SDK saves after a second idle, or on blur). */
  private saveTyped(f: FocusedField | null | undefined) {
    if (f?.key === undefined || f.value === undefined) return;
    const fields = this.frameState.fields;
    const saved = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields[f.key] : undefined;
    if (jsonEqual(saved, f.value)) return;
    const op = writeOp(this.card.id, { op: 'set', path: ['fields', f.key], value: f.value });
    this.frameState = this.stateWith(op);
    void this.host.apply([op], 'Saving the form');
  }

  /** Puts focus back where it was in the frame a reload replaced, with anything typed there since it was last saved. */
  private refocus(slot: Slot, f: FocusedField) {
    this.saveTyped(f);
    if (slot.ready) this.post(slot, { type: 'focus', field: f });
    else slot.sendFocus = f;
  }

  private frameSize(iframe: HTMLIFrameElement) {
    const lay = artifactLayout(this.viewport, this.art.zoom, this.art.panX);
    iframe.style.width = `${CANONICAL_WIDTH}px`;
    iframe.style.height = `${lay.frameH}px`;
  }

  private post(slot: Slot, msg: HostMsg) {
    slot.iframe.contentWindow?.postMessage(wrap(msg, slot.nonce), '*');
  }

  private onMessage(e: MessageEvent) {
    const slot = [this.slot, this.incoming].find((s) => s && e.source === s.iframe.contentWindow);
    if (!slot) return;
    const msg = parseFrameMsg(e.data, slot.nonce);
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        slot.ready = true;
        this.post(slot, { type: 'init', card: { id: this.card.id, title: this.card.title, author: this.card.author }, state: this.card.state, rendering: false, mode: this.mode, width: CANONICAL_WIDTH });
        if (slot === this.slot) this.frameState = this.card.state;
        if (slot.sendFocus) {
          this.post(slot, { type: 'focus', field: slot.sendFocus });
          slot.sendFocus = undefined;
        }
        break;
      case 'focus':
        if (msg.field?.value !== slot.focus?.value || msg.field?.composing !== slot.focus?.composing) slot.typedAt = performance.now();
        slot.focus = msg.field;
        break;
      case 'escape':
        // Esc in the frame, as if it had been pressed in the office: the window stack's own handling runs.
        if (slot === this.slot) slot.iframe.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        break;
      case 'wheel': {
        if (slot !== this.slot) break;
        const lay = artifactLayout(this.viewport, this.art.zoom, this.art.panX);
        this.queueNavigation({ x: lay.left + msg.point.x * this.zoom, y: msg.point.y * this.zoom }, msg.dx, msg.dy, msg.deltaMode, msg.shift, msg.zoom);
        break;
      }
      case 'space':
        if (slot === this.slot) this.setSpacePan(msg.pressed);
        break;
      case 'shortcut':
        if (slot !== this.slot || this.el.closest('.backdrop')?.nextElementSibling) break;
        if (msg.key === 'm') this.setMode(this.mode === 'use' ? 'markup' : 'use');
        else if (msg.key === 'h') this.setPan(!this.pan);
        else if (msg.key === 'f') void this.toggleFullscreen();
        else if (msg.key === '0') this.fit();
        else if (msg.key === '1') this.actual();
        else this.zoomBy(msg.key === '+' ? 1 : -1);
        break;
      case 'pan':
        if (slot !== this.slot) break;
        if (msg.phase === 'start') {
          this.flushNavigation();
          this.framePan = msg.point;
          this.el.classList.add('panning');
        } else if (this.framePan) {
          this.panBy(this.framePan.x - msg.point.x, this.framePan.y - msg.point.y);
          this.framePan = msg.phase === 'end' ? null : msg.point;
          this.el.classList.toggle('panning', msg.phase !== 'end');
        }
        break;
      case 'layout': {
        const first = !slot.layout;
        slot.layout = { width: msg.width, height: msg.height, scrollX: msg.scrollX, scrollY: msg.scrollY, seq: msg.seq };
        if (first && slot.restore && (slot.restore.y > 0 || slot.restore.x > 0)) this.post(slot, { type: 'scrollTo', x: slot.restore.x, y: slot.restore.y });
        if (slot === this.incoming) {
          if (first) {
            // The old content stays up until the new one has its scroll back.
            this.frameState = this.card.state;
            setTimeout(() => this.swapIn(slot), 120);
          }
          break;
        }
        if (first) this.hidePlaceholder();
        this.onLayout(slot, slot.layout, first);
        break;
      }
      case 'write':
        if (slot !== this.slot) break;
        this.frameState = this.stateWith(writeOp(this.card.id, msg.write));
        this.host.apply([writeOp(this.card.id, msg.write)], 'Saving the form');
        break;
      case 'action':
        if (slot !== this.slot) break;
        this.frameState = this.stateWith(actionOp(this.card.id, msg.name, msg.data));
        void this.host.apply([actionOp(this.card.id, msg.name, msg.data)], 'Recording the action').then((ok) => ok && !this.disposed && this.host.acted(msg.name));
        break;
      case 'anchor':
      case 'positions': {
        const done = this.reqs.get(msg.req);
        if (done) {
          this.reqs.delete(msg.req);
          done(msg);
        }
        break;
      }
    }
  }

  /** The frame's state after one of its own writes, as the board will have it. */
  private stateWith(op: Op): StateObject {
    const card = { ...this.card, state: this.frameState };
    const r = applyOps({ ...emptyBoard(), cards: [card] }, [op], OWNER_AUTHOR, 1, Date.now());
    return r.ok ? (findCard(r.board, this.card.id)?.state ?? this.frameState) : this.frameState;
  }

  private lastSize = { w: 0, h: 0 };

  private onLayout(slot: Slot, l: NonNullable<Slot['layout']>, first = false) {
    // A resize or an earlier scroll acknowledgement must not rewind an in-flight gesture.
    if ((l.seq ?? 0) >= (slot.scrollSeq ?? 0)) this.art = { ...this.art, scrollY: l.scrollY };
    this.positionMarks();
    if (first || l.width !== this.lastSize.w || l.height !== this.lastSize.h) {
      this.lastSize = { w: l.width, h: l.height };
      this.scheduleLocate();
    }
    if (slot === this.slot) this.scheduleView();
  }

  private scrollFrame(y: number) {
    const s = this.slot;
    if (!s) return;
    const maxY = Math.max(0, (s.layout?.height ?? 0) - artifactLayout(this.viewport, this.art.zoom, this.art.panX).frameH);
    const ny = Math.max(0, Math.min(maxY, y));
    this.art = { ...this.art, scrollY: ny };
    if (s.ready) {
      s.scrollSeq = (s.scrollSeq ?? 0) + 1;
      this.post(s, { type: 'scrollTo', x: 0, y: ny, seq: s.scrollSeq });
    }
    this.positionMarks();
    this.scheduleView();
  }

  /** Which anchor a page point lands on: the frame's answer on an artifact, the point itself on a canvas. */
  anchorAt(p: Point): Promise<Anchor> {
    const point = { x: Math.round(p.x), y: Math.round(p.y) };
    const fallback: Anchor = { kind: 'point', point };
    const s = this.slot;
    if (this.card.kind === 'canvas' || !s?.ready) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      const req = ++this.reqSeq;
      const timer = setTimeout(() => {
        this.reqs.delete(req);
        resolve(fallback);
      }, 1500);
      this.reqs.set(req, (msg) => {
        clearTimeout(timer);
        resolve(msg.type === 'anchor' && msg.anchor ? msg.anchor : fallback);
      });
      this.post(s, { type: 'anchorAt', req, point });
    });
  }

  // ---- Locating marks ----

  private allMarks(): { kind: MarkKind; mark: Thread | Sticky | Picture }[] {
    return [...this.card.threads.map((mark) => ({ kind: 'thread' as const, mark })), ...this.card.stickies.map((mark) => ({ kind: 'sticky' as const, mark })), ...this.card.pictures.map((mark) => ({ kind: 'picture' as const, mark }))];
  }

  private findMark(kind: MarkKind, id: string): Thread | Sticky | Picture | undefined {
    const list: (Thread | Sticky | Picture)[] = kind === 'thread' ? this.card.threads : kind === 'sticky' ? this.card.stickies : this.card.pictures;
    return list.find((m) => m.id === id);
  }

  private scheduleLocate() {
    clearTimeout(this.locateTimer);
    this.locateTimer = window.setTimeout(() => void this.locate(), LOCATE_DEBOUNCE_MS);
  }

  private async locate() {
    const s = this.slot;
    if (this.disposed || this.card.kind === 'canvas' || !s?.ready || !s.layout) return;
    const items = this.allMarks().map(({ mark }) => ({ id: mark.id, anchor: mark.anchor }));
    if (!items.length) return;
    const keys = new Map(items.map((i) => [i.id, anchorKey(i.anchor)]));
    const req = ++this.reqSeq;
    const msg = await new Promise<FrameMsg | null>((resolve) => {
      const timer = setTimeout(() => {
        this.reqs.delete(req);
        resolve(null);
      }, 2000);
      this.reqs.set(req, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.post(s, { type: 'locate', req, anchors: items });
    });
    if (msg?.type !== 'positions' || this.disposed || s !== this.slot) return;
    for (const p of msg.positions) {
      const key = keys.get(p.id);
      if (key) this.located.set(p.id, { point: p.point ?? this.located.get(p.id)?.point ?? { x: 0, y: 0 }, detached: p.detached || !p.point, key });
    }
    this.renderMarks();
    this.host.located();
    // The verdict goes on the board once the page has settled, so a page still loading doesn't flap it.
    clearTimeout(this.resolveTimer);
    const wait = Math.max(0, RESOLVE_SETTLE_MS - (performance.now() - s.loadedAt));
    this.resolveTimer = window.setTimeout(() => this.resolve(), wait + 200);
  }

  /** Tells the board which marks are detached now, and which are back. */
  private resolve() {
    if (this.disposed || !this.host.live()) return;
    const marks: { id: string; detached: boolean }[] = [];
    for (const { mark } of this.allMarks()) {
      const l = this.located.get(mark.id);
      if (!l || l.key !== anchorKey(mark.anchor)) continue;
      if (l.detached === !!mark.detached || this.sentResolve.get(mark.id) === l.detached) continue;
      marks.push({ id: mark.id, detached: l.detached });
    }
    if (!marks.length) return;
    for (const m of marks) this.sentResolve.set(m.id, m.detached);
    void this.host.apply([{ op: 'marks.resolve', card: this.card.id, marks }]).then(() => {
      for (const m of marks) this.sentResolve.delete(m.id);
    });
  }

  /** Where a mark's anchor is on the page now (canonical px). */
  private markPoint(mark: Thread | Sticky | Picture): Point {
    if (mark.anchor.kind === 'point' || this.card.kind === 'canvas') return mark.anchor.point;
    const l = this.located.get(mark.id);
    return l && l.key === anchorKey(mark.anchor) && !l.detached ? l.point : mark.anchor.point;
  }

  // ---- Drawing ----

  private measure(initial = false) {
    const r = this.el.getBoundingClientRect();
    const next = { w: Math.max(200, Math.round(r.width)), h: Math.max(160, Math.round(r.height)) };
    const same = next.w === this.viewport.w && next.h === this.viewport.h;
    this.viewport = next;
    if (initial || this.firstMeasure) {
      if (r.width > 0) this.firstMeasure = false;
      this.restoreView();
      return;
    }
    if (same) return;
    // Leaving full screen: the held view is put back once the box has shrunk. A layout at the screen size would zero the pan.
    if (this.fsHold && document.fullscreenElement !== this.el) return;
    if (this.zoomMode.fit) this.fit();
    else this.applyView(false);
  }

  private firstMeasure = true;

  /** The view to open at: what this page remembers, else the region the board says, else Fit at the top. */
  private restoreView() {
    const saved = loadSaved(this.host.floor, this.card.id);
    const cv = this.card.view;
    if (this.card.kind === 'canvas') {
      if (saved) {
        this.zoomMode = saved.fit ? { fit: true } : { fit: false, zoom: saved.zoom };
        this.canvas = saved.fit ? canvasFit(canvasBounds(this.card, CANVAS_MARGIN), this.viewport) : { zoom: clampZoom(saved.zoom), x: saved.a ?? 0, y: saved.b ?? 0 };
      } else if (cv) {
        this.canvas = canvasFromCardView(this.viewport, cv);
        this.zoomMode = { fit: false, zoom: this.canvas.zoom };
      } else {
        this.zoomMode = { fit: true };
        this.canvas = canvasFit(canvasBounds(this.card, CANVAS_MARGIN), this.viewport);
      }
    } else if (saved) {
      this.zoomMode = saved.fit ? { fit: true } : { fit: false, zoom: saved.zoom };
      this.art = { zoom: saved.fit ? fitZoom(this.viewport.w) : clampZoom(saved.zoom), panX: saved.a ?? 0, scrollY: saved.b ?? 0 };
    } else if (cv) {
      const r = artifactFromCardView(this.viewport, cv);
      this.zoomMode = r.mode;
      this.art = r.view;
    } else {
      this.zoomMode = { fit: true };
      this.art = { zoom: fitZoom(this.viewport.w), panX: 0, scrollY: 0 };
    }
    if (this.slot && !this.slot.layout) this.slot.restore = { x: 0, y: this.art.scrollY };
    this.applyView(false);
  }

  /** Lays the stage out for the view, and says so. */
  private applyView(moved: boolean) {
    if (this.card.kind === 'canvas') {
      const { zoom, x, y } = this.canvas;
      this.stage.style.transform = `translate(${-x * zoom}px, ${-y * zoom}px) scale(${zoom})`;
      const grid = 24 * zoom;
      this.el.style.backgroundSize = `${grid}px ${grid}px`;
      this.el.style.backgroundPosition = `${-x * zoom}px ${-y * zoom}px`;
    } else {
      const lay = artifactLayout(this.viewport, this.art.zoom, this.art.panX);
      this.art = { ...this.art, panX: lay.panX };
      this.stage.style.transform = `translate(${lay.left}px, 0) scale(${this.art.zoom})`;
      this.page.style.width = `${CANONICAL_WIDTH}px`;
      this.page.style.height = `${lay.frameH}px`;
      for (const s of [this.slot, this.incoming]) if (s) this.frameSize(s.iframe);
      this.positionMarks();
    }
    this.el.style.setProperty('--wb-zoom', String(this.zoom));
    this.el.style.setProperty('--wb-unzoom', String(1 / this.zoom));
    if (moved) this.scheduleView();
    this.host.changed();
  }

  private positionMarks() {
    if (this.card.kind === 'canvas') return;
    const l = this.slot?.layout;
    this.marks.style.transform = `translate(${-(l?.scrollX ?? 0)}px, ${-this.art.scrollY}px)`;
  }

  private scheduleView() {
    clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => this.emitView(), VIEW_DEBOUNCE_MS);
  }

  private emitView() {
    this.viewTimer = 0;
    // Full screen is temporary. The wall and the remembered view stay what they were before it.
    const held = this.fsHold;
    const fit = held ? held.mode.fit : this.zoomMode.fit;
    if (this.card.kind === 'canvas') {
      const view = held ? held.canvas : this.canvas;
      const viewport = held ? held.viewport : this.viewport;
      save(this.host.floor, this.card.id, { fit, zoom: view.zoom, a: Math.round(view.x), b: Math.round(view.y) });
      this.host.view(canvasCardView(viewport, view));
    } else {
      const view = held ? held.art : this.art;
      const viewport = held ? held.viewport : this.viewport;
      save(this.host.floor, this.card.id, { fit, zoom: view.zoom, a: Math.round(view.panX), b: Math.round(view.scrollY) });
      this.host.view(artifactCardView(viewport, view, this.slot?.layout?.height));
    }
  }

  private viewCenter(): Point {
    if (this.card.kind === 'canvas') return { x: this.canvas.x + this.viewport.w / this.canvas.zoom / 2, y: this.canvas.y + this.viewport.h / this.canvas.zoom / 2 };
    const lay = artifactLayout(this.viewport, this.art.zoom, this.art.panX);
    return { x: Math.min(CANONICAL_WIDTH / 2, this.art.panX + this.viewport.w / this.art.zoom / 2), y: this.art.scrollY + lay.frameH / 2 };
  }

  /** A pointer event's page point (canonical px). */
  private pagePoint(e: { clientX: number; clientY: number }): Point {
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (this.card.kind === 'canvas') return { x: this.canvas.x + sx / this.canvas.zoom, y: this.canvas.y + sy / this.canvas.zoom };
    const lay = artifactLayout(this.viewport, this.art.zoom, this.art.panX);
    return { x: (sx - lay.left) / this.art.zoom + (this.slot?.layout?.scrollX ?? 0), y: sy / this.art.zoom + this.art.scrollY };
  }

  private showPlaceholder(text: string) {
    const info = this.host.render();
    this.placeholder.replaceChildren(h('div.spinner'), h('span', {}, text), ...(info?.error ? [h('small', {}, `Last render failed: ${info.error}`)] : []));
    this.placeholder.classList.remove('hidden');
  }

  private hidePlaceholder() {
    this.placeholder.classList.add('hidden');
  }

  private showBanner(text: string, extra: (Node | string)[] = []) {
    this.banner.replaceChildren(h('span', {}, text), ...extra);
    this.banner.classList.remove('hidden');
  }

  private hideBanner() {
    if (this.reloadWait) return;
    this.banner.classList.add('hidden');
  }

  /** Draws every mark, reusing elements by id so a drag or an edit in progress isn't thrown away. */
  renderMarks() {
    const changed = this.host.changedMarks();
    const keep = new Set<string>();
    const threads = this.card.threads;
    threads.forEach((t, i) => {
      keep.add(t.id);
      this.drawPin(t, i + 1, changed.has(t.id));
    });
    for (const s of this.card.stickies) {
      keep.add(s.id);
      this.drawSticky(s, changed.has(s.id));
    }
    for (const p of this.card.pictures) {
      keep.add(p.id);
      this.drawPicture(p, changed.has(p.id));
    }
    for (const [id, el] of this.markEls) {
      if (keep.has(id) || this.editing?.id === id) continue;
      el.remove();
      this.markEls.delete(id);
    }
  }

  private place(el: HTMLElement, x: number, y: number, w?: number, hgt?: number) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (w !== undefined) el.style.width = `${w}px`;
    if (hgt !== undefined) el.style.height = `${hgt}px`;
  }

  private drawPin(t: Thread, n: number, changed: boolean) {
    let el = this.markEls.get(t.id);
    if (!el) {
      el = h('button.wb-pin', { type: 'button', 'data-mark': t.id });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selected = t.id;
        this.host.selectMark('thread', t.id);
        this.renderMarks();
      });
      this.marks.append(el);
      this.markEls.set(t.id, el);
    }
    const p = this.markPoint(t);
    this.place(el, p.x, p.y);
    el.textContent = String(n);
    const first = t.messages[0];
    el.title = `${first ? `${authorName(first.author)}: ${first.text}` : 'Comment'}${t.messages.length > 1 ? ` (+${t.messages.length - 1})` : ''}`;
    el.style.setProperty('--who', first ? authorColor(first.author) : '#eee');
    this.flags(el, t.id, { resolved: t.resolved, detached: this.detached('thread', t.id), changed });
  }

  private flags(el: HTMLElement, id: string, f: { resolved?: boolean; detached: boolean; changed: boolean }) {
    el.classList.toggle('resolved', !!f.resolved);
    el.classList.toggle('detached', f.detached);
    el.classList.toggle('changed', f.changed);
    el.classList.toggle('on', this.selected === id);
    el.classList.toggle('flash', this.flashId === id);
  }

  private drawSticky(s: Sticky, changed: boolean) {
    let el = this.markEls.get(s.id);
    if (!el) {
      el = this.makeSticky(s.id);
      this.marks.append(el);
      this.markEls.set(s.id, el);
    }
    if (el.classList.contains('dragging')) return;
    const p = this.markPoint(s);
    this.place(el, p.x + s.box.x, p.y + s.box.y, s.box.w, s.box.h);
    el.style.setProperty('--sticky', STICKY_COLORS[s.color]);
    const text = el.querySelector<HTMLElement>('.wb-sticky-text');
    if (text && this.editing?.id !== s.id) {
      text.textContent = s.text;
      text.classList.toggle('blank', !s.text);
    }
    const who = el.querySelector<HTMLElement>('.wb-sticky-who');
    if (who) {
      const a = s.stamps.text.author;
      who.replaceChildren(colorDot(authorColor(a)), authorName(a));
    }
    this.flags(el, s.id, { detached: this.detached('sticky', s.id), changed });
  }

  private makeSticky(id: string): HTMLElement {
    const colors = h(
      'div.wb-colors',
      {},
      ...(Object.keys(STICKY_COLORS) as StickyColor[]).map((c) => {
        const b = h('button.wb-swatch', { type: 'button', title: c, 'aria-label': `Make it ${c}` });
        b.style.background = STICKY_COLORS[c];
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          void this.host.apply([{ op: 'sticky.edit', card: this.card.id, id, color: c }], 'Recoloring the sticky');
        });
        return b;
      }),
    );
    const del = h('button.wb-mark-x', { type: 'button', title: 'Delete the sticky', 'aria-label': 'Delete the sticky' }, '✕');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.host.apply([{ op: 'sticky.rm', card: this.card.id, id }], 'Deleting the sticky');
    });
    const bar = h('div.wb-sticky-bar', {}, h('span.wb-sticky-who'), colors, del);
    const text = h('div.wb-sticky-text');
    const grip = h('div.wb-resize', { title: 'Resize' });
    const el = h('div.wb-sticky', { 'data-mark': id }, bar, text, grip);
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.editSticky(id);
    });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.dragMark(bar, el, 'sticky', id, 'move');
    this.dragMark(grip, el, 'sticky', id, 'resize');
    return el;
  }

  /** Edits a sticky's text in place: Enter with ⌘/Ctrl or a click away saves, Esc puts it back. */
  editSticky(id: string) {
    const el = this.markEls.get(id);
    const s = this.card.stickies.find((x) => x.id === id);
    const text = el?.querySelector<HTMLElement>('.wb-sticky-text');
    if (!el || !s || !text || this.editing?.id === id) return;
    this.editing?.release();
    const ta = h('textarea.wb-sticky-edit', { 'aria-label': 'Sticky note text', maxlength: '2000', placeholder: 'Write a note…' });
    ta.value = s.text;
    text.replaceChildren(ta);
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      releaseEsc();
      this.editing = null;
      const value = ta.value;
      text.textContent = keep ? value : s.text;
      if (keep && value !== s.text) void this.host.apply([{ op: 'sticky.edit', card: this.card.id, id, text: value }], 'Saving the sticky');
      this.renderMarks();
    };
    const releaseEsc = claimEscape(this.el, () => {
      finish(false);
      return true;
    });
    this.editing = { id, release: () => finish(true) };
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(true);
      }
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    setTimeout(() => ta.focus(), 0);
  }

  private drawPicture(p: Picture, changed: boolean) {
    let el = this.markEls.get(p.id);
    if (!el) {
      const img = h('img.wb-picture-img', { alt: 'Picture', draggable: 'false' });
      const del = h('button.wb-mark-x', { type: 'button', title: 'Delete the picture', 'aria-label': 'Delete the picture' }, '✕');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.host.apply([{ op: 'picture.rm', card: this.card.id, id: p.id }], 'Deleting the picture');
      });
      const grip = h('div.wb-resize', { title: 'Resize' });
      el = h('div.wb-picture', { 'data-mark': p.id }, img, del, grip);
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.dragMark(img, el, 'picture', p.id, 'move');
      this.dragMark(grip, el, 'picture', p.id, 'resize');
      this.marks.append(el);
      this.markEls.set(p.id, el);
    }
    if (el.classList.contains('dragging')) return;
    const img = el.querySelector<HTMLImageElement>('img');
    const src = this.host.fileUrl(p.file.hash);
    if (img && img.getAttribute('src') !== src) img.src = src;
    const at = this.markPoint(p);
    this.place(el, at.x + p.box.x, at.y + p.box.y, p.box.w, p.box.h);
    el.title = `Picture from ${authorName(p.stamps.file.author)}`;
    this.flags(el, p.id, { detached: this.detached('picture', p.id), changed });
  }

  /** Moving or resizing a sticky or picture by a handle; it's sent when the drag ends. */
  private dragMark(handle: HTMLElement, el: HTMLElement, kind: 'sticky' | 'picture', id: string, what: 'move' | 'resize') {
    handle.addEventListener('pointerdown', (e) => {
      if (this.pan || this.spacePan) return;
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      const mark = this.findMark(kind, id) as Sticky | Picture | undefined;
      if (!mark) return;
      const start = { x: e.clientX, y: e.clientY };
      const box = { ...mark.box };
      const origin = this.markPoint(mark);
      let moved = false;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / this.zoom;
        const dy = (ev.clientY - start.y) / this.zoom;
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_PX) return;
        moved = true;
        el.classList.add('dragging');
        const next = dragPreview(origin, box, dx, dy, what);
        if (what === 'move') this.place(el, next.x, next.y);
        else this.place(el, next.x, next.y, next.w, next.h);
      };
      const up = async (ev: PointerEvent) => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (!moved) {
          el.classList.remove('dragging');
          return;
        }
        const dx = (ev.clientX - start.x) / this.zoom;
        const dy = (ev.clientY - start.y) / this.zoom;
        // On an artifact a moved mark is anchored again where it was dropped, so it follows that element.
        const anchor = what === 'move' && this.card.kind !== 'canvas' && mark.anchor.kind !== 'point' ? await this.anchorAt(dragPreview(origin, box, dx, dy, 'move')) : undefined;
        const ops = dragMarkOps({ card: this.card.id, kind, id, what, box, dx, dy, anchor });
        // The board has it at once (the batch is applied here first), even while it waits to be sent.
        void this.host.apply(ops, what === 'move' ? `Moving the ${kind}` : `Resizing the ${kind}`);
        el.classList.remove('dragging');
        this.renderMarks();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // ---- Mark up: a click pins a comment, a drag places a sticky ----

  private wire() {
    // Capture navigation before mark handles. The Pan tool/Space catcher also covers live HTML.
    this.el.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 1 && !(e.button === 0 && (this.pan || this.spacePan))) return;
        if ((e.target as HTMLElement).closest('.wb-composer, .wb-navigation-hint, .wb-fs-exit')) return;
        e.stopImmediatePropagation();
        this.panDrag(e);
      },
      true,
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (e.type === 'keyup') return this.setSpacePan(false);
      if (!this.el.isConnected || this.el.closest('.backdrop')?.nextElementSibling || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, button, [contenteditable]')) return;
      if (target !== document.body && !this.el.closest('.modal')?.contains(target)) return;
      e.preventDefault();
      this.setSpacePan(true);
    };
    const blur = () => {
      this.setSpacePan(false);
      this.framePan = null;
      this.el.classList.remove('panning');
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', blur);
    this.offs.push(() => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', blur);
    });
    // The catcher takes clicks over the page in Mark up (and while picking a spot); on a canvas it's the whole background.
    this.catcher.addEventListener('pointerdown', (e) => this.pressBackground(e));
    if (this.card.kind === 'canvas') this.el.addEventListener('pointerdown', (e) => e.target === this.el && this.pressBackground(e));
    else this.el.addEventListener('pointerdown', (e) => e.target === this.el && e.button === 0 && this.panDrag(e));
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.el.classList.add('dropping');
    });
    this.el.addEventListener('dragleave', (e) => {
      if (e.target === this.catcher || e.target === this.el) this.el.classList.remove('dropping');
    });
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('dropping');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      void this.addPictures(files, this.pagePoint(e));
    });
    // A file dragged in from outside reaches the frame first: the catcher comes up to take it.
    const enter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) this.el.classList.add('dropping');
    };
    const end = () => this.el.classList.remove('dropping');
    window.addEventListener('dragenter', enter);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);
    this.offs.push(() => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
    });
  }

  private pressBackground(e: PointerEvent) {
    if (e.button === 1 || (e.button === 0 && this.mode === 'use' && !this.picking && this.card.kind === 'canvas')) return this.panDrag(e);
    if (e.button !== 0) return;
    e.preventDefault();
    this.closeComposer();
    const start = { x: e.clientX, y: e.clientY };
    const a = this.pagePoint(e);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const ghost = h('div.wb-ghost');
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (this.picking) return;
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_PX) return;
      if (!dragging) {
        dragging = true;
        this.marks.append(ghost);
      }
      const b = this.pagePoint(ev);
      this.place(ghost, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    };
    const up = async (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      ghost.remove();
      if (this.picking) return this.pickAt(a);
      if (dragging) return this.placeSticky(a, this.pagePoint(ev));
      this.openComposer(a);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  private async pickAt(p: Point) {
    const pick = this.picking;
    if (!pick) return;
    this.stopPicking();
    const anchor = await this.anchorAt(p);
    const id = pick.id;
    const mark = pick.kind === 'thread' ? undefined : (this.findMark(pick.kind, id) as Sticky | Picture | undefined);
    const ops = reattachMarkOps({ card: this.card.id, kind: pick.kind, id, anchor, box: mark?.box });
    this.sentResolve.delete(id);
    this.located.delete(id);
    void this.host.apply(ops, 'Reattaching');
    this.scheduleLocate();
  }

  private async placeSticky(a: Point, b: Point) {
    const box = dragBox(a, b, STICKY_SIZE);
    const anchor = await this.anchorAt({ x: box.x, y: box.y });
    const id = newId('s');
    void this.host.apply([{ op: 'sticky.add', card: this.card.id, id, anchor, box: { x: 0, y: 0, w: box.w, h: box.h }, text: '', color: 'yellow' }], 'Adding the sticky');
    setTimeout(() => this.editSticky(id), 30);
  }

  private openComposer(p: Point) {
    const ta = h('textarea.input', { 'aria-label': 'Comment', placeholder: 'Comment…', rows: '3', maxlength: '10000' });
    const send = h('button.btn.sm.accent', { type: 'button' }, 'Comment');
    const cancel = h('button.btn.sm.ghost', { type: 'button' }, 'Cancel');
    const el = h('div.wb-composer', {}, ta, h('div.row', {}, h('span.grow', {}, h('span.key', {}, '⌘↵'), 'sends'), cancel, send));
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.place(el, p.x, p.y);
    this.marks.append(el);
    // Near the right or bottom edge it opens up and to the left of the click, so it stays in view.
    const box = el.getBoundingClientRect();
    const view = this.el.getBoundingClientRect();
    const z = this.zoom || 1;
    const dx = Math.max(0, box.right - view.right + 8) / z;
    const dy = Math.max(0, box.bottom - view.bottom + 8) / z;
    if (dx || dy) this.place(el, p.x - dx, p.y - dy);
    const anchorP = this.anchorAt(p);
    const submit = async () => {
      const text = ta.value.trim();
      if (!text) return ta.focus();
      this.closeComposer();
      const thread = newId('t');
      void this.host.apply([{ op: 'comment.add', card: this.card.id, thread, message: newId('m'), anchor: await anchorP, text }], 'Adding the comment');
      this.selected = thread;
      this.host.selectMark('thread', thread);
    };
    send.addEventListener('click', () => void submit());
    cancel.addEventListener('click', () => this.closeComposer());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    });
    const release = claimEscape(this.el, () => {
      if (!this.composer) return false;
      this.closeComposer();
      return true;
    });
    this.composer = { el, release };
    setTimeout(() => ta.focus(), 0);
  }

  private closeComposer() {
    if (!this.composer) return;
    this.composer.release();
    this.composer.el.remove();
    this.composer = null;
  }

  // ---- Panning and zooming by hand ----

  private panDrag(e: PointerEvent) {
    this.flushNavigation();
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let last = { x: e.clientX, y: e.clientY };
    this.el.classList.add('panning');
    const move = (ev: PointerEvent) => {
      this.queueNavigation({ x: 0, y: 0 }, last.x - ev.clientX, last.y - ev.clientY, 0, false, false);
      last = { x: ev.clientX, y: ev.clientY };
    };
    const up = () => {
      this.flushNavigation();
      this.el.classList.remove('panning');
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      target.removeEventListener('lostpointercapture', up);
      window.removeEventListener('blur', up);
      if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
      this.offs = this.offs.filter((off) => off !== up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    target.addEventListener('lostpointercapture', up);
    window.addEventListener('blur', up);
    this.offs.push(up);
  }

  private onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey && (e.target as HTMLElement).closest('.wb-composer, .wb-sticky-edit')) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.queueNavigation(at, e.deltaX, e.deltaY, e.deltaMode, e.shiftKey, e.ctrlKey || e.metaKey);
  }

  private queueNavigation(at: Point, dx: number, dy: number, deltaMode: number, shift: boolean, zoom: boolean) {
    if (this.disposed) return;
    this.navigation.push({ at, ...wheelNavigation(dx, dy, deltaMode, shift, zoom, this.viewport.h) });
    if (!this.navigationFrame) this.navigationFrame = requestAnimationFrame(() => this.flushNavigation());
  }

  private flushNavigation() {
    cancelAnimationFrame(this.navigationFrame);
    this.navigationFrame = 0;
    if (!this.navigation.length) return;
    for (const { at, x, y, factor } of this.navigation) {
      if (factor !== 1) {
        const zoom = clampZoom(this.zoom * factor);
        this.zoomMode = { fit: false, zoom };
        if (this.card.kind === 'canvas') this.canvas = zoomCanvas(this.canvas, zoom, at);
        else this.art = zoomArtifact(this.art, this.viewport, zoom, at);
      } else this.moveView(x, y);
    }
    this.navigation = [];
    this.applyView(true);
    if (this.card.kind === 'html') this.scrollFrame(this.art.scrollY);
  }

  private moveView(dx: number, dy: number) {
    if (this.card.kind === 'canvas') {
      this.zoomMode = { fit: false, zoom: this.zoom };
      this.canvas = { ...this.canvas, x: this.canvas.x + dx / this.zoom, y: this.canvas.y + dy / this.zoom };
    } else this.art = { ...this.art, panX: this.art.panX + dx / this.zoom, scrollY: this.art.scrollY + dy / this.zoom };
  }

  private panBy(dx: number, dy: number) {
    this.queueNavigation({ x: 0, y: 0 }, dx, dy, 0, false, false);
  }
}
