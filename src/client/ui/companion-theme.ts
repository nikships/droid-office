// Themes the companion page (/dashboard, in a browser or the Mac app): the saved look in this
// browser, painted as custom properties on <body>, a backdrop behind the glass (gradient, artwork or
// the owner's wallpaper, the WebGL stage, a dim and a veil) and the terminals' colors. OG paints
// nothing, so the companion looks exactly as it always has.

import {
  COMPANION_THEME_IDS,
  DEFAULT_THEME_ID,
  GLASS_LEVELS,
  OG_THEME_ID,
  brightGray,
  companionTerminalColors,
  companionTheme,
  companionThemeVars,
  type CompanionTheme,
  type CompanionThemeId,
  type GlassLevel,
  type ThemeStageSpec,
  pictureShade,
} from '../../shared/companion-themes';
import { setTermThemeColors } from '../term-theme';
import { savedPrefs, type PrefOptions } from './saved-prefs';
import { createThemeStage, type ThemeStage } from './theme-stage';
import { loadWallpaper, onWallpaper } from './wallpaper-store';

export const APPEARANCE_MOTION = ['live', 'still'] as const;
export const WALLPAPER_SOURCES = ['theme', 'custom', 'none'] as const;
export const WALLPAPER_DIMS = ['none', 'low', 'medium', 'high'] as const;
export const WALLPAPER_BLURS = ['none', 'soft', 'strong'] as const;

export interface AppearancePrefs {
  theme: CompanionThemeId;
  /** Live runs the theme's shader; Still holds one frame of it. The system's reduce-motion setting holds it too. */
  motion: (typeof APPEARANCE_MOTION)[number];
  glass: GlassLevel;
  /** The picture behind the glass: the theme's artwork, the owner's own (wallpaper-store.ts), or none. */
  wallpaper: (typeof WALLPAPER_SOURCES)[number];
  /** Darkens the picture under the glass. */
  dim: (typeof WALLPAPER_DIMS)[number];
  /** Softens the picture under the glass. */
  blur: (typeof WALLPAPER_BLURS)[number];
}

export const APPEARANCE_DEFAULTS: Readonly<AppearancePrefs> = Object.freeze({ theme: DEFAULT_THEME_ID, motion: 'live', glass: 'frosted', wallpaper: 'theme', dim: 'none', blur: 'none' });

const OPTIONS: PrefOptions<AppearancePrefs> = {
  theme: COMPANION_THEME_IDS,
  motion: APPEARANCE_MOTION,
  glass: GLASS_LEVELS,
  wallpaper: WALLPAPER_SOURCES,
  dim: WALLPAPER_DIMS,
  blur: WALLPAPER_BLURS,
};

const prefs = savedPrefs('droid-office.companion-appearance', APPEARANCE_DEFAULTS, OPTIONS);

export const normalizeAppearancePrefs = prefs.normalize;
export const isDefaultAppearancePrefs = prefs.isDefault;
export const appearancePrefs = prefs.get;
export const setAppearancePrefs = prefs.set;
export const resetAppearancePrefs = prefs.reset;
export const onAppearancePrefs = prefs.on;

export const DIM_ALPHA: Record<AppearancePrefs['dim'], number> = { none: 0, low: 0.2, medium: 0.4, high: 0.6 };
export const BLUR_PX: Record<AppearancePrefs['blur'], number> = { none: 0, soft: 12, strong: 32 };
/** The page's theme-color as dashboard.html ships it (tests/pwa.test.ts). */
const OG_THEME_COLOR = '#020202';

/** The picture a look shows behind the glass, if any. */
export function backdropPicture(p: Pick<AppearancePrefs, 'wallpaper'>, theme: Pick<CompanionTheme, 'backdrop'>, custom: string | null): string | null {
  if (p.wallpaper === 'none') return null;
  if (p.wallpaper === 'custom' && custom) return custom;
  return theme.backdrop.image ?? null;
}

/** The shader a look runs: none over the owner's own picture when the shader would paint over it. */
export function backdropStage(p: Pick<AppearancePrefs, 'wallpaper'>, theme: Pick<CompanionTheme, 'backdrop'>, custom: string | null): ThemeStageSpec | null {
  const spec = theme.backdrop.stage;
  if (!spec) return null;
  return spec.layer === 'scene' && p.wallpaper === 'custom' && custom ? null : spec;
}

interface Backdrop {
  root: HTMLElement;
  base: HTMLElement;
  art: HTMLImageElement;
  canvas: HTMLCanvasElement;
  dim: HTMLElement;
  veil: HTMLElement;
  stage: ThemeStage | null;
}

