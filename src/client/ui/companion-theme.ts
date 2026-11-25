// Themes the companion page (/dashboard, in a browser or the Mac app): the saved look in this
// browser, painted as custom properties on <body>, a backdrop behind the glass (gradient, artwork or
// the owner's wallpaper, the WebGL stage, a dim and a veil) and the terminals' colors. OG paints
// nothing, so the companion looks exactly as it always has.

import {
  COMPANION_THEME_IDS,
  DEFAULT_THEME_ID,
  GLASS_LEVELS,
  OG_THEME_ID,
  companionTerminalColors,
  companionTheme,
  companionThemeVars,
  type CompanionTheme,
  type CompanionThemeId,
  type GlassLevel,
  type ThemeStageSpec,
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
  art.addEventListener('load', () => art.classList.add('ready'));
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
  showPicture(b, backdropPicture(p, theme, wallSrc), theme.backdrop.position ?? '50% 50%');
  const blur = BLUR_PX[p.blur];
  b.art.style.filter = blur ? `blur(${blur}px)` : '';
  b.art.classList.toggle('blurred', blur > 0);
  b.dim.style.background = DIM_ALPHA[p.dim] ? `rgba(0, 0, 0, ${DIM_ALPHA[p.dim]})` : 'transparent';
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

/** Resolves once `src` is decoded, so a theme switch never shows its artwork half-drawn. */
function decoded(src: string | null): Promise<void> {
  if (!src) return Promise.resolve();
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  return img.decode().catch(() => {});
}

let lastTheme: string | undefined;
let pending = 0;

/** Paints `p`, cross-fading the page when the theme itself changes. */
async function switchTo(p: AppearancePrefs) {
  const ticket = ++pending;
  const changedTheme = lastTheme !== undefined && lastTheme !== p.theme;
  lastTheme = p.theme;
  const theme = companionTheme(p.theme);
  if (theme.id !== OG_THEME_ID) await decoded(backdropPicture(p, theme, wallSrc));
  if (ticket !== pending) return;
  const transition = (document as Document & { startViewTransition?: (fn: () => void) => unknown }).startViewTransition;
  if (changedTheme && transition && !reduceMotion?.matches) transition.call(document, () => paint(p));
  else paint(p);
}

async function reloadWallpaper() {
  const w = await loadWallpaper();
  const next = !w ? null : w.kind === 'file' ? URL.createObjectURL(w.blob) : w.url;
  const old = wallSrc;
  wallSrc = next;
  await switchTo(appearancePrefs());
  if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
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
