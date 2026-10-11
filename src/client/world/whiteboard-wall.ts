import * as THREE from 'three';
import type { WhiteboardRenderInfo, WhiteboardRendererStatus } from '../../shared/protocol';
import { OWNER, cardChanged, cardsNewestFirst, findCard, type Author, type Board, type Card, type CardView, type Point } from '../../shared/whiteboard';
import { MONO, SANS } from '../fonts';
import { withToken } from '../token';
import { ANISOTROPY, SCREEN_SCALE } from './texture-quality';
import { paintGlyph, track } from './toon';

// The Whiteboard on the east wall (docs/whiteboard.md, "On the wall"): the floor's cards as a grid of
// thumbnails, or the selected card blown up at the region the owner last looked at in the window. Both
// come from the render pipeline's PNGs, which already have the card's marks drawn on them, so the wall
// draws no marks of its own. The layout math is pure and exported for tests; the DOM is only touched
// when a WhiteboardTexture is made, so Node can import this module.

/** The wall is painted on this many units (BOARDS.whiteboard is 6 × 3 m); the canvas holds SCREEN_SCALE times as many. */
export const WALL_W = 1200;
export const WALL_H = 600;
/** The wall's shape, which a card's region is cropped or grown to. */
export const WALL_ASPECT = WALL_W / WALL_H;

/** How many cards the grid shows; with more, the last tile reads +N. */
export const GRID_COLS = 3;
export const GRID_ROWS = 2;
export const GRID_MAX = GRID_COLS * GRID_ROWS;

const PAD = 28;
const HEADER_H = 64;
const GAP = 18;
/** A grid tile's caption strip under its thumbnail. */
export const CAPTION_H = 66;
/** The narrowest region of a page the artifact view zooms to, in canonical px. */
export const MIN_REGION_W = 320;
/** The owner's name for themselves on the wall, and their color. */
export const OWNER_NAME = 'You';
export const OWNER_COLOR = '#ee6018';

const BG = '#050505';
const PANEL = '#101010';
const HAIR = 'rgba(255, 255, 255, .1)';
const HAIR_STRONG = 'rgba(255, 255, 255, .18)';
const INK = '#eeeeee';
const MUTED = '#8c8c8c';
const DIM = '#5a5a5a';
const ORANGE = '#ee6018';
const AMBER = '#f2b84b';
const RED = '#ef4444';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the wall shows: the grid, or one card. A selection whose card is gone is the grid. */
export type WallView = { kind: 'grid' } | { kind: 'card'; card: Card };

export function wallView(board: Board): WallView {
  if (board.selection.kind !== 'card') return { kind: 'grid' };
  const card = findCard(board, board.selection.id);
  return card ? { kind: 'card', card } : { kind: 'grid' };
}

export type GridTile<C> = { kind: 'card'; card: C; rect: Rect } | { kind: 'more'; count: number; rect: Rect };

/** The grid's tiles, left to right then top to bottom: up to six cards, or five and a +N for the rest. */
export function gridTiles<C>(cards: readonly C[]): GridTile<C>[] {
  const top = HEADER_H + 8;
  const w = (WALL_W - 2 * PAD - (GRID_COLS - 1) * GAP) / GRID_COLS;
  const h = (WALL_H - PAD - top - (GRID_ROWS - 1) * GAP) / GRID_ROWS;
  const rect = (i: number): Rect => ({ x: PAD + (i % GRID_COLS) * (w + GAP), y: top + Math.floor(i / GRID_COLS) * (h + GAP), w, h });
  const shown = cards.length > GRID_MAX ? GRID_MAX - 1 : cards.length;
  const out: GridTile<C>[] = cards.slice(0, shown).map((card, i) => ({ kind: 'card', card, rect: rect(i) }));
  if (cards.length > shown) out.push({ kind: 'more', count: cards.length - shown, rect: rect(shown) });
  return out;
}

/** A tile's thumbnail area, above its caption. */
export function thumbRect(tile: Rect): Rect {
  return { x: tile.x, y: tile.y, w: tile.w, h: tile.h - CAPTION_H };
}