let started = false;
let backdrop: Backdrop | undefined;
let applied: string[] = [];
let wallSrc: string | null = null;
let reduceMotion: MediaQueryList | undefined;
/** Each shown picture's bright gray (brightGray), measured once. */
const pictureGrays = new Map<string, number>();
/** Pictures from other sites still to be read for their gray (readAcrossSites). */
const unread = new Map<string, number>();
const wallListeners = new Set<(src: string | null) => void>();

/** The owner's wallpaper as something an <img> can show (an object URL for a kept file), or null. */
export function customWallpaperSrc(): string | null {
  return wallSrc;
}

/** Hears the owner's wallpaper change; returns the unlisten. */
export function onCustomWallpaperSrc(fn: (src: string | null) => void): () => void {
  wallListeners.add(fn);
  return () => {
    wallListeners.delete(fn);
  };
}

const animating = (p: AppearancePrefs) => p.motion === 'live' && !reduceMotion?.matches;

function makeBackdrop(): Backdrop {
  const layer = (name: string) => {
    const el = document.createElement('div');
    el.className = `theme-backdrop-${name}`;
    return el;
  };
  const root = document.createElement('div');
  root.className = 'theme-backdrop';
  root.setAttribute('aria-hidden', 'true');
  const base = layer('base');
  const art = document.createElement('img');
  art.className = 'theme-backdrop-art';
  art.alt = '';
  art.decoding = 'async';
  art.draggable = false;
  art.addEventListener('load', () => {
    art.classList.add('ready');
    readAcrossSites(art.getAttribute('src'));
  });
  const canvas = document.createElement('canvas');
  canvas.className = 'theme-backdrop-stage';
  const dim = layer('dim');
  const veil = layer('veil');
  root.append(base, canvas, art, dim, veil);
  document.body.prepend(root);
  return { root, base, art, canvas, dim, veil, stage: createThemeStage(canvas) };
}

function showPicture(b: Backdrop, src: string | null, position: string) {
  b.art.style.objectPosition = position;
  if (!src) {
    b.art.hidden = true;
    b.art.removeAttribute('src');
    b.art.classList.remove('ready');
    return;
  }
  b.art.hidden = false;
  if (b.art.getAttribute('src') === src) return;
  b.art.classList.remove('ready');
  b.art.src = src;
  if (b.art.complete && b.art.naturalWidth) b.art.classList.add('ready');
}

