// ⚙️ Settings → Appearance (the companions only): the theme gallery, the wallpaper behind the glass,
// how see-through the glass is and whether the backdrop moves. Saved in this browser
// (companion-theme.ts + wallpaper-store.ts) and applied live to the whole page.

import { COMPANION_THEMES, DEFAULT_THEME_ID, GLASS_LEVELS, OG_THEME_ID, companionTheme, companionThemeVars, themePreview, type CompanionTheme, type GlassLevel } from '../../shared/companion-themes';
import {
  APPEARANCE_MOTION,
  WALLPAPER_BLURS,
  WALLPAPER_DIMS,
  WALLPAPER_SOURCES,
  appearancePrefs,
  customWallpaperSrc,
  isDefaultAppearancePrefs,
  onAppearancePrefs,
  onCustomWallpaperSrc,
  resetAppearancePrefs,
  setAppearancePrefs,
  type AppearancePrefs,
} from './companion-theme';
import { h } from './dom';
import { clearWallpaper, loadWallpaper, onWallpaper, saveWallpaperFile, saveWallpaperUrl, wallpaperUrlError, type CustomWallpaper } from './wallpaper-store';

export interface AppearanceSectionParts {
  desc: Node;
  control?: Node;
  below?: Node[];
}

export interface ThemeFamilyGroup<T extends Pick<CompanionTheme, 'family'> = CompanionTheme> {
  family: CompanionTheme['family'];
  label: string;
  note: string;
  themes: T[];
}

/** Display order and copy for the four theme families in the gallery. */
export const THEME_FAMILY_META: readonly { family: CompanionTheme['family']; label: string; note: string }[] = [
  { family: 'classic', label: 'Classic', note: 'Original flat black and Factory orange' },
  { family: 'artwork', label: 'Artwork', note: '4K scenes with moving ambient light' },
  { family: 'shader', label: 'Live', note: 'Animated WebGL backdrops' },
  { family: 'gradient', label: 'Still', note: 'Mesh gradients with no motion' },
];

/** Groups themes in gallery family order (Classic, Artwork, Live, Still), omitting empty families. */
export function groupThemesByFamily<T extends Pick<CompanionTheme, 'family'>>(themes: readonly T[] = COMPANION_THEMES as unknown as readonly T[]): ThemeFamilyGroup<T>[] {
  const groups: ThemeFamilyGroup<T>[] = [];
  for (const meta of THEME_FAMILY_META) {
    const items = themes.filter((t) => t.family === meta.family);
    if (items.length) groups.push({ ...meta, themes: items });
  }
  return groups;
}

/** Splits each family's flat indices into visual rows of at most `columns` tiles. */
export function galleryIndexRows(groupSizes: readonly number[], columns: number): number[][] {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const rows: number[][] = [];
  let cursor = 0;
  for (const size of groupSizes) {
    for (let i = 0; i < size; i += cols) {
      const end = Math.min(size, i + cols);
      const row: number[] = [];
      for (let j = i; j < end; j++) row.push(cursor + j);
      if (row.length) rows.push(row);
    }
    cursor += size;
  }
  return rows;
}

/**
 * Roving-tabindex keyboard navigation across the sectioned gallery. Left/Right step through every
 * theme in order; Up/Down step to the row above or below in the same column (clamping on shorter
 * partial rows); Home and End jump to the first and last theme. Returns null for unrelated keys.
 */