/**
 * The region of a page (canonical px) the artifact view shows, in the wall's 2:1 shape. Without a view,
 * the top of the page across its width. With one, all of what the owner was looking at, grown to 2:1
 * around its middle, at least MIN_REGION_W wide, then slid onto the page. It is cut to 2:1 from the
 * view's top instead when growing would make it hard to read (a view taller than it is wide) or add
 * blank margins past the page's sides. A region still wider than the page is centered on it; one
 * taller than the page starts at its top.
 */
export function wallRegion(view: CardView | undefined, page: { width: number; height: number }, aspect = WALL_ASPECT): Rect {
  let r: Rect;
  if (!view || !(view.w > 0) || !(view.h > 0)) r = { x: 0, y: 0, w: page.width, h: page.width / aspect };
  else if (view.w < view.h) r = { x: view.x, y: view.y, w: view.w, h: view.w / aspect };
  else if (view.w / view.h >= aspect) {
    const h = view.w / aspect;
    r = { x: view.x, y: view.y + (view.h - h) / 2, w: view.w, h };
  } else {
    const w = view.h * aspect;
    // Grown past the page's sides, it would only add blank margins: cut it to the page's width from the view's top instead.
    r = w > page.width && view.w <= page.width ? { x: 0, y: view.y, w: page.width, h: page.width / aspect } : { x: view.x + (view.w - w) / 2, y: view.y, w, h: view.h };
  }
  if (r.w < MIN_REGION_W) {
    const w = MIN_REGION_W;
    const h = w / aspect;
    r = { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
  }
  const x = r.w >= page.width ? (page.width - r.w) / 2 : Math.min(Math.max(0, r.x), page.width - r.w);
  const y = r.h >= page.height ? 0 : Math.min(Math.max(0, r.y), page.height - r.h);
  return { x, y, w: r.w, h: r.h };
}

/** How a render's full page is cut into tiles: stacked top to bottom, each `tileHeight` canonical px tall but the last. */
export interface TileGrid {
  width: number;
  height: number;
  count: number;
  tileHeight: number;
  /** Image px per canonical px (the render's device scale). */
  scale: number;
}

/**
 * The tile grid of a render, from its status and its first tile's size. A capped page's tiles stop at
 * the cap, so the grid does too.
 */
export function tileGrid(page: { width: number; height: number; tiles: number; tileHeight?: number; capped?: { capPx: number } }, first: { width: number; height: number }): TileGrid {
  const scale = page.width > 0 ? first.width / page.width : 1;
  const height = page.capped ? Math.min(page.height, page.capped.capPx) : page.height;
  const tileHeight = page.tiles <= 1 ? height : (page.tileHeight ?? first.height / scale);
  return { width: page.width, height, count: page.tiles, tileHeight, scale };
}

/** A card's view (canonical px) in its render's own coordinates: a canvas's image starts at `origin`, not 0,0. */
export function viewOnImage(view: CardView | undefined, origin: Point | undefined): CardView | undefined {
  if (!view || !origin) return view;
  return { x: view.x - origin.x, y: view.y - origin.y, w: view.w, h: view.h };
}

/** One drawImage: a slice of tile `tile` (image px) onto the wall (wall units). */
export interface TileDraw {
  tile: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** The tiles a region needs and where each slice of them goes, to fill `dest` with `region` of the page. */
export function tileDraws(region: Rect, grid: TileGrid, dest: Rect): TileDraw[] {
  const k = dest.w / region.w;
  const x0 = Math.max(0, region.x);
  const x1 = Math.min(grid.width, region.x + region.w);
  if (x1 <= x0 || !(grid.tileHeight > 0)) return [];
  const out: TileDraw[] = [];
  for (let i = 0; i < grid.count; i++) {
    const top = i * grid.tileHeight;
    const bottom = Math.min(grid.height, top + grid.tileHeight);
    const y0 = Math.max(top, region.y);
    const y1 = Math.min(bottom, region.y + region.h);
    if (y1 <= y0) continue;
    // Two slices meeting at a fractional y each antialias their edge, leaving a faint line on the wall: meet on a whole unit.
    const dy = Math.round(dest.y + (y0 - region.y) * k);
    const dBottom = Math.round(dest.y + (y1 - region.y) * k);
    out.push({
      tile: i,
      sx: x0 * grid.scale,
      sy: (y0 - top) * grid.scale,
      sw: (x1 - x0) * grid.scale,
      sh: (y1 - y0) * grid.scale,
      dx: dest.x + (x0 - region.x) * k,
      dy,
      dw: (x1 - x0) * k,
      dh: dBottom - dy,
    });
  }
  return out;
}

/** Who made something, as the wall says it: "You" for the owner. */
export function authorLabel(a: Author): { name: string; color: string } {
  return a.kind === 'owner' ? { name: OWNER_NAME, color: OWNER_COLOR } : { name: a.name, color: a.color };
}

/** "just now", "2m ago", "3h ago", "4d ago". */
export function agoText(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** What a card's place says while it has no image: the renderer's install, why there are no renders, the last failure, or that one is coming. */
export function placeholderNote(renderer: WhiteboardRendererStatus, info: WhiteboardRenderInfo | undefined): string {
  if (renderer.installing) {
    const p = renderer.installing.percent;
    return `Setting up the renderer: ${renderer.installing.message}${p !== undefined ? ` (${Math.round(p)}%)` : ''}`;
  }
  if (!renderer.available) return renderer.reason || 'Cards are not rendered to images in this office.';
  if (info?.error) return `The render failed: ${info.error}`;
  return 'Rendering…';
}

/** The few words a grid tile says in place of its thumbnail; the artifact view gives the whole reason. */
export function tileNote(renderer: WhiteboardRendererStatus, info: WhiteboardRenderInfo | undefined): string {
  if (renderer.installing) return 'Setting up previews…';
  if (!renderer.available) return 'No preview: renders are off';
  if (info?.error) return 'The render failed';
  return 'Rendering…';
}

/** The artifact view's status line: how old its image is, and whether a newer one is coming or the last one failed. */
export function renderLine(info: WhiteboardRenderInfo | undefined, now: number): { text: string; error: boolean } {
  if (info?.at === undefined) return { text: info?.error ? 'render failed' : '', error: !!info?.error };
  const parts = [`updated ${agoText(info.at, now)}`];
  if (info.error) parts.push('the last render failed');
  else if (!info.current) parts.push('updating…');
  return { text: parts.join(' · '), error: !!info.error };
}

/** The grid's header: how many cards, and how many changed since the owner last looked. */
export function gridSummary(board: Board): { cards: string; changed: number } {
  const n = board.cards.length;
  const changed = board.cards.filter((c) => cardChanged(board, OWNER, c.id)).length;
  return { cards: `${n} card${n === 1 ? '' : 's'}`, changed };
}

/** `text` broken into at most `maxLines` lines no wider than `maxW` by `measure`, the last one cut with an ellipsis. */
export function wrapText(text: string, maxW: number, maxLines: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (measure(next) <= maxW || !cur) {
      cur = next;
      continue;
    }
    lines.push(cur);
    cur = words[i];
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) {
    lines.push(cur);
    i = words.length;
  }
  if (i < words.length) lines[lines.length - 1] = fitText(`${lines[lines.length - 1]}…`, maxW, measure, true);
  return lines.map((l) => fitText(l, maxW, measure));
}

/** `text` cut with an ellipsis to fit `max`. `ended` says it already ends in one. */
export function fitText(text: string, max: number, measure: (s: string) => number, ended = false): string {
  if (measure(text) <= max) return text;
  let t = ended ? text.slice(0, -1) : text;
  while (t.length > 1 && measure(`${t}…`) > max) t = t.slice(0, -1);
  return `${t}…`;
}

// ---- The texture ----

export interface WallInput {
  floor: string | null;
  /** The floor's board, or null before its snapshot. */
  board: Board | null;
  renderer: WhiteboardRendererStatus;
  renders: Record<string, WhiteboardRenderInfo>;
  /** A card's image URL (WhiteboardSync.renderUrl on this floor), undefined before its first render. */
  renderUrl(card: string, opts: { size: 'thumb' | 'full'; tile?: number }): string | undefined;
  now: number;
}

/** What `/api/whiteboard/render/status` says about a card's latest image (server/whiteboard.ts RenderStatus). */
interface RenderStatusJson {
  image?: { width: number; height: number; tiles: number; tileHeight?: number; capped?: { capPx: number }; origin?: Point; scale?: number };
}

/** A fetched thing: loading, loaded, or failed (null). */
type Loaded<T> = { value?: T | null; used: number };

/** How many decoded images the wall keeps; each card's latest thumbnail and the tiles of one view fit with room to spare. */
const MAX_IMAGES = 32;

/**
 * Paints the Whiteboard. `render` draws only when what it would show changed; images come in by
 * fetch, decoded once per URL (a URL names one render), and each that arrives calls `repaint` so the
 * owner can draw again with the store as it is then.
 */
export class WhiteboardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private drawn = '';
  private images = new Map<string, Loaded<ImageBitmap>>();
  private statuses = new Map<string, Loaded<RenderStatusJson>>();
  private tick = 0;
  /** Each card's last thumbnail URL that loaded, shown while a newer one loads. */
  private lastThumb = new Map<string, string>();
  /** The card the artifact view last drew an image of, kept up while a newer render loads. */
  private shownCard: string | null = null;

  constructor(private repaint: () => void) {
    this.canvas.width = WALL_W * SCREEN_SCALE;
    this.canvas.height = WALL_H * SCREEN_SCALE;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(SCREEN_SCALE, SCREEN_SCALE);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
  }

  render(i: WallInput, force = false) {
    this.tick++;
    const board = i.board;
    const view = board && i.floor ? wallView(board) : undefined;
    if (!board || !view) this.paint(force, 'loading', () => this.message('READING THE BOARD…', MUTED));
    else if (view.kind === 'card') this.renderCard(i, view.card, force);
    else {
      this.shownCard = null;
      this.renderGrid(i, board, force);
    }
  }

  /** Draws when `key` differs from what's up (or `force`, once the fonts load). */
  private paint(force: boolean, key: string, draw: () => void) {
    if (key === this.drawn && !force) return;
    this.drawn = key;
    const g = this.ctx;
    g.fillStyle = BG;
    g.fillRect(0, 0, WALL_W, WALL_H);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    draw();
    this.texture.needsUpdate = true;
    this.evict();
  }

  private renderGrid(i: WallInput, board: Board, force: boolean) {
    const tiles = gridTiles(cardsNewestFirst(board));
    const summary = gridSummary(board);
    const shown = tiles.map((t) => {
      if (t.kind === 'more') return { t, key: ['more', t.count] };
      const c = t.card;
      const author = authorLabel(c.author);
      const thumb = this.thumb(i, c.id);
      return { t, thumb, key: [c.id, c.title, author.name, author.color, cardChanged(board, OWNER, c.id), agoText(c.updatedAt, i.now), thumb?.url ?? '', thumb ? '' : tileNote(i.renderer, i.renders[c.id]), c.kind] };
    });
    const key = JSON.stringify(['grid', i.floor, summary, i.renderer.available, shown.map((s) => s.key)]);
    this.paint(force, key, () => {
      this.gridHeader(summary, i.renderer);
      if (!tiles.length) return this.emptyBoard();
      for (const s of shown) {
        if (s.t.kind === 'more') this.moreTile(s.t.rect, s.t.count);
        else this.cardTile(s.t.rect, s.t.card, board, i, s.thumb?.bitmap);
      }
    });
  }

  /** A card's thumbnail: its latest, or the one before while the latest loads. */
  private thumb(i: WallInput, card: string): { url: string; bitmap: ImageBitmap } | undefined {
    const url = i.renderUrl(card, { size: 'thumb' });
    if (!url) return undefined;
    const now = this.image(url);
    if (now) {
      this.lastThumb.set(card, url);
      return { url, bitmap: now };
    }
    const old = this.lastThumb.get(card);
    const prev = old && this.images.get(old)?.value;
    if (old && prev) {
      this.images.get(old)!.used = this.tick;
      return { url: old, bitmap: prev };
    }
    return undefined;
  }

  private renderCard(i: WallInput, card: Card, force: boolean) {
    const info = i.renders[card.id];
    const author = authorLabel(card.author);
    const line = renderLine(info, i.now);
    const head = [card.id, card.title, author.name, author.color, line.text, line.error];
    const composite = this.composite(i, card);
    if (composite === 'loading' && this.shownCard === card.id && !force) return;
    if (composite === 'loading' || composite === 'none') {
      this.shownCard = null;
      const note = composite === 'loading' ? 'Loading the image…' : placeholderNote(i.renderer, info);
      this.paint(force, JSON.stringify(['card-placeholder', i.floor, head, note]), () => this.cardPlaceholder(card, author, note));
      return;
    }
    this.shownCard = card.id;
    const key = JSON.stringify(['card', i.floor, head, composite.urls, composite.region]);
    this.paint(force, key, () => {
      const g = this.ctx;
      for (const d of composite.draws) g.drawImage(composite.bitmaps[d.tile], d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
      this.cardStrip(card, author, line);
    });
  }

  /** The tiles of a card's latest render that the wall's region of it needs, once they've all loaded. */
  private composite(i: WallInput, card: Card): 'none' | 'loading' | { region: Rect; draws: TileDraw[]; bitmaps: Record<number, ImageBitmap>; urls: string[] } {
    const first = i.renderUrl(card.id, { size: 'full', tile: 0 });
    if (!first || !i.floor) return 'none';
    const at = i.renders[card.id]?.at;
    const q = new URLSearchParams({ floor: i.floor, card: card.id, v: String(at) });
    const status = this.load(this.statuses, `/api/whiteboard/render/status?${q}`, fetchStatus);
    if (status === undefined) return 'loading';
    const page = status?.image;
    if (!page || !(page.width > 0) || !(page.height > 0) || !(page.tiles > 0)) return 'none';
    const tile0 = this.image(first);
    if (tile0 === undefined) return 'loading';
    if (tile0 === null) return 'none';
    const grid = tileGrid(page, tile0);
    const region = wallRegion(viewOnImage(card.view, page.origin), grid);
    const draws = tileDraws(region, grid, { x: 0, y: 0, w: WALL_W, h: WALL_H });
    const bitmaps: Record<number, ImageBitmap> = { 0: tile0 };
    const urls = [first];
    let loading = false;
    for (const d of draws) {
      if (bitmaps[d.tile]) continue;
      const url = i.renderUrl(card.id, { size: 'full', tile: d.tile });
      const b = url ? this.image(url) : null;
      if (b === undefined) loading = true;
      else if (b === null) return 'none';
      else {
        bitmaps[d.tile] = b;
        urls.push(url!);
      }
    }
    return loading ? 'loading' : { region, draws, bitmaps, urls };
  }

  /** A decoded image by URL: fetched on first ask; undefined while it loads, null if it failed. */
  private image(url: string): ImageBitmap | null | undefined {
    return this.load(this.images, url, fetchBitmap);
  }

  private load<T>(cache: Map<string, Loaded<T>>, url: string, get: (url: string) => Promise<T>): T | null | undefined {
    const hit = cache.get(url);
    if (hit) {
      hit.used = this.tick;
      return hit.value;
    }
    const entry: Loaded<T> = { used: this.tick };
    cache.set(url, entry);
    get(url)
      .then(
        (v) => (entry.value = v),
        () => (entry.value = null),
      )
      .finally(() => {
        if (cache.get(url) === entry) this.repaint();
      });
    return undefined;
  }

  /** Lets go of the images and statuses least recently drawn, past what the wall needs. */
  private evict() {
    for (const cache of [this.images, this.statuses] as Map<string, Loaded<unknown>>[]) {
      if (cache.size <= MAX_IMAGES) continue;
      const old = [...cache.entries()].filter(([, e]) => e.used < this.tick && e.value !== undefined).sort((a, b) => a[1].used - b[1].used);
      for (const [url, e] of old.slice(0, cache.size - MAX_IMAGES)) {
        cache.delete(url);
        (e.value as ImageBitmap | null)?.close?.();
      }
    }
  }

  // ---- Drawing ----

  private gridHeader(summary: { cards: string; changed: number }, renderer: WhiteboardRendererStatus) {
    const g = this.ctx;
    g.fillStyle = ORANGE;
    paintGlyph(g, PAD + 16, 38, 28);
    g.fillStyle = INK;
    g.font = `600 26px ${MONO}`;
    track(g, 4);
    g.fillText(summary.cards.toUpperCase(), PAD + 44, 47);
    const status: [string, string] = summary.changed ? [`${summary.changed} CHANGED`, ORANGE] : renderer.installing ? ['SETTING UP PREVIEWS', AMBER] : !renderer.available ? ['NO PREVIEWS', AMBER] : ['ALL SEEN', MUTED];
    g.font = `600 17px ${MONO}`;
    track(g, 3);
    const tw = g.measureText(status[0]).width;
    const x = WALL_W - PAD - tw - 44;
    g.save();
    g.globalAlpha = 0.12;
    g.fillStyle = status[1];
    g.fillRect(x, 20, tw + 44, 34);
    g.restore();
    g.strokeStyle = status[1];
    g.lineWidth = 1.5;
    g.strokeRect(x + 0.75, 20.75, tw + 42.5, 32.5);
    g.fillStyle = status[1];
    g.beginPath();
    g.arc(x + 16, 37, 5, 0, Math.PI * 2);
    g.fill();
    g.fillText(status[0], x + 30, 43);
    track(g, 0);
    g.fillStyle = HAIR;
    g.fillRect(PAD, HEADER_H, WALL_W - 2 * PAD, 1.5);
    g.fillStyle = ORANGE;
    g.fillRect(PAD, HEADER_H - 1, 44, 3.5);
  }

  private emptyBoard() {
    const g = this.ctx;
    const top = HEADER_H + 20;
    const box = { x: PAD, y: top, w: WALL_W - 2 * PAD, h: WALL_H - PAD - top };
    g.fillStyle = PANEL;
    g.fillRect(box.x, box.y, box.w, box.h);
    g.strokeStyle = HAIR_STRONG;
    g.lineWidth = 2;
    g.setLineDash([14, 10]);
    g.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
    g.setLineDash([]);
    const mid = box.y + box.h / 2;
    g.textAlign = 'center';
    g.fillStyle = ORANGE;
    paintGlyph(g, WALL_W / 2, mid - 92, 64);
    g.fillStyle = INK;
    g.font = `600 40px ${MONO}`;
    track(g, 5);
    g.fillText('NOTHING ON THE WHITEBOARD YET', WALL_W / 2, mid + 6);
    track(g, 0);
    g.fillStyle = MUTED;
    g.font = `400 24px ${SANS}`;
    g.fillText('Ask a worker to put something on it:', WALL_W / 2, mid + 56);
    g.fillStyle = INK;
    g.fillText('“Put your plan on the whiteboard”', WALL_W / 2, mid + 92);
    g.textAlign = 'left';
  }

  private cardTile(rect: Rect, card: Card, board: Board, i: WallInput, thumb: ImageBitmap | undefined) {
    const g = this.ctx;
    const author = authorLabel(card.author);
    const changed = cardChanged(board, OWNER, card.id);
    g.fillStyle = PANEL;
    g.fillRect(rect.x, rect.y, rect.w, rect.h);
    const t = thumbRect(rect);
    if (thumb) {
      // The top of the page across the tile's width.
      const k = t.w / thumb.width;
      const sh = Math.min(thumb.height, t.h / k);
      g.fillStyle = '#ffffff';
      g.fillRect(t.x, t.y, t.w, t.h);
      g.drawImage(thumb, 0, 0, thumb.width, sh, t.x, t.y, t.w, sh * k);
    } else {
      g.fillStyle = '#0b0b0b';
      g.fillRect(t.x, t.y, t.w, t.h);
      g.fillStyle = DIM;
      paintGlyph(g, t.x + t.w / 2, t.y + t.h / 2 - 22, 34);
      g.textAlign = 'center';
      g.font = `500 15px ${SANS}`;
      const lines = wrapText(tileNote(i.renderer, i.renders[card.id]), t.w - 40, 2, (s) => g.measureText(s).width);
      lines.forEach((l, n) => g.fillText(l, t.x + t.w / 2, t.y + t.h / 2 + 20 + n * 20));
      g.textAlign = 'left';
    }
    // The caption: the author's color down its edge, the title, who and when.
    const cy = rect.y + rect.h - CAPTION_H;
    g.fillStyle = '#141414';
    g.fillRect(rect.x, cy, rect.w, CAPTION_H);
    g.fillStyle = author.color;
    g.fillRect(rect.x, cy, 5, CAPTION_H);
    g.fillStyle = HAIR;
    g.fillRect(rect.x, cy, rect.w, 1);
    const right = rect.x + rect.w - 16;
    g.font = `600 22px ${SANS}`;
    g.fillStyle = INK;
    g.fillText(
      fitText(card.title || 'Untitled', right - rect.x - 20 - (changed ? 22 : 0), (s) => g.measureText(s).width),
      rect.x + 18,
      cy + 29,
    );
    g.beginPath();
    g.arc(rect.x + 24, cy + 48, 5, 0, Math.PI * 2);
    g.fillStyle = author.color;
    g.fill();
    g.font = `500 15px ${MONO}`;
    track(g, 1);
    g.fillStyle = MUTED;
    g.fillText(
      fitText(`${author.name} · ${agoText(card.updatedAt, i.now)}`, right - rect.x - 40, (s) => g.measureText(s).width),
      rect.x + 36,
      cy + 54,
    );
    track(g, 0);
    if (changed) {
      g.beginPath();
      g.arc(right - 6, cy + 21, 7, 0, Math.PI * 2);
      g.fillStyle = ORANGE;
      g.fill();
    }
    g.strokeStyle = changed ? 'rgba(238, 96, 24, .6)' : HAIR_STRONG;
    g.lineWidth = 1.5;
    g.strokeRect(rect.x + 0.75, rect.y + 0.75, rect.w - 1.5, rect.h - 1.5);
  }

  private moreTile(rect: Rect, count: number) {
    const g = this.ctx;
    g.fillStyle = PANEL;
    g.fillRect(rect.x, rect.y, rect.w, rect.h);
    g.strokeStyle = HAIR_STRONG;
    g.lineWidth = 2;
    g.setLineDash([10, 8]);
    g.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    g.setLineDash([]);
    g.textAlign = 'center';
    g.fillStyle = INK;
    g.font = `600 72px ${MONO}`;
    g.fillText(`+${count}`, rect.x + rect.w / 2, rect.y + rect.h / 2 + 10);
    g.fillStyle = MUTED;
    g.font = `600 16px ${MONO}`;
    track(g, 3);
    g.fillText(`MORE CARD${count === 1 ? '' : 'S'} · E TO SEE THEM ALL`, rect.x + rect.w / 2, rect.y + rect.h / 2 + 52);
    track(g, 0);
    g.textAlign = 'left';
  }

  /** The artifact view's strip along the bottom: the card, its author, and how fresh its image is. */
  private cardStrip(card: Card, author: { name: string; color: string }, line: { text: string; error: boolean }) {
    const g = this.ctx;
    const h = 44;
    const y = WALL_H - h;
    g.fillStyle = 'rgba(5, 5, 5, .82)';
    g.fillRect(0, y, WALL_W, h);
    g.fillStyle = author.color;
    g.fillRect(0, y, 5, h);
    g.font = `500 16px ${MONO}`;
    track(g, 1);
    const status = line.text;
    const sw = status ? g.measureText(status).width : 0;
    g.textAlign = 'right';
    g.fillStyle = line.error ? RED : MUTED;
    if (status) g.fillText(status, WALL_W - 20, y + 28);
    g.textAlign = 'left';
    const who = `${author.name}`;
    const ww = g.measureText(who).width;
    track(g, 0);
    g.font = `600 20px ${SANS}`;
    g.fillStyle = INK;
    const titleMax = WALL_W - 20 - sw - 40 - ww - 60;
    const title = fitText(card.title || 'Untitled', titleMax, (s) => g.measureText(s).width);
    g.fillText(title, 22, y + 29);
    const tx = 22 + g.measureText(title).width + 22;
    g.beginPath();
    g.arc(tx + 4, y + 22, 5, 0, Math.PI * 2);
    g.fillStyle = author.color;
    g.fill();
    g.font = `500 16px ${MONO}`;
    track(g, 1);
    g.fillStyle = MUTED;
    g.fillText(who, tx + 16, y + 28);
    track(g, 0);
  }

  /** A card the wall can't show an image of yet: its title, author and why. */
  private cardPlaceholder(card: Card, author: { name: string; color: string }, note: string) {
    const g = this.ctx;
    const box = { x: PAD, y: PAD, w: WALL_W - 2 * PAD, h: WALL_H - 2 * PAD };
    g.fillStyle = PANEL;
    g.fillRect(box.x, box.y, box.w, box.h);
    g.fillStyle = author.color;
    g.fillRect(box.x, box.y, 6, box.h);
    g.strokeStyle = HAIR_STRONG;
    g.lineWidth = 1.5;
    g.strokeRect(box.x + 0.75, box.y + 0.75, box.w - 1.5, box.h - 1.5);
    const x = box.x + 56;
    const maxW = box.w - 112;
    g.fillStyle = MUTED;
    g.font = `600 17px ${MONO}`;
    track(g, 4);
    g.fillText(card.kind === 'canvas' ? 'CANVAS' : 'ARTIFACT', x, box.y + 76);
    track(g, 0);
    g.fillStyle = INK;
    g.font = `600 52px ${SANS}`;
    const titleLines = wrapText(card.title || 'Untitled', maxW, 2, (s) => g.measureText(s).width);
    titleLines.forEach((l, n) => g.fillText(l, x, box.y + 142 + n * 62));
    const ay = box.y + 142 + titleLines.length * 62 + 6;
    g.beginPath();
    g.arc(x + 8, ay - 8, 8, 0, Math.PI * 2);
    g.fillStyle = author.color;
    g.fill();
    g.font = `500 24px ${MONO}`;
    track(g, 1);
    g.fillStyle = MUTED;
    g.fillText(author.name, x + 28, ay);
    track(g, 0);
    g.fillStyle = HAIR;
    g.fillRect(x, box.y + box.h - 150, maxW, 1.5);
    g.font = `400 22px ${SANS}`;
    g.fillStyle = MUTED;
    wrapText(note, maxW, 3, (s) => g.measureText(s).width).forEach((l, n) => g.fillText(l, x, box.y + box.h - 108 + n * 32));
  }

  private message(title: string, tone: string) {
    const g = this.ctx;
    g.textAlign = 'center';
    g.fillStyle = tone;
    paintGlyph(g, WALL_W / 2, WALL_H / 2 - 60, 56);
    g.fillStyle = INK;
    g.font = `600 34px ${MONO}`;
    track(g, 5);
    g.fillText(title, WALL_W / 2, WALL_H / 2 + 30);
    track(g, 0);
    g.textAlign = 'left';
  }
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(withToken(url), { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status}`);
  return createImageBitmap(await res.blob());
}

async function fetchStatus(url: string): Promise<RenderStatusJson> {
  const res = await fetch(withToken(url), { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as RenderStatusJson;
}