function paint(p: AppearancePrefs) {
  const body = document.body;
  const theme = companionTheme(p.theme);
  const og = theme.id === OG_THEME_ID;
  body.dataset.theme = theme.id;
  body.classList.toggle('themed', !og);
  for (const key of applied) body.style.removeProperty(key);
  applied = [];
  if (!og) {
    for (const [key, value] of Object.entries(companionThemeVars(theme, p.glass))) {
      body.style.setProperty(key, value);
      applied.push(key);
    }
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', og ? OG_THEME_COLOR : theme.bg);
  setTermThemeColors(og ? null : companionTerminalColors(theme));
  if (og) {
    if (backdrop) {
      backdrop.root.hidden = true;
      backdrop.stage?.show(null, false);
    }
    return;
  }
  const b = (backdrop ??= makeBackdrop());
  b.root.hidden = false;
  b.base.style.background = theme.backdrop.gradient;
  const picture = backdropPicture(p, theme, wallSrc);
  showPicture(b, picture, theme.backdrop.position ?? '50% 50%');
  const blur = BLUR_PX[p.blur];
  b.art.style.filter = blur ? `blur(${blur}px)` : '';
  b.art.classList.toggle('blurred', blur > 0);
  const dim = Math.max(DIM_ALPHA[p.dim], picture ? pictureShade(theme, p.glass, pictureGrays.get(picture) ?? 255) : 0);
  b.dim.style.background = dim ? `rgba(0, 0, 0, ${dim})` : 'transparent';
  b.veil.style.background = theme.backdrop.veil ?? 'none';
  const spec = b.stage ? backdropStage(p, theme, wallSrc) : null;
  b.canvas.hidden = !spec;
  if (spec) {
    b.canvas.dataset.layer = spec.layer;
    b.canvas.style.opacity = String(spec.opacity);
    b.canvas.style.mixBlendMode = spec.blend;
  }
  b.stage?.show(spec, animating(p));
}

const crossSite = (src: string) => /^https?:/i.test(src) && new URL(src, location.href).origin !== location.origin;

/**
 * How bright `img`'s bright areas are (brightGray at `quantile`), from a small copy drawn only to be
 * read (the page still shows the original). A picture the page may not read counts as white.
 */
function grayOf(img: HTMLImageElement | null, quantile: number): number {
  if (!img) return 255;
  const w = 96;
  const h = Math.max(1, Math.round((w * img.naturalHeight) / Math.max(1, img.naturalWidth)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 255;
  ctx.drawImage(img, 0, 0, w, h);
  try {
    return brightGray(ctx.getImageData(0, 0, w, h).data, quantile);
  } catch {
    // a tainted canvas: the site didn't allow reading the picture
    return 255;
  }
}

async function load(src: string, cors: boolean): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.decoding = 'async';
  if (cors) img.crossOrigin = 'anonymous';
  img.src = src;
  return img.decode().then(
    () => img,
    () => null,
  );
}

/**
 * Resolves once `src` is decoded, so a theme switch never shows its artwork half-drawn, and its
 * brightness is known. A picture on another site is read through a second (CORS) request instead:
 * it counts as white until that answers, then the backdrop is shaded again.
 */
async function prepare(src: string | null): Promise<void> {
  if (!src) return;
  const art = backdrop?.art;
  if (pictureGrays.has(src) && art?.getAttribute('src') === src && art.complete && art.naturalWidth) return;
  const quantile = src === wallSrc ? 1 : 0.9;
  const shown = await load(src, false);
  if (pictureGrays.has(src)) return;
  // The bundled artwork keeps the panes over its darker parts; the owner's picture can be any photo,
  // cropped anywhere by the window, so it is judged by its brightest part.
  if (!crossSite(src)) {
    pictureGrays.set(src, grayOf(shown, quantile));
    return;
  }
  pictureGrays.set(src, 255);
  unread.set(src, quantile);
}

/**
 * Reads a picture from another site through CORS once the backdrop has shown it: the browser queues
 * two requests for one URL behind each other, so reading it first could hold the picture back.
 */
function readAcrossSites(src: string | null) {
  if (!src) return;
  const quantile = unread.get(src);
  if (quantile === undefined) return;
  unread.delete(src);
  void load(src, true).then((img) => {
    const gray = grayOf(img, quantile);
    if (gray === 255 || pictureGrays.get(src) !== 255) return;
    pictureGrays.set(src, gray);
    const p = appearancePrefs();
    if (backdropPicture(p, companionTheme(p.theme), wallSrc) === src) paint(p);
  });
}

let lastTheme: string | undefined;
let pending = 0;

/** Paints `p`, cross-fading the page when the theme itself changes. */
async function switchTo(p: AppearancePrefs) {
  const ticket = ++pending;
  const changedTheme = lastTheme !== undefined && lastTheme !== p.theme;
  lastTheme = p.theme;
  const theme = companionTheme(p.theme);
  if (theme.id !== OG_THEME_ID) await prepare(backdropPicture(p, theme, wallSrc));
  if (ticket !== pending) return;
  const transition = (document as Document & { startViewTransition?: (fn: () => void) => unknown }).startViewTransition;
  // The transition paints later; by then a newer change may already have painted.
  if (changedTheme && transition && !reduceMotion?.matches) transition.call(document, () => ticket === pending && paint(p));
  else paint(p);
}

let wallpaperReloads = 0;

async function reloadWallpaper() {
  const mine = ++wallpaperReloads;
  const w = await loadWallpaper();
  if (mine !== wallpaperReloads) return;
  const next = !w ? null : w.kind === 'file' ? URL.createObjectURL(w.blob) : w.url;
  const old = wallSrc;
  wallSrc = next;
  await switchTo(appearancePrefs());
  if (mine !== wallpaperReloads) {
    if (next && next !== wallSrc && next.startsWith('blob:')) URL.revokeObjectURL(next);
    return;
  }
  if (old && old !== wallSrc) {
    pictureGrays.delete(old);
    unread.delete(old);
    if (old.startsWith('blob:')) URL.revokeObjectURL(old);
  }
  for (const fn of wallListeners) fn(wallSrc);
}

/** Themes this page from now on: paints the saved look and follows every change, here or in another tab. */
export function startCompanionTheme(): void {
  if (started) return;
  started = true;
  reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const now = appearancePrefs();
  lastTheme = now.theme;
  paint(now);
  void reloadWallpaper();
  onAppearancePrefs((p) => void switchTo(p));
  onWallpaper(() => void reloadWallpaper());
  reduceMotion?.addEventListener('change', () => paint(appearancePrefs()));
}