export function galleryNextIndex(current: number, key: string, groupSizes: readonly number[], columns = 1): number | null {
  const total = groupSizes.reduce((sum, n) => sum + n, 0);
  if (total <= 0 || current < 0 || current >= total) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  if (key === 'ArrowRight') return (current + 1) % total;
  if (key === 'ArrowLeft') return (current - 1 + total) % total;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return null;
  const rows = galleryIndexRows(groupSizes, columns);
  const r = rows.findIndex((row) => row.includes(current));
  if (r < 0) return null;
  const c = rows[r].indexOf(current);
  const targetRow = rows[(r + (key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
  return targetRow[Math.min(c, targetRow.length - 1)];
}

/** Formats a byte count for the custom wallpaper summary. */
export function formatWallpaperBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** Readable title and subtitle for the owner's stored wallpaper. */
export function describeCustomWallpaper(w: CustomWallpaper): { name: string; detail: string; full: string } {
  if (w.kind === 'file') {
    const name = w.name.trim() || 'Custom picture';
    return { name, detail: `${formatWallpaperBytes(w.blob.size)} · Original file, never re-encoded`, full: name };
  }
  if (/^data:image\//i.test(w.url)) {
    return { name: 'Inline image', detail: 'Data URL · Original quality', full: 'Inline image data URL' };
  }
  try {
    const u = new URL(w.url);
    const tail = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    const name = tail && /\.[a-z0-9]{2,5}$/i.test(tail) ? tail : u.host || w.url;
    return { name, detail: u.host ? `Linked from ${u.host}` : 'Linked image', full: w.url };
  } catch {
    return { name: w.url, detail: 'Linked image', full: w.url };
  }
}

export function themeDescription(theme: CompanionTheme): string {
  if (theme.id === OG_THEME_ID) {
    return 'OG keeps the original flat black and orange look. Pick another theme for 4K artwork, translucent glass and live backdrops.';
  }
  return `${theme.name}: ${theme.blurb}`;
}

export function wallpaperDescription(theme: CompanionTheme, wallpaper: AppearancePrefs['wallpaper'], hasCustom: boolean): string {
  if (theme.id === OG_THEME_ID) {
    return wallpaper === 'custom'
      ? 'OG keeps the original flat look with no backdrop. Pick another theme above to see your picture behind the glass (wallpaper, glass and motion apply to the other themes).'
      : 'OG keeps the original flat look (wallpaper, glass and motion apply to the other themes).';
  }
  if (wallpaper === 'none') return 'No picture behind the glass; only the theme’s gradient and shader show.';
  if (wallpaper === 'custom') {
    return hasCustom ? 'Your picture behind the glass, kept byte for byte at full resolution.' : 'Choose a picture below or paste a link. Until you pick one, the theme’s own backdrop stays visible.';
  }
  return theme.backdrop.image ? 'The theme’s full-resolution 4K artwork behind the glass.' : 'This theme has no artwork image of its own. Choose Your picture to put a photo behind its glass.';
}

export function glassDescription(theme: CompanionTheme, glass: GlassLevel): string {
  if (theme.id === OG_THEME_ID) return 'OG keeps the original flat look with opaque panels (wallpaper, glass and motion apply to the other themes).';
  if (glass === 'clear') return 'Shows more of the backdrop through the top bar, sidebar and panes.';
  if (glass === 'solid') return 'Opaque panels with no backdrop blur.';
  return 'Balanced blur and tint so text stays readable over bright backdrops.';
}

export function motionDescription(theme: CompanionTheme, motion: AppearancePrefs['motion'], systemReducedMotion = false): string {
  if (theme.id === OG_THEME_ID) return 'OG keeps the original flat look with no backdrop animation (wallpaper, glass and motion apply to the other themes).';
  if (!theme.backdrop.stage) return 'Still themes have no motion anyway. Your system’s Reduce motion setting also keeps animated backdrops still.';
  if (systemReducedMotion) return 'Held on a still frame because your system’s Reduce motion setting is on. Still themes have no motion anyway.';
  if (motion === 'still') return 'Holds the backdrop shader on one still frame. Your system’s Reduce motion setting also keeps it still, and Still themes have no motion anyway.';
  return 'Animates the backdrop shader at full display frame rate. Your system’s Reduce motion setting also keeps it still, and Still themes have no motion anyway.';
}

const WALLPAPER_LABELS: readonly (readonly [AppearancePrefs['wallpaper'], string])[] = [
  ['theme', 'Theme artwork'],
  ['custom', 'Your picture'],
  ['none', 'None'],
];

const DIM_LABELS: readonly (readonly [AppearancePrefs['dim'], string])[] = [
  ['none', 'None'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];

const BLUR_LABELS: readonly (readonly [AppearancePrefs['blur'], string])[] = [
  ['none', 'None'],
  ['soft', 'Soft'],
  ['strong', 'Strong'],
];

const GLASS_LABELS: readonly (readonly [GlassLevel, string])[] = [
  ['clear', 'Clear'],
  ['frosted', 'Frosted'],
  ['solid', 'Solid'],
];

const MOTION_LABELS: readonly (readonly [AppearancePrefs['motion'], string])[] = [
  ['live', 'Live'],
  ['still', 'Still'],
];

const SVG_NS = 'http://www.w3.org/2000/svg';

function checkGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M2.3 6.2 4.9 8.8 9.7 3.4');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.9');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function pictureGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', '2.25');
  rect.setAttribute('y', '3.25');
  rect.setAttribute('width', '15.5');
  rect.setAttribute('height', '13.5');
  rect.setAttribute('rx', '2');
  rect.setAttribute('fill', 'none');
  rect.setAttribute('stroke', 'currentColor');
  rect.setAttribute('stroke-width', '1.4');
  const sun = document.createElementNS(SVG_NS, 'circle');
  sun.setAttribute('cx', '7');
  sun.setAttribute('cy', '7.8');
  sun.setAttribute('r', '1.4');
  sun.setAttribute('fill', 'currentColor');
  const hills = document.createElementNS(SVG_NS, 'path');
  hills.setAttribute('d', 'M3 15.2 7.6 10.8 11.2 14 13.8 11.6 17 15.2');
  hills.setAttribute('fill', 'none');
  hills.setAttribute('stroke', 'currentColor');
  hills.setAttribute('stroke-width', '1.4');
  hills.setAttribute('stroke-linecap', 'round');
  hills.setAttribute('stroke-linejoin', 'round');
  svg.append(rect, sun, hills);
  return svg;
}

let fieldSeq = 0;

function seg<K extends keyof AppearancePrefs>(key: K, label: string, options: readonly (readonly [AppearancePrefs[K], string])[]) {
  const row = h('div.seg', { role: 'radiogroup', 'aria-label': label });
  const buttons = options.map(([value, text]) =>
    h(
      'button.btn',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        onclick: () => {
          if (appearancePrefs()[key] !== value) setAppearancePrefs({ [key]: value } as Partial<AppearancePrefs>);
        },
      },
      text,
    ),
  );
  row.append(...buttons);
  const paint = (prefs: AppearancePrefs) => {
    const at = prefs[key];
    options.forEach(([value], i) => {
      const on = at === value;
      buttons[i].classList.toggle('on', on);
      buttons[i].setAttribute('aria-checked', String(on));
    });
  };
  return { row, paint };
}

/** Applies a theme's custom properties onto its gallery tile so the mock chrome paints with real tokens. */
function applyTileVars(el: HTMLElement, theme: CompanionTheme, glass: GlassLevel) {
  const level: GlassLevel = theme.id === OG_THEME_ID ? 'solid' : glass;
  for (const [k, v] of Object.entries(companionThemeVars(theme, level))) el.style.setProperty(k, v);
  el.dataset.glass = level;
  el.style.setProperty('--th-tile-backdrop', theme.backdrop.gradient);
  el.style.setProperty('--th-tile-veil', theme.backdrop.veil ?? 'none');
  el.style.setProperty('--th-tile-pos', theme.backdrop.position ?? '50% 50%');
}

/** Builds one theme tile with real backdrop layers and a miniature companion chrome mock. */
function buildThemeTile(theme: CompanionTheme, onPick: () => void): HTMLButtonElement {
  const previewSrc = themePreview(theme);
  const og = theme.id === OG_THEME_ID;
  const sceneShader = theme.backdrop.stage?.layer === 'scene' ? theme.backdrop.stage.shader : undefined;

  const art = previewSrc
    ? h('img.theme-preview-art', {
        src: previewSrc,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        draggable: 'false',
      })
    : null;

  const fx = sceneShader ? h('span.theme-preview-fx', { 'aria-hidden': 'true', 'data-shader': sceneShader }) : null;

  const mock = h(
    'span.theme-mock',
    { 'aria-hidden': 'true', class: og ? 'flat' : '' },
    h('span.theme-mock-top', {}, h('span.theme-mock-brand'), h('span.theme-mock-title'), h('span.theme-mock-end', {}, h('span.theme-mock-pill'), h('span.theme-mock-pill'))),
    h(
      'span.theme-mock-body',
      {},
      h(
        'span.theme-mock-side',
        {},
        h('span.theme-mock-item.active', {}, h('span.theme-mock-dot.accent'), h('span.theme-mock-bar')),
        h('span.theme-mock-item', {}, h('span.theme-mock-dot.alt'), h('span.theme-mock-bar.short')),
        h('span.theme-mock-item', {}, h('span.theme-mock-dot'), h('span.theme-mock-bar.mid')),
      ),
      h(
        'span.theme-mock-pane',
        {},
        h('span.theme-mock-head', {}, h('span.theme-mock-chip', {}, h('span.theme-mock-chip-ink')), h('span.theme-mock-subpill')),
        h('span.theme-mock-lines', {}, h('span.theme-mock-line.long'), h('span.theme-mock-line.mid'), h('span.theme-mock-line-row', {}, h('span.theme-mock-line.short'), h('span.theme-mock-cursor'))),
      ),
    ),
  );

  const preview = h('span.theme-preview', { 'aria-hidden': 'true' }, h('span.theme-preview-bg'), art, fx, h('span.theme-preview-veil'), mock);

  const isDefault = theme.id === DEFAULT_THEME_ID;
  const check = h('span.theme-check', { 'aria-hidden': 'true' }, checkGlyph());
  const badges = h('span.theme-badges', {}, isDefault ? h('span.theme-badge', {}, 'Default') : null, check);

  const meta = h('span.theme-meta', {}, h('span.theme-title-row', {}, h('span.theme-name', {}, theme.name), badges), h('span.theme-blurb', {}, theme.blurb));

  return h(
    'button.theme-tile',
    {
      type: 'button',
      role: 'radio',
      'aria-checked': 'false',
      'aria-label': isDefault ? `${theme.name} (Default): ${theme.blurb}` : `${theme.name}: ${theme.blurb}`,
      'data-theme-id': theme.id,
      title: `${theme.name}: ${theme.blurb}`,
      onclick: onPick,
    },
    preview,
    meta,
  );
}

/** Counts columns currently laid out in a `.theme-grid` element for vertical arrow navigation. */
function measuredColumns(grid: HTMLElement | undefined): number {
  if (!grid || typeof getComputedStyle !== 'function') return 3;
  const cols = getComputedStyle(grid).gridTemplateColumns.trim();
  if (!cols || cols === 'none') return 1;
  return Math.max(1, cols.split(/\s+/).length);
}

function droppedUri(data: DataTransfer | null): string | undefined {
  const list = data?.getData('text/uri-list') ?? '';
  const first = list.split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  return first?.trim() || undefined;
}

export function appearanceSettings(): {
  theme: AppearanceSectionParts;
  wallpaper: AppearanceSectionParts;
  glass: AppearanceSectionParts;
  motion: AppearanceSectionParts;
  restore: AppearanceSectionParts;
  dispose: () => void;
} {
  void WALLPAPER_SOURCES;
  void WALLPAPER_DIMS;
  void WALLPAPER_BLURS;
  void GLASS_LEVELS;
  void APPEARANCE_MOTION;

  const groups = groupThemesByFamily(COMPANION_THEMES);
  const groupSizes = groups.map((g) => g.themes.length);
  const orderedThemes = groups.flatMap((g) => g.themes);
  const tiles: HTMLButtonElement[] = [];
  const grids: HTMLElement[] = [];
  let rovingIndex = Math.max(
    0,
    orderedThemes.findIndex((t) => t.id === appearancePrefs().theme),
  );

  const setRoving = (next: number) => {
    rovingIndex = next;
    tiles.forEach((tile, i) => {
      tile.tabIndex = i === rovingIndex ? 0 : -1;
    });
  };

  const selectTheme = (index: number) => {
    const picked = orderedThemes[index];
    if (!picked) return;
    setRoving(index);
    if (appearancePrefs().theme !== picked.id) setAppearancePrefs({ theme: picked.id });
  };

  const gallery = h(
    'div.theme-gallery',
    { role: 'radiogroup', 'aria-label': 'Theme' },
    ...groups.map((g) => {
      const single = g.themes.length === 1;
      const grid = h(
        'div.theme-grid',
        { class: single ? 'single' : '' },
        ...g.themes.map((theme) => {
          const index = tiles.length;
          const tile = buildThemeTile(theme, () => selectTheme(index));
          if (single) tile.classList.add('wide');
          tiles.push(tile);
          return tile;
        }),
      );
      grids.push(grid);
      return h('div.theme-family', { 'data-family': g.family }, h('div.theme-family-head', {}, h('span.eyebrow', {}, g.label), h('span.theme-family-note', {}, g.note)), grid);
    }),
  );

  gallery.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const focused = tiles.indexOf(e.target as HTMLButtonElement);
      if (focused >= 0) {
        e.preventDefault();
        selectTheme(focused);
      }
      return;
    }
    const active = tiles.indexOf(e.target as HTMLButtonElement);
    const from = active >= 0 ? active : rovingIndex;
    const sampleGrid = grids.find((g) => g.children.length > 1) ?? grids[0];
    const next = galleryNextIndex(from, e.key, groupSizes, measuredColumns(sampleGrid));
    if (next === null) return;
    e.preventDefault();
    setRoving(next);
    tiles[next]?.focus();
  });

  // ---- Wallpaper controls -------------------------------------------------------------------------
  const wallpaper = seg('wallpaper', 'Wallpaper', WALLPAPER_LABELS);
  const dim = seg('dim', 'Dim', DIM_LABELS);
  const blur = seg('blur', 'Blur', BLUR_LABELS);
  const glass = seg('glass', 'Glass', GLASS_LABELS);
  const motion = seg('motion', 'Motion', MOTION_LABELS);

  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: -1 }) as HTMLInputElement;
  const linkId = `appearance-wallpaper-url-${++fieldSeq}`;
  const linkInput = h('input.input', {
    id: linkId,
    type: 'url',
    placeholder: 'https://example.com/wallpaper.jpg',
    'aria-label': 'Paste a link',
    spellcheck: 'false',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const useLinkBtn = h('button.btn', { type: 'button' }, 'Use') as HTMLButtonElement;
  const wallError = h('p.field-error.hidden', { role: 'alert' });
  const wallSlot = h('div.wallpaper-slot');

  let storedWallpaper: CustomWallpaper | null = null;
  let fallbackBlobUrl: string | null = null;
  let wallTicket = 0;
  let wallBusy = false;
  let errorText = '';
  let disposed = false;

  const revokeFallbackUrl = () => {
    if (fallbackBlobUrl) {
      URL.revokeObjectURL(fallbackBlobUrl);
      fallbackBlobUrl = null;
    }
  };

  const setError = (msg: string, fromLink = false) => {
    errorText = msg;
    wallError.textContent = msg;
    wallError.classList.toggle('hidden', !msg);
    if (msg && fromLink) linkInput.setAttribute('aria-invalid', 'true');
    else linkInput.removeAttribute('aria-invalid');
  };

  const previewUrl = (): string | null => {
    const live = customWallpaperSrc();
    if (live) return live;
    if (!storedWallpaper) return null;
    if (storedWallpaper.kind === 'url') return storedWallpaper.url;
    if (!fallbackBlobUrl) fallbackBlobUrl = URL.createObjectURL(storedWallpaper.blob);
    return fallbackBlobUrl;
  };

  const paintBusy = () => {
    useLinkBtn.disabled = wallBusy;
    useLinkBtn.textContent = wallBusy ? 'Loading…' : 'Use';
    linkInput.disabled = wallBusy;
  };

  const useFile = async (file: File) => {
    const my = ++wallTicket;
    setError('');
    wallBusy = true;
    paintBusy();
    try {
      await saveWallpaperFile(file);
      if (disposed || my !== wallTicket) return;
      linkInput.value = '';
      if (appearancePrefs().wallpaper !== 'custom') setAppearancePrefs({ wallpaper: 'custom' });
    } catch (err) {
      if (disposed || my !== wallTicket) return;
      setError(err instanceof Error ? err.message : 'Could not load that picture.');
    } finally {
      if (!disposed && my === wallTicket) {
        wallBusy = false;
        paintBusy();
      }
    }
  };

  const useUrl = async (raw = linkInput.value) => {
    const check = wallpaperUrlError(raw);
    if (check) {
      setError(check, true);
      linkInput.focus();
      return;
    }
    const my = ++wallTicket;
    setError('');
    wallBusy = true;
    paintBusy();
    try {
      await saveWallpaperUrl(raw);
      if (disposed || my !== wallTicket) return;
      if (appearancePrefs().wallpaper !== 'custom') setAppearancePrefs({ wallpaper: 'custom' });
    } catch (err) {
      if (disposed || my !== wallTicket) return;
      setError(err instanceof Error ? err.message : 'That link didn’t load as a picture.', true);
    } finally {
      if (!disposed && my === wallTicket) {
        wallBusy = false;
        paintBusy();
      }
    }
  };

  const removeCustom = async () => {
    const my = ++wallTicket;
    setError('');
    try {
      await clearWallpaper();
      if (disposed || my !== wallTicket) return;
      linkInput.value = '';
    } catch (err) {
      if (disposed || my !== wallTicket) return;
      setError(err instanceof Error ? err.message : 'Could not remove the picture.');
    }
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void useFile(file);
  });

  useLinkBtn.addEventListener('click', () => void useUrl());
  linkInput.addEventListener('input', () => {
    if (errorText) setError('');
  });
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void useUrl();
    }
  });

  const wireDropZone = (zone: HTMLElement) => {
    const accepts = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/uri-list');
    zone.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('dropping');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !zone.contains(e.relatedTarget as Node)) zone.classList.remove('dropping');
    });
    zone.addEventListener('drop', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      zone.classList.remove('dropping');
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        void useFile(file);
        return;
      }
      const uri = droppedUri(e.dataTransfer);
      if (uri) {
        linkInput.value = uri;
        void useUrl(uri);
      }
    });
  };

  const paintWallSlot = () => {
    if (!storedWallpaper) {
      const chooseBtn = h('button.btn.sm.primary', { type: 'button', onclick: () => fileInput.click() }, 'Choose picture…');
      const drop = h(
        'div.wallpaper-drop',
        {
          role: 'button',
          tabindex: 0,
          'aria-label': 'Drop a picture here, or click to choose from your computer',
          onclick: (e: Event) => {
            if ((e.target as HTMLElement | null)?.closest('button')) return;
            fileInput.click();
          },
          onkeydown: (e: Event) => {
            const ke = e as KeyboardEvent;
            if (ke.target !== drop) return;
            if (ke.key === 'Enter' || ke.key === ' ') {
              ke.preventDefault();
              fileInput.click();
            }
          },
        },
        h('span.wallpaper-drop-icon', { 'aria-hidden': 'true' }, pictureGlyph()),
        h('b.wallpaper-drop-title', {}, 'Drop a picture here, or click to choose'),
        h('small.wallpaper-drop-hint', {}, 'PNG, JPEG, WebP, AVIF, GIF or SVG, kept byte for byte at full quality.'),
        chooseBtn,
      );
      wireDropZone(drop);
      wallSlot.replaceChildren(drop);
      return;
    }

    const info = describeCustomWallpaper(storedWallpaper);
    const src = previewUrl();
    const thumb = src ? h('img.wallpaper-thumb', { src, alt: '', decoding: 'async', draggable: 'false' }) : h('span.wallpaper-thumb-empty', { 'aria-hidden': 'true' }, pictureGlyph());
    const current = h(
      'div.wallpaper-current',
      {},
      thumb,
      h('div.wallpaper-info', {}, h('b.wallpaper-name', { title: info.full }, info.name), h('small.wallpaper-sub', {}, `${info.detail} · Drop a picture here to replace`)),
      h('div.wallpaper-actions', {}, h('button.btn.sm', { type: 'button', onclick: () => fileInput.click() }, 'Replace…'), h('button.btn.sm.danger', { type: 'button', onclick: () => void removeCustom() }, 'Remove')),
    );
    wireDropZone(current);
    wallSlot.replaceChildren(current);
  };

  const linkField = h('div.field.wallpaper-link', {}, h('label', { for: linkId }, 'Paste a link'), h('div.input-group', {}, linkInput, useLinkBtn), wallError);

  const customPanel = h('div.wallpaper-panel', {}, fileInput, wallSlot, linkField);

  const tuning = h(
    'div.wallpaper-tuning',
    {},
    h('div.wallpaper-subrow', {}, h('div.wallpaper-sublabel', {}, h('b', {}, 'Dim'), h('small', {}, 'Darkens the picture behind the glass.')), dim.row),
    h('div.wallpaper-subrow', {}, h('div.wallpaper-sublabel', {}, h('b', {}, 'Blur'), h('small', {}, 'Softens the picture behind the glass.')), blur.row),
  );

  // ---- Descriptions & live sync -------------------------------------------------------------------
  const themeDesc = h('small');
  const wallDesc = h('small');
  const glassDesc = h('small');
  const motionDesc = h('small');
  const restore = h(
    'button.btn',
    {
      type: 'button',
      onclick: () => {
        setError('');
        resetAppearancePrefs();
      },
    },
    'Restore defaults',
  ) as HTMLButtonElement;

  const reduceMotion = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;

  const paint = () => {
    const prefs = appearancePrefs();
    const activeTheme = companionTheme(prefs.theme);
    const og = activeTheme.id === OG_THEME_ID;
    const focusInsideGallery = typeof document !== 'undefined' && gallery.contains(document.activeElement);

    orderedThemes.forEach((t, i) => {
      const tile = tiles[i];
      const on = t.id === prefs.theme;
      applyTileVars(tile, t, prefs.glass);
      tile.classList.toggle('on', on);
      tile.setAttribute('aria-checked', String(on));
      if (on && !focusInsideGallery) rovingIndex = i;
    });
    setRoving(rovingIndex);

    for (const s of [wallpaper, dim, blur, glass, motion]) s.paint(prefs);

    customPanel.classList.toggle('hidden', prefs.wallpaper !== 'custom');
    const showTuning = prefs.wallpaper === 'custom' || (prefs.wallpaper === 'theme' && !og && Boolean(activeTheme.backdrop.image));
    tuning.classList.toggle('hidden', !showTuning);

    themeDesc.textContent = themeDescription(activeTheme);
    wallDesc.textContent = wallpaperDescription(activeTheme, prefs.wallpaper, Boolean(storedWallpaper));
    glassDesc.textContent = glassDescription(activeTheme, prefs.glass);
    motionDesc.textContent = motionDescription(activeTheme, prefs.motion, Boolean(reduceMotion?.matches));

    restore.disabled = isDefaultAppearancePrefs(prefs);
  };

  const refreshStoredWallpaper = async () => {
    const loaded = await loadWallpaper();
    if (disposed) return;
    revokeFallbackUrl();
    storedWallpaper = loaded;
    if (loaded?.kind === 'url' && !linkInput.value) linkInput.value = loaded.url;
    paintWallSlot();
    paint();
  };

  paintWallSlot();
  paint();
  void refreshStoredWallpaper();

  const onMotionMedia = () => paint();
  reduceMotion?.addEventListener('change', onMotionMedia);

  const offs = [
    onAppearancePrefs(() => {
      if (errorText && appearancePrefs().wallpaper !== 'custom') setError('');
      paint();
    }),
    onWallpaper(() => void refreshStoredWallpaper()),
    onCustomWallpaperSrc(() => {
      if (storedWallpaper) paintWallSlot();
    }),
  ];

  return {
    theme: { desc: themeDesc, below: [gallery] },
    wallpaper: { desc: wallDesc, control: wallpaper.row, below: [customPanel, tuning] },
    glass: { desc: glassDesc, control: glass.row },
    motion: { desc: motionDesc, control: motion.row },
    restore: { desc: h('small', {}, 'Put every Appearance setting back to how it came.'), control: restore },
    dispose: () => {
      disposed = true;
      wallTicket++;
      revokeFallbackUrl();
      reduceMotion?.removeEventListener('change', onMotionMedia);
      for (const off of offs) off();
    },
  };
}
