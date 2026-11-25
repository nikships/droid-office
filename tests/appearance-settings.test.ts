import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPANION_THEMES, DEFAULT_THEME_ID, OG_THEME_ID, companionTheme } from '../src/shared/companion-themes.js';
import {
  THEME_FAMILY_META,
  describeCustomWallpaper,
  formatWallpaperBytes,
  galleryIndexRows,
  galleryNextIndex,
  glassDescription,
  groupThemesByFamily,
  motionDescription,
  themeDescription,
  wallpaperDescription,
} from '../src/client/ui/appearance-settings.js';

test('appearance-settings loads in Node without DOM globals and groups all 19 themes by family', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');

  const groups = groupThemesByFamily();
  assert.deepEqual(
    groups.map((g) => ({ family: g.family, label: g.label, count: g.themes.length })),
    [
      { family: 'classic', label: 'Classic', count: 1 },
      { family: 'artwork', label: 'Artwork', count: 8 },
      { family: 'shader', label: 'Live', count: 5 },
      { family: 'gradient', label: 'Still', count: 5 },
    ],
  );
  assert.equal(
    groups.reduce((n, g) => n + g.themes.length, 0),
    COMPANION_THEMES.length,
  );
  assert.equal(groups[0].themes[0].id, OG_THEME_ID);
  assert.equal(groups[1].themes[0].id, DEFAULT_THEME_ID);
  assert.equal(THEME_FAMILY_META.length, 4);

  const subset = groupThemesByFamily(COMPANION_THEMES.filter((t) => t.family === 'shader'));
  assert.deepEqual(
    subset.map((g) => g.label),
    ['Live'],
  );
});

test('gallery keyboard navigation steps across tiles, rows, partial rows and wrap boundaries', () => {
  const sizes = [1, 8, 5, 5];
  const rows = galleryIndexRows(sizes, 3);
  assert.deepEqual(rows, [[0], [1, 2, 3], [4, 5, 6], [7, 8], [9, 10, 11], [12, 13], [14, 15, 16], [17, 18]]);

  assert.equal(galleryNextIndex(5, 'Home', sizes, 3), 0);
  assert.equal(galleryNextIndex(5, 'End', sizes, 3), 18);
  assert.equal(galleryNextIndex(0, 'ArrowLeft', sizes, 3), 18);
  assert.equal(galleryNextIndex(18, 'ArrowRight', sizes, 3), 0);
  assert.equal(galleryNextIndex(1, 'ArrowRight', sizes, 3), 2);

  // Vertical movement keeps column when available and clamps onto shorter partial rows.
  assert.equal(galleryNextIndex(0, 'ArrowDown', sizes, 3), 1);
  assert.equal(galleryNextIndex(2, 'ArrowUp', sizes, 3), 0);
  assert.equal(galleryNextIndex(2, 'ArrowDown', sizes, 3), 5);
  assert.equal(galleryNextIndex(6, 'ArrowDown', sizes, 3), 8);
  assert.equal(galleryNextIndex(8, 'ArrowDown', sizes, 3), 10);
  assert.equal(galleryNextIndex(0, 'ArrowUp', sizes, 3), 17);
  assert.equal(galleryNextIndex(18, 'ArrowDown', sizes, 3), 0);

  // Single-column fallback and non-navigation keys.
  assert.equal(galleryNextIndex(3, 'ArrowDown', sizes, 1), 4);
  assert.equal(galleryNextIndex(3, 'ArrowUp', sizes, 0), 2);
  assert.equal(galleryNextIndex(3, 'Tab', sizes, 3), null);
  assert.equal(galleryNextIndex(-1, 'ArrowRight', sizes, 3), null);
  assert.equal(galleryNextIndex(0, 'ArrowRight', [], 3), null);
});

