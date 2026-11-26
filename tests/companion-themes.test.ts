import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  COMPANION_THEMES,
  COMPANION_THEME_IDS,
  DEFAULT_THEME_ID,
  GLASS_LEVELS,
  GLASS_SPECS,
  IMMERSIVE_KEYS,
  MAX_PICTURE_SHADE,
  OG_THEME_ID,
  THEME_SHADERS,
  accentInk,
  brightGray,
  chromeAlpha,
  companionTerminalColors,
  companionTheme,
  companionThemeVars,
  contrastRatio,
  glassAlpha,
  immersiveEntries,
  mixHex,
  parseHex,
  pictureShade,
  rgba,
  themePreview,
} from '../src/shared/companion-themes.js';
import { APPEARANCE_DEFAULTS, backdropPicture, normalizeAppearancePrefs } from '../src/client/ui/companion-theme.js';
import { TERM_THEME, onTermTheme, setTermThemeColors, termTheme, termThemeTransparent } from '../src/client/term-theme.js';

const PUBLIC = new URL('../src/client/public/', import.meta.url);
const HEX = /^#[0-9a-f]{6}$/i;
const themed = COMPANION_THEMES.filter((t) => t.id !== OG_THEME_ID);

/** WCAG luminance and alpha compositing written out here, independently of the module under test. */
const channels = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
function lum(color: string | number[]) {
  const ch = (typeof color === 'string' ? channels(color) : color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const ratio = (a: string | number[], b: string | number[]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** `fg` at `alpha` over a gray level, unrounded as the browser blends it. */
const composite = (fg: string, grayLevel: number, alpha: number) => channels(fg).map((c) => c * alpha + grayLevel * (1 - alpha));

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(buf: Buffer) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, 'a JPEG');
  let i = 2;
  while (i < buf.length) {
    const marker = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('no start-of-frame marker');
}

test('the registry: OG first, unchanged and the default, every id unique', () => {
  assert.equal(new Set(COMPANION_THEME_IDS).size, COMPANION_THEMES.length);
  assert.deepEqual(COMPANION_THEME_IDS, ['og', 'carbons-copy', 'nightly-orbit', 'neo-tokyo', 'kyoto-firefly', 'orbital-foundry', 'abyssal-biolume', 'astral-cathedral', 'sakura-mist']);
  assert.equal(COMPANION_THEMES[0].id, OG_THEME_ID);
  const og = companionTheme(OG_THEME_ID);
  assert.equal(og.name, 'OG');
  assert.deepEqual([og.bg, og.text, og.accent, og.glass], ['#020202', '#eeeeee', '#ee6018', 1]);
  assert.equal('image' in og.backdrop || 'stage' in og.backdrop, false, 'OG paints no backdrop');
  assert.deepEqual(og.terminal, { foreground: TERM_THEME.foreground, cursor: TERM_THEME.cursor, background: TERM_THEME.background, selection: TERM_THEME.selectionBackground });

  assert.equal(DEFAULT_THEME_ID, OG_THEME_ID);
  const carbon = companionTheme('carbons-copy');
  assert.equal(carbon.name, 'Carbon’s Copy');
  assert.ok(lum(carbon.bg) < 0.01, 'a dark theme');
  assert.equal(companionTheme('no-such-theme').id, DEFAULT_THEME_ID);
  assert.equal(companionTheme(undefined).id, DEFAULT_THEME_ID);
  assert.equal(og.family, 'classic');
  assert.ok(themed.every((t) => t.family === 'artwork'));
});

test('every theme reads: AAA text, AA secondary text, a readable accent button and terminal', () => {
  for (const t of COMPANION_THEMES) {
    for (const c of [t.bg, t.tint, t.text, t.muted, t.accent, t.accent2, t.line, ...Object.values(t.terminal)]) assert.match(c, HEX, `${t.id} ${c}`);
    assert.ok(ratio(t.text, t.bg) >= 7 && ratio(t.text, t.tint) >= 7, `${t.id} text`);
    assert.ok(ratio(t.muted, t.bg) >= 4.5 && ratio(t.muted, t.tint) >= 4.5, `${t.id} secondary text`);
    assert.ok(ratio(accentInk(t), t.accent) >= 4.5, `${t.id} accent button label`);
    assert.ok(ratio(t.terminal.foreground, t.terminal.background) >= 7, `${t.id} terminal`);
    assert.ok(t.glass > 0.3 && t.glass <= 1, `${t.id} glass`);
  }
});

test('glass levels: monotonic opacity from Crystal to Solid, Crystal and Solid have no blur, chrome stays thinner than panes', () => {
  assert.deepEqual(GLASS_LEVELS, ['crystal', 'clear', 'tinted', 'frosted', 'smoked', 'solid']);
  for (const t of themed) {
    assert.equal(glassAlpha(t, 'solid'), 1);
    assert.equal(chromeAlpha(t, 'solid'), 1);
    assert.equal(glassAlpha(t, 'frosted'), t.glass, `${t.id} frosted keeps the theme’s base glass`);
    for (let i = 1; i < GLASS_LEVELS.length; i++) {
      const prev = GLASS_LEVELS[i - 1];
      const curr = GLASS_LEVELS[i];
      assert.ok(glassAlpha(t, prev) < glassAlpha(t, curr), `${t.id} pane: ${prev} < ${curr}`);
      assert.ok(chromeAlpha(t, prev) < chromeAlpha(t, curr), `${t.id} chrome: ${prev} < ${curr}`);
    }
    assert.ok(glassAlpha(t, 'crystal') <= 0.3, `${t.id} crystal is genuinely clear`);
    assert.ok(glassAlpha(t, 'clear') <= 0.44, `${t.id} clear is noticeably clearer than frosted`);
    for (const level of GLASS_LEVELS) {
      assert.ok(chromeAlpha(t, level) <= glassAlpha(t, level) && chromeAlpha(t, level) >= 0.1);
      const vars = companionThemeVars(t, level);
      for (const key of ['--bg', '--text', '--accent', '--border', '--th-chrome', '--th-side', '--th-pane', '--th-term', '--th-pop', '--th-blur', '--th-saturate', '--th-pane-saturate', '--th-tile-blur', '--th-accent-ink', '--th-focus'])
        assert.ok(vars[key], `${t.id} ${level} ${key}`);
      for (const value of Object.values(vars)) assert.doesNotMatch(value, /NaN|undefined/);
      assert.equal(vars['--th-pane'], rgba(t.tint, glassAlpha(t, level)));
      assert.equal(vars['--th-term'], rgba(t.terminal.background, glassAlpha(t, level)), 'one layer of glass under a terminal');
      assert.equal(vars['--th-pop'], rgba(t.bg, level === 'solid' ? 1 : 0.94));
      assert.equal(vars['--th-blur'], `${GLASS_SPECS[level].blur}px`);
      assert.equal(vars['--th-saturate'], String(GLASS_SPECS[level].chromeSaturate));
      assert.equal(vars['--th-pane-saturate'], String(GLASS_SPECS[level].paneSaturate));
      assert.equal(vars['--th-tile-blur'], `${GLASS_SPECS[level].tileBlur}px`);
    }
    assert.equal(companionThemeVars(t, 'crystal')['--th-blur'], '0px');
    assert.equal(companionThemeVars(t, 'solid')['--th-blur'], '0px');
    assert.ok(GLASS_SPECS.clear.blur < GLASS_SPECS.tinted.blur && GLASS_SPECS.tinted.blur < GLASS_SPECS.frosted.blur && GLASS_SPECS.frosted.blur < GLASS_SPECS.smoked.blur);
  }
  assert.deepEqual(companionTerminalColors(companionTheme('carbons-copy')), { foreground: '#f2f0ed', cursor: '#ff6a1f', cursorAccent: '#050507', selectionBackground: '#3a2418' });
});

test('immersive treatments are additive, independently optional and do not change glass or terminal colors', () => {
  const carbon = companionTheme('carbons-copy');
  assert.equal(carbon.immersive?.['heading-font'], 'var(--font-mono)');
  const base = { ...carbon, immersive: undefined };
  for (const glass of GLASS_LEVELS) {
    const original = companionThemeVars(base, glass);
    const full = companionThemeVars(carbon, glass);
    const partial = companionThemeVars({ ...base, immersive: { 'heading-font': 'serif' } }, glass);
    assert.deepEqual(partial, { ...original, '--th-heading-font': 'serif' });
    for (const [key, value] of Object.entries(carbon.immersive!)) {
      assert.equal(full[`--th-${key}`], value);
      assert.ok(!(`--th-${key}` in original));
      delete full[`--th-${key}`];
    }
    assert.deepEqual(full, original);
  }
  assert.deepEqual(companionTerminalColors(carbon), companionTerminalColors(base));
});

test('signature materials stay on the nameplate, not on work controls', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
  const identity = ['heading-font', 'chrome-finish', 'panel-edge', 'badge-face', 'badge-ink', 'imprint'];
  const retired = ['control-finish', 'control-radius', 'control-motion', 'focus-outline', 'row-hover', 'row-active', 'sheet-finish', 'panel-radius'];
  assert.deepEqual(
    immersiveEntries(companionTheme('carbons-copy'))
      .map(([key]) => key)
      .sort(),
    identity.toSorted(),
  );
  for (const t of themed.filter((t) => t.family === 'artwork')) {
    const styles = companionThemeVars(t);
    const expected = t.id === 'orbital-foundry' ? ['chrome-finish', 'imprint'] : identity;
    for (const key of expected) assert.ok(styles[`--th-${key}`], `${t.id} keeps ${key}`);
    for (const key of retired) assert.equal(styles[`--th-${key}`], undefined, `${t.id} retires ${key}`);
  }
  for (const key of retired) assert.ok(!css.includes(`data-immersive~="${key}"`), `no signature rule for ${key}`);
  for (const [key, selector] of [
    ['chrome-finish', '.dash-side-head'],
    ['panel-edge', '.dash-side-head::after'],
    ['imprint', '.dash-side-head::before'],
  ]) {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , body]) => body.includes(`var(--th-${key})`));
    assert.deepEqual(
      rules.map(([, head]) => head.replace(/\/\*[\s\S]*?\*\//g, '').trim()),
      [`.themed[data-immersive~="${key}"] ${selector}`],
    );
  }
});

test('color helpers', () => {
  assert.deepEqual(parseHex('#fa0'), { r: 255, g: 170, b: 0 });
  assert.throws(() => parseHex('orange'), /Not a #rrggbb color/);
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(rgba('#ff0000', 2), 'rgba(255, 0, 0, 1)');
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(accentInk({ accent: '#3050ff', bg: '#020202' }), '#ffffff');
  assert.equal(accentInk({ accent: '#e9e9ea', bg: '#060607' }), '#060607');
});

test('a bright picture gets just enough shade to keep text readable on the thinnest glass', () => {
  for (const t of themed) {
    for (const level of GLASS_LEVELS) {
      let last = 0;
      for (let gray = 0; gray <= 255; gray += 15) {
        const shade = pictureShade(t, level, gray);
        assert.ok(shade >= last && shade <= MAX_PICTURE_SHADE, `${t.id} ${level} ${gray}: brighter never needs less`);
        last = shade;
        const ground = composite(t.tint, gray * (1 - shade), chromeAlpha(t, level));
        assert.ok(ratio(t.text, ground) >= 7 && ratio(t.muted, ground) >= 4.5, `${t.id} ${level} over gray ${gray} with shade ${shade}`);
        if (shade > 0.01) {
          const lighter = composite(t.tint, gray * (1 - (shade - 0.02)), chromeAlpha(t, level));
          assert.ok(ratio(t.text, lighter) < 7 || ratio(t.muted, lighter) < 4.5, `${t.id} ${level} ${gray}: no more shade than needed`);
        }
      }
    }
    assert.equal(pictureShade(t, 'frosted', 0), 0, 'a dark picture is left alone');
    assert.equal(pictureShade(t, 'solid', 255), 0, 'nothing shows through solid glass');
  }
});

test('brightGray reads the bright tenth of a picture', () => {
  const px = (n: number, [r, g, b, a]: number[]) => Array.from({ length: n }, () => [r, g, b, a]).flat();
  assert.equal(brightGray([]), 0);
  assert.equal(brightGray(px(10, [255, 255, 255, 255])), 255);
  assert.equal(brightGray(px(10, [0, 0, 0, 255])), 0);
  assert.equal(brightGray(px(10, [255, 255, 255, 0])), 0, 'transparent pixels show the dark base');
  assert.ok(Math.abs(brightGray(px(10, [128, 128, 128, 255])) - 128) <= 1);
  assert.equal(brightGray([...px(85, [0, 0, 0, 255]), ...px(15, [255, 255, 255, 255])]), 255);
  assert.equal(brightGray([...px(95, [0, 0, 0, 255]), ...px(5, [255, 255, 255, 255])]), 0, 'a few sparks do not shade the whole picture');
  assert.equal(brightGray([...px(95, [0, 0, 0, 255]), ...px(5, [255, 255, 255, 255])], 1), 255, 'at 1 the brightest part decides');
});

test('artwork ships at full resolution with a lossless gallery preview', () => {
  for (const t of themed) {
    const image = t.backdrop.image;
    assert.match(image, /^\/themes\/[a-z-]+\.jpg$/);
    assert.deepEqual(jpegSize(readFileSync(new URL(`.${image}`, PUBLIC))), { width: 5504, height: 3072 }, t.id);
    const preview = themePreview(t)!;
    assert.equal(preview, image.replace('/themes/', '/themes/previews/').replace(/\.jpg$/, '.webp'));
    const webp = readFileSync(new URL(`.${preview}`, PUBLIC));
    assert.equal(webp.toString('ascii', 0, 4), 'RIFF');
    assert.equal(webp.toString('ascii', 8, 16), 'WEBPVP8L', `${t.id} preview is lossless`);
  }
  assert.equal(themePreview(companionTheme('og')), undefined);
});

test('every shader is used, and every stage is well formed', () => {
  const used = new Set<string>();
  for (const t of themed) {
    const stage = t.backdrop.stage;
    used.add(stage.shader);
    assert.ok(THEME_SHADERS.includes(stage.shader));
    assert.ok(stage.colors.length >= 1 && stage.colors.length <= 4 && stage.colors.every((c) => HEX.test(c)), t.id);
    assert.ok(stage.opacity > 0 && stage.opacity <= 1 && stage.speed > 0, t.id);
    assert.ok(t.backdrop.image, `${t.id}: an overlay draws over artwork`);
  }
  assert.deepEqual([...used].sort(), [...THEME_SHADERS].sort());
});

test('retired saved theme IDs fall back to OG without resetting other appearance preferences', () => {
  for (const id of ['aurora', 'blueprint', 'outrun', 'solar-silk', 'deep-field', 'velvet', 'glacier', 'dune', 'phosphor', 'graphite']) {
    const saved = { ...APPEARANCE_DEFAULTS, theme: id, motion: 'still', glass: 'clear' };
    assert.deepEqual(normalizeAppearancePrefs(saved), { ...saved, theme: 'og' });
    assert.equal(companionTheme(id).id, 'og');
  }
});

test('appearance prefs and the backdrop they pick', () => {
  assert.equal(APPEARANCE_DEFAULTS.theme, OG_THEME_ID);
  assert.deepEqual(normalizeAppearancePrefs({ theme: 'bogus', glass: 'clear', motion: 'warp', dim: 'high' }), { ...APPEARANCE_DEFAULTS, glass: 'clear', dim: 'high' });
  const carbon = companionTheme('carbons-copy');
  assert.equal(backdropPicture({ wallpaper: 'theme' }, carbon, 'blob:x'), carbon.backdrop.image);
  assert.equal(backdropPicture({ wallpaper: 'custom' }, carbon, 'blob:x'), 'blob:x');
  assert.equal(backdropPicture({ wallpaper: 'custom' }, carbon, null), carbon.backdrop.image, 'no picture kept yet: the theme’s');
  assert.equal(backdropPicture({ wallpaper: 'none' }, carbon, 'blob:x'), null);
});

test('terminals keep TERM_THEME until a theme retints them over a transparent ground', () => {
  assert.equal(termTheme(), TERM_THEME);
  let heard = 0;
  const off = onTermTheme(() => heard++);
  const colors = companionTerminalColors(companionTheme('nightly-orbit'));
  setTermThemeColors(colors);
  assert.equal(termThemeTransparent(), true);
  assert.deepEqual(termTheme(), { ...TERM_THEME, ...colors, background: 'rgba(0, 0, 0, 0)' });
  assert.equal(termTheme().red, TERM_THEME.red, 'agents keep their ANSI colors');
  setTermThemeColors(null);
  assert.equal(termTheme(), TERM_THEME);
  off();
  setTermThemeColors(colors);
  assert.equal(heard, 2);
  setTermThemeColors(null);
});

/** Top-level selectors of a rule, split on commas outside parentheses. */
function selectors(list: string) {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

test('OG stays untouched: only .themed rules, and the theme UI that sets its own (.theme-*), read the theme’s glass', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let checked = 0;
  for (const [, head, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/var\(--th-/.test(body)) continue;
    for (const sel of selectors(head)) {
      assert.match(sel, /^((body)?\.themed\b|\.theme-)/, `${sel} reads --th-* outside .themed`);
      checked++;
    }
  }
  assert.ok(checked > 20, `only ${checked} themed selectors found: is the parse still right?`);
});

test('each selector consuming an immersive treatment requires that exact key on the theme root', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const used = new Set<string>();
  for (const [, head, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const key of IMMERSIVE_KEYS) {
      if (!body.includes(`var(--th-${key})`) && !body.includes(`var(--th-${key},`)) continue;
      for (const sel of selectors(head)) assert.ok(sel.startsWith(`.themed[data-immersive~="${key}"]`), `${sel} requires ${key}`);
      used.add(key);
    }
  }
  assert.deepEqual([...used].sort(), [...IMMERSIVE_KEYS].sort());
});

test('Orbital Foundry uses the standard headings and badges and names its unstriped plate', () => {
  const theme = companionTheme('orbital-foundry');
  assert.equal(theme.immersive?.imprint, '"ORBITAL FOUNDRY" / ""');
  for (const key of ['heading-font', 'panel-edge', 'badge-face', 'badge-ink']) {
    assert.equal(companionThemeVars(theme)[`--th-${key}`], undefined, key);
  }
});