test('gallery vertical navigation follows each family’s own column count', () => {
  const sizes = [1, 8, 5];
  const columns = [1, 3, 2];
  assert.deepEqual(galleryIndexRows(sizes, columns), [[0], [1, 2, 3], [4, 5, 6], [7, 8], [9, 10], [11, 12], [13]]);
  assert.equal(galleryNextIndex(0, 'ArrowDown', sizes, columns), 1);
  assert.equal(galleryNextIndex(1, 'ArrowUp', sizes, columns), 0);
  assert.equal(galleryNextIndex(4, 'ArrowUp', sizes, columns), 1);
  assert.equal(galleryNextIndex(8, 'ArrowDown', sizes, columns), 10);
  assert.equal(galleryNextIndex(9, 'ArrowUp', sizes, columns), 7);
});

test('wallpaper metadata formatting preserves original-file messaging and extracts link names', () => {
  assert.equal(formatWallpaperBytes(0), '0 B');
  assert.equal(formatWallpaperBytes(512), '512 B');
  assert.equal(formatWallpaperBytes(42 * 1024), '42 KB');
  assert.equal(formatWallpaperBytes(3.5 * 1024 * 1024), '3.5 MB');
  assert.equal(formatWallpaperBytes(14.2 * 1024 * 1024), '14 MB');

  const fileDesc = describeCustomWallpaper({
    kind: 'file',
    name: 'tokyo-rain-4k.png',
    blob: new Blob([new Uint8Array(2 * 1024 * 1024)]),
  });
  assert.equal(fileDesc.name, 'tokyo-rain-4k.png');
  assert.match(fileDesc.detail, /2\.0 MB/);
  assert.match(fileDesc.detail, /Original file/);

  const urlDesc = describeCustomWallpaper({
    kind: 'url',
    url: 'https://images.example.com/wallpapers/aurora%20night.webp?full=1',
  });
  assert.equal(urlDesc.name, 'aurora night.webp');
  assert.equal(urlDesc.detail, 'Linked from images.example.com');

  const hostDesc = describeCustomWallpaper({
    kind: 'url',
    url: 'https://images.example.com/photo',
  });
  assert.equal(hostDesc.name, 'images.example.com');

  const dataDesc = describeCustomWallpaper({
    kind: 'url',
    url: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(dataDesc.name, 'Inline image');
});

test('descriptions explain OG flat look, empty custom wallpaper guidance, glass levels and motion rules', () => {
  const og = companionTheme('og');
  const carbon = companionTheme('carbons-copy');
  const aurora = companionTheme('aurora');
  const velvet = companionTheme('velvet');

  assert.match(themeDescription(og), /original companion/i);
  assert.equal(themeDescription(carbon), 'Carbon’s Copy: Woven carbon, a forge-orange edge and sparks in the dark.');
  assert.match(wallpaperDescription(og, 'theme', false), /OG has no backdrop/);
  assert.match(wallpaperDescription(og, 'custom', true), /OG has no backdrop/);
  assert.match(glassDescription(og, 'frosted'), /always opaque/);
  assert.match(motionDescription(og, 'live', false), /no backdrop to animate/);

  assert.match(wallpaperDescription(carbon, 'custom', false), /Drop a picture or paste a link/);
  assert.match(wallpaperDescription(carbon, 'custom', true), /kept exactly as you chose it/);
  assert.match(wallpaperDescription(carbon, 'theme', false), /full-resolution artwork/);
  assert.match(wallpaperDescription(aurora, 'theme', false), /Your picture/);
  assert.match(wallpaperDescription(carbon, 'none', false), /No picture/);

  assert.match(glassDescription(carbon, 'clear'), /more of the backdrop/i);
  assert.match(glassDescription(carbon, 'frosted'), /tinted glass/i);
  assert.match(glassDescription(carbon, 'solid'), /Opaque panels/i);

  assert.match(motionDescription(velvet, 'live', false), /doesn’t move/);
  assert.match(motionDescription(aurora, 'live', true), /Reduce motion/);
  assert.match(motionDescription(aurora, 'still', false), /one still frame/);
  assert.match(motionDescription(aurora, 'live', false), /full frame rate/);
});
