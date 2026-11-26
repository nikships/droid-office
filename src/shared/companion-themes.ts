// The companion's themes (web /dashboard and the Mac app's companion): a palette for every surface,
// and a backdrop behind the glass made of a CSS gradient, optional artwork and an optional WebGL
// shader. OG is the companion as it always looked and changes nothing; every other theme is turned
// into CSS custom properties by companionThemeVars.

/** The WebGL scenes a backdrop can run (theme-stage.ts in the client draws them). */
export const THEME_SHADERS = ['aurora', 'nebula', 'silk', 'grid', 'synthwave', 'starfield', 'fireflies', 'embers', 'caustics', 'petals', 'rain'] as const;
export type ThemeShader = (typeof THEME_SHADERS)[number];

/**
 * A backdrop's moving layer. A `scene` paints the whole backdrop; an `overlay` paints light (stars,
 * sparks, rain) on transparency over the artwork, mixed in with `blend`.
 */
export interface ThemeStageSpec {
  shader: ThemeShader;
  layer: 'scene' | 'overlay';
  /** One to four #rrggbb colors the shader paints with, most prominent first. */
  colors: readonly string[];
  /** 1 is the shader's natural pace. */
  speed: number;
  /** How strongly the layer shows, 0–1. */
  opacity: number;
  blend: 'normal' | 'screen' | 'plus-lighter' | 'soft-light' | 'overlay';
}

export interface ThemeBackdrop {
  /** CSS background layers under everything else; always present so the page never flashes empty. */
  gradient: string;
  /** Full-resolution artwork (5504 × 3072) served from the client's public folder as generated, never re-encoded. */
  image?: string;
  /** Where the artwork anchors when the window's shape crops it. */
  position?: string;
  stage?: ThemeStageSpec;
  /** CSS layers drawn over the artwork and shader: vignettes, scanlines, haze. */
  veil?: string;
}

export interface ThemeTerminal {
  foreground: string;
  cursor: string;
  /** The cell color under the panes' glass, #rrggbb; the glass setting decides how much shows through. */
  background: string;
  selection: string;
}

/** Optional surface treatments. Values are trusted CSS from this registry, never saved preferences. */
export const IMMERSIVE_KEYS = [
  'heading-font',
  'caption-font',
  'panel-radius',
  'chrome-finish',
  'panel-edge',
  'badge-face',
  'badge-ink',
  'imprint',
  'control-finish',
  'control-radius',
  'focus-outline',
  'selection',
  'row-hover',
  'row-active',
  'section-rule',
  'sheet-finish',
  'scrollbar-thumb',
  'control-motion',
] as const;
export type ImmersiveTheme = Partial<Record<(typeof IMMERSIVE_KEYS)[number], string>>;

export interface CompanionTheme {
  id: string;
  name: string;
  /** One line for the gallery. */
  blurb: string;
  family: 'classic' | 'artwork' | 'shader' | 'gradient';
  /** The opaque base: the page, modals, menus and popovers. */
  bg: string;
  /** What the glass of the header, the side and the panes is tinted with. */
  tint: string;
  text: string;
  /** Secondary text. */
  muted: string;
  accent: string;
  /** The second color of the backdrop, for edges and glows. */
  accent2: string;
  /** Hairlines are this color at low alpha. */
  line: string;
  /** How opaque the panes are at the default glass, 0–1. Light artwork needs more. */
  glass: number;
  backdrop: ThemeBackdrop;
  terminal: ThemeTerminal;
  immersive?: ImmersiveTheme;
}

const scene = (shader: ThemeShader, colors: readonly string[], opts: Partial<Omit<ThemeStageSpec, 'shader' | 'colors'>> = {}): ThemeStageSpec => ({
  shader,
  colors,
  layer: 'scene',
  speed: 1,
  opacity: 1,
  blend: 'normal',
  ...opts,
});
const overlay = (shader: ThemeShader, colors: readonly string[], opts: Partial<Omit<ThemeStageSpec, 'shader' | 'colors'>> = {}): ThemeStageSpec => ({
  shader,
  colors,
  layer: 'overlay',
  speed: 1,
  opacity: 0.85,
  blend: 'screen',
  ...opts,
});

const VIGNETTE = 'radial-gradient(120% 90% at 50% 40%, transparent 55%, rgba(0, 0, 0, .55) 100%)';

export const COMPANION_THEMES = [
  {
    id: 'og',
    name: 'OG',
    blurb: 'The original companion: OLED black, hairlines and Factory orange.',
    family: 'classic',
    bg: '#020202',
    tint: '#020202',
    text: '#eeeeee',
    muted: '#a3a3a3',
    accent: '#ee6018',
    accent2: '#ee6018',
    line: '#ffffff',
    glass: 1,
    backdrop: { gradient: '#020202' },
    terminal: { foreground: '#eeeeee', cursor: '#ee6018', background: '#000000', selection: '#2a2a2a' },
  },
  {
    id: 'carbons-copy',
    name: 'Carbon’s Copy',
    blurb: 'Woven carbon, a forge-orange edge and sparks in the dark.',
    family: 'artwork',
    bg: '#07070a',
    tint: '#0a0a0e',
    text: '#f2f0ed',
    muted: '#aaa6a1',
    accent: '#ff6a1f',
    accent2: '#7484ff',
    line: '#ffffff',
    glass: 0.74,
    backdrop: {
      gradient: 'radial-gradient(70% 90% at 0% 100%, rgba(255, 106, 31, .28), transparent 60%), radial-gradient(60% 80% at 100% 0%, rgba(116, 132, 255, .22), transparent 60%), linear-gradient(160deg, #0b0b10, #050506)',
      image: '/themes/carbons-copy.jpg',
      position: '30% 50%',
      stage: overlay('embers', ['#ff7a2b', '#ffb067', '#7484ff'], { opacity: 0.7, speed: 0.8 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#f2f0ed', cursor: '#ff6a1f', background: '#050507', selection: '#3a2418' },
    immersive: {
      'heading-font': 'var(--font-mono)',
      'caption-font': '750 11px/1.5 var(--font-mono)',
      'panel-radius': '2px 16px 2px 16px',
      'chrome-finish':
        'linear-gradient(105deg, transparent, #10101638 50%, #09090d9c), repeating-linear-gradient(125deg, #33333d99 0 2px, #14141bb3 2px 4px, #08080b88 4px 7px), repeating-linear-gradient(36deg, #35323ddd 0 3px, #0b0b1188 3px 7px)',
      'panel-edge': 'linear-gradient(110deg, var(--accent) 0 28px, transparent 28px 31px, var(--accent) 31px 37px, transparent 37px 40px, var(--accent) 40px 43px, #ff6a1f75 43px, #7484ff78)',
      'badge-face': 'linear-gradient(135deg, #32221d, #101017 64%, #272b46)',
      'badge-ink': '#ff975d',
      imprint: '"CC—01     /     CARBON SERIES" / ""',
      'control-finish': 'linear-gradient(180deg, #ffffff38 0 1px, transparent 1px 45%, #00000013 47% 94%, #05050870 95%), linear-gradient(115deg, transparent 6px, #03030726 7px 8px, transparent 9px)',
      'control-radius': '1px 8px 1px 8px',
      'focus-outline': '4px double #ffa26a',
      selection: '#673114',
      'row-hover': 'linear-gradient(90deg, #bc774a 0 2px, #272020 2px, #141419 70%)',
      'row-active': 'linear-gradient(105deg, #ff8e4b 0 4px, #100e12 4px 7px, #473027 7px, #17151c 60%, #242536)',
      'section-rule': 'repeating-linear-gradient(118deg, #b46437 0 3px, #241c1b 3px 7px)',
      'sheet-finish': 'linear-gradient(125deg, #28212aeb, #0c0c10e6 38%, #171823eb), repeating-linear-gradient(45deg, #373342 0 2px, #101017 2px 5px)',
      'scrollbar-thumb': '#bc865e',
      'control-motion': '140ms cubic-bezier(.18,.8,.26,1)',
    },
  },
  {
    id: 'nightly-orbit',
    name: 'Nightly Orbit',
    blurb: 'A violet dawn breaking over a sleeping planet.',
    family: 'artwork',
    bg: '#07051a',
    tint: '#0b0820',
    text: '#f1eeff',
    muted: '#c5bedc',
    accent: '#a97bff',
    accent2: '#ff7a45',
    line: '#d9ccff',
    glass: 0.72,
    backdrop: {
      gradient: 'radial-gradient(90% 60% at 50% 110%, rgba(169, 123, 255, .45), transparent 65%), radial-gradient(40% 40% at 85% 15%, rgba(255, 122, 69, .14), transparent 70%), linear-gradient(180deg, #05031a, #0b0628)',
      image: '/themes/nightly-orbit.jpg',
      position: '50% 80%',
      stage: overlay('starfield', ['#ffffff', '#cbb8ff', '#ffb08a'], { opacity: 0.9, speed: 0.6 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#f1eeff', cursor: '#a97bff', background: '#05031a', selection: '#33245c' },
    immersive: {
      'heading-font': '"Avenir Next", Avenir, system-ui, sans-serif',
      'caption-font': '600 10px/1.6 var(--font-mono)',
      'panel-radius': '18px',
      'chrome-finish': 'url("/themes/nightly-orbit-chart.svg"), radial-gradient(ellipse at 98% 130%, #412c47cc, transparent 54%), linear-gradient(110deg, #0c1129f2, #171333e8 64%, #231c45f0)',
      'panel-edge': 'linear-gradient(90deg, #50477a, #ac8cf7 42%, #dec1ff 66%, #ffb48b 85%, #865264)',
      'badge-face': 'radial-gradient(ellipse 145% 100% at 61% 144%, #171433 71%, #77538e 73%, #ffc29a 74%, #754e94 77%, #292345 82%, #101329 96%)',
      'badge-ink': '#ffe0c8',
      imprint: '"NIGHT PASS   /   01" / ""',
      'control-finish': 'linear-gradient(180deg, #dcceff30, transparent 18% 76%, #36244828), linear-gradient(110deg, #c5bcff12, transparent 56%, #ffab8310)',
      'control-radius': '999px',
      'focus-outline': '2px solid #ffbf91',
      selection: '#513870',
      'row-hover': 'linear-gradient(90deg, #9286c5 0 2px, #292442 2px, #18162f 82%, #29203c)',
      'row-active': 'linear-gradient(90deg, #ffb389 0 3px, #393056 3px, #26223f 50%, #322033)',
      'section-rule': 'repeating-linear-gradient(90deg, #ad95cb 0 1px, transparent 1px 6px, #62567e 6px 7px, transparent 7px 12px, #62567e 12px 13px, transparent 13px 18px)',
      'sheet-finish': 'url("/themes/nightly-orbit-chart.svg"), linear-gradient(118deg, #10152cf5, #1b1732f7 65%, #292039fa)',
      'scrollbar-thumb': '#9785b9',
      'control-motion': '180ms cubic-bezier(.2,.65,.25,1)',
    },
  },
  {
    id: 'neo-tokyo',
    name: 'Neo Tokyo',
    blurb: 'Rain on the glass, neon on the river.',
    family: 'artwork',
    bg: '#06060d',
    tint: '#090914',
    text: '#f4f1ff',
    muted: '#c0bad5',
    accent: '#ff599d',
    accent2: '#2fe0ff',
    line: '#e2dcff',
    glass: 0.72,
    backdrop: {
      gradient: 'radial-gradient(60% 70% at 85% 30%, rgba(255, 63, 142, .25), transparent 65%), radial-gradient(50% 60% at 15% 70%, rgba(47, 224, 255, .2), transparent 65%), linear-gradient(180deg, #07071a, #05050a)',
      image: '/themes/neo-tokyo.jpg',
      position: '60% 50%',
      stage: overlay('rain', ['#9feaff', '#ff8cc0', '#ffffff'], { opacity: 0.55, speed: 1 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#f4f1ff', cursor: '#ff3f8e', background: '#05050c', selection: '#4a1a33' },
    immersive: {
      'heading-font': '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", sans-serif',
      'caption-font': '650 11px/1.4 var(--font-mono)',
      'panel-radius': '2px 2px 12px 2px',
      'chrome-finish': 'url("/themes/neo-tokyo-glass.svg"), linear-gradient(108deg, #362038d9, #0f1021cf 35%, #0c1523de 76%, #11364cdb)',
      'panel-edge': 'linear-gradient(90deg, #ff599d 0 18%, #743155 18% 22%, transparent 22% 23%, #37223e 23% 62%, #0f4d67 62% 86%, transparent 86% 87%, #61e5ff 87%)',
      'badge-face': 'linear-gradient(155deg, #74e8ff 0 2px, #17465b 2px, #101729 46%, #381b3b 70%, #963255)',
      'badge-ink': '#c1f7ff',
      imprint: '"芝浦  /  SHIBAURA" / ""',
      'control-finish': 'linear-gradient(180deg, #cffaff59 0 1px, transparent 1px 51%, #0a09200c 52%, #10112412), linear-gradient(107deg, transparent 68%, #caf6ff17 69% 73%, transparent 74%)',
      'control-radius': '2px',
      'focus-outline': '2px solid #87efff',
      selection: '#792052',
      'row-hover': 'linear-gradient(90deg, #64ddf5 0 2px, #123342 2px, #101a29 42%, #191526)',
      'row-active': 'linear-gradient(90deg, #ff599d 0 3px, #381b35 3px, #201526 32%, #101d2a 91%, #17435a)',
      'section-rule': 'linear-gradient(90deg, #a63265 0 14px, transparent 14px 17px, #e05293 17px 21px, transparent 21px 25px, #224657 25px 72%, transparent 72% 73%, #36869b 73%)',
      'sheet-finish': 'linear-gradient(157deg, #311d36f2, #111222f5 32%, #0c1523f5 74%, #173244f2)',
      'scrollbar-thumb': '#6eabbd',
      'control-motion': '110ms cubic-bezier(.16,.85,.24,1)',
    },
  },
  {
    id: 'kyoto-firefly',
    name: 'Kyoto Firefly',
    blurb: 'A mossy temple garden lit by drifting fireflies.',
    family: 'artwork',
    bg: '#04100c',
    tint: '#061510',
    text: '#eef6ef',
    muted: '#a1b8aa',
    accent: '#f3c45a',
    accent2: '#4fd1a1',
    line: '#d7f0e0',
    glass: 0.72,
    backdrop: {
      gradient: 'radial-gradient(70% 70% at 30% 60%, rgba(79, 209, 161, .2), transparent 65%), radial-gradient(40% 40% at 80% 70%, rgba(243, 196, 90, .14), transparent 70%), linear-gradient(180deg, #06140f, #020806)',
      image: '/themes/kyoto-firefly.jpg',
      position: '50% 50%',
      stage: overlay('fireflies', ['#ffd76a', '#c9ff7a', '#ffaa3b'], { opacity: 1, speed: 0.7, blend: 'plus-lighter' }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#eef6ef', cursor: '#f3c45a', background: '#030d09', selection: '#2c3a1e' },
    immersive: {
      'heading-font': 'Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif',
      'caption-font': '600 11px/1.5 Palatino, Georgia, serif',
      'panel-radius': '24px 24px 7px 7px / 13px 13px 7px 7px',
      // Backlit shoji at the edges, falling into dark pond lacquer behind the lettering.
      'chrome-finish':
        'linear-gradient(96deg, transparent, #061710e8 36%, #0a1c16e0 67%, transparent), repeating-linear-gradient(90deg, #0b1511cc 0 2px, #ceac6145 2px 3px, transparent 3px 29px), repeating-linear-gradient(0deg, #101a14c2 0 2px, #b69f6440 2px 3px, transparent 3px 23px), radial-gradient(ellipse at 0 85%, #785126c9, #253729ce 34%, #152c24ed 73%, #3b4930d9)',
      'panel-edge': 'linear-gradient(90deg, #443724, #bc8d49 9%, #ffe29b 15%, #927044 22%, #36493b 44%, #729a75 82%, #b9e7af 88%, #3f5b47)',
      'badge-face':
        'radial-gradient(circle at 78% 20%, #fff3b7 0 1px, #b4d98166 2px, transparent 7px), repeating-radial-gradient(ellipse at 0 110%, transparent 0 7px, #d0b07655 8px, transparent 9px 14px), linear-gradient(145deg, #48533a, #102c23 60%, #071a15)',
      'badge-ink': '#ffe1a0',
      imprint: '"蛍   /   POND PAVILION" / ""',
      'control-finish': 'linear-gradient(180deg, #ffedbf3d 0 1px, transparent 1px 48%, #172a2014 72%, #171b1438), linear-gradient(110deg, #d4b47812, transparent 38%, #69b8970d)',
      'control-radius': '11px 11px 4px 4px / 7px 7px 4px 4px',
      'focus-outline': '2px solid #b7efbf',
      selection: '#305b45',
      'row-hover': 'radial-gradient(circle at 5px 50%, #e4efb1 0 1px, #78aa7355 2px, transparent 6px), linear-gradient(90deg, #2e4736, #12261d 64%)',
      'row-active': 'radial-gradient(circle at 5px 50%, #fff2b7 0 2px, #bd984255 3px, transparent 7px), linear-gradient(90deg, #4b3a23, #243a2d 40%, #12281f)',
      'section-rule': 'linear-gradient(90deg, #ae8854, #d9bc77 11%, #36573f 29%, transparent 70%)',
      'sheet-finish': 'repeating-linear-gradient(178deg, transparent 0 13px, #afae7e09 14px, transparent 15px 19px), radial-gradient(ellipse at 95% 0, #354a38, #162c23 46%, #0b1e17 86%)',
      'scrollbar-thumb': '#92ab83',
      'control-motion': '220ms cubic-bezier(.22,.72,.28,1)',
    },
  },
  {
    id: 'orbital-foundry',
    name: 'Orbital Foundry',
    blurb: 'Heat-blued steel and amber seams on the deck of a ring forge.',
    family: 'artwork',
    bg: '#0a0505',
    tint: '#10131b',
    text: '#fbefea',
    muted: '#c9bab2',
    accent: '#ff803b',
    accent2: '#ffb347',
    line: '#ffd9cc',
    glass: 0.74,
    backdrop: {
      gradient: 'radial-gradient(50% 60% at 55% 45%, rgba(255, 90, 54, .35), transparent 70%), radial-gradient(80% 60% at 50% 100%, rgba(255, 179, 71, .12), transparent 70%), linear-gradient(180deg, #120606, #050202)',
      image: '/themes/orbital-foundry.jpg',
      position: '50% 45%',
      stage: overlay('embers', ['#ff5a36', '#ffb347', '#ffe2a8'], { opacity: 0.85, speed: 1.1 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#fbefea', cursor: '#ff5a36', background: '#080303', selection: '#4a1d14' },
    immersive: {
      'heading-font': '"Avenir Next Condensed", "Arial Narrow", sans-serif',
      'caption-font': 'bold 13px/1.2 "DIN Condensed", "Arial Narrow", sans-serif',
      'panel-radius': '3px',
      'chrome-finish': 'url("/themes/orbital-foundry-plate.svg"), radial-gradient(ellipse at 100% 110%, #804326 0, #422e2d 10%, #222834 35%, transparent 55%), linear-gradient(165deg, #39414c, #202730 26%, #131821 67%, #2d3035)',
      'panel-edge': 'repeating-linear-gradient(90deg, #361e1c 0 3px, #aa522a 3px 6px, #ff913b 6px 13px, #ffe4a0 13px 27px, #f38c3d 27px 35px, #5a3327 35px 38px, #20232a 38px 48px)',
      'badge-face': 'radial-gradient(circle, #171d25 32%, #563c30 34% 40%, #ffbd6f 41% 43%, #a44d22 45% 51%, #20252d 53% 64%, #4d5158 65%, #171d25 70%)',
      'badge-ink': '#ffe6a7',
      imprint: '"RING MILL   /   DIE 07" / ""',
      'control-finish': 'linear-gradient(0deg, #080c145e 0 2px, transparent 2px calc(100% - 2px), #fff1cf40 calc(100% - 2px)), repeating-linear-gradient(90deg, transparent 0 2px, #75818d0d 2px 3px)',
      'control-radius': '2px',
      'focus-outline': '3px dashed #ffcd76',
      selection: '#674023',
      'row-hover': 'linear-gradient(90deg, #e39c51 0 3px, #32323a 3px, #222831 35%, #171e26)',
      'row-active': 'linear-gradient(90deg, #ffe29c 0 2px, #e97930 2px 5px, #201916 5px 8px, #463025 8px, #272b32 55%, #19212a)',
      'section-rule': 'repeating-linear-gradient(90deg, #666e77 0 16px, #171c23 16px 19px, #d28542 19px 21px, #171c23 21px 24px)',
      'sheet-finish': 'url("/themes/orbital-foundry-plate.svg"), linear-gradient(112deg, #323944, #1b232c 36%, #171b22 70%, #392a26)',
      'scrollbar-thumb': '#b58b65',
      'control-motion': '90ms steps(3, end)',
    },
  },
  {
    id: 'abyssal-biolume',
    name: 'Abyssal',
    blurb: 'Sound the trench from the other side of the pressure glass.',
    family: 'artwork',
    bg: '#020b14',
    tint: '#03101c',
    text: '#eaf8fb',
    muted: '#accbd4',
    accent: '#2ee6d6',
    accent2: '#7a6bff',
    line: '#c9f4ff',
    glass: 0.72,
    backdrop: {
      gradient: 'radial-gradient(60% 60% at 30% 40%, rgba(46, 230, 214, .22), transparent 65%), radial-gradient(60% 60% at 80% 70%, rgba(122, 107, 255, .22), transparent 65%), linear-gradient(180deg, #03182a, #01060c)',
      image: '/themes/abyssal-biolume.jpg',
      position: '50% 40%',
      stage: overlay('caustics', ['#2ee6d6', '#7a6bff', '#bafcff'], { opacity: 0.55, speed: 0.7 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#eaf8fb', cursor: '#2ee6d6', background: '#010910', selection: '#0f3a44' },
    immersive: {
      'heading-font': '"Avenir Next", Avenir, "Trebuchet MS", sans-serif',
      'caption-font': '600 10px/1.6 var(--font-mono)',
      'panel-radius': '26px',
      'chrome-finish': 'url("/themes/abyssal-biolume-soundings.svg"), radial-gradient(ellipse at 85% -35%, #604c9c70, transparent 54%), linear-gradient(165deg, #0e3f4de8, #031423ed 56%, #101932e0)',
      'panel-edge': 'linear-gradient(90deg, transparent, #27b5c2 16%, #a6fff0 26%, #277e9d 40%, #47468b 70%, #9b86ff 88%, transparent)',
      'badge-face': 'repeating-radial-gradient(circle at center, transparent 0 6px, #74ebe44a 6.5px 7px, transparent 7.5px 12px), conic-gradient(from 32deg, #133b4b, #073044 58%, #13727a 87%, #4fa9ab 99%, #133b4b)',
      'badge-ink': '#c6fff7',
      imprint: '"HADAL SURVEY   /   6 000 M" / ""',
      'control-finish': 'linear-gradient(180deg, #c9fff445 0 1px, #a3efe113 1px, transparent 48%, #07062c16 77%, #03131f38)',
      'control-radius': '999px',
      'focus-outline': '3px double #9efdf0',
      selection: '#473c74',
      'row-hover': 'radial-gradient(ellipse at 0 50%, #19515c, transparent 64%), linear-gradient(95deg, #0a2636, #10192d)',
      'row-active': 'linear-gradient(90deg, #9af9ee 0 2px, #104956 2px, #10303c 17%, #111c34 72%, #2c2550)',
      'section-rule': 'repeating-linear-gradient(90deg, #71bcb7 0 1px, transparent 1px 8px, #366774 8px 9px, transparent 9px 16px, #366774 16px 17px, transparent 17px 24px)',
      'sheet-finish': 'radial-gradient(ellipse at 0 0, #154554d9, transparent 43%), radial-gradient(ellipse at 100% 100%, #292547db, transparent 56%), linear-gradient(145deg, #061925ed, #051320f2)',
      'scrollbar-thumb': '#6dbcb9',
      'control-motion': '210ms cubic-bezier(.2,.68,.22,1)',
    },
  },
  {
    id: 'astral-cathedral',
    name: 'Astral Cathedral',
    blurb: 'Amethyst vaults and hanging stones tipped with gold.',
    family: 'artwork',
    bg: '#0d0a16',
    tint: '#120e1f',
    text: '#f5f0ff',
    muted: '#cec2da',
    accent: '#f0cb91',
    accent2: '#cc9fff',
    line: '#e6dbff',
    glass: 0.74,
    backdrop: {
      gradient: 'radial-gradient(60% 80% at 50% 30%, rgba(195, 155, 255, .35), transparent 70%), radial-gradient(30% 40% at 50% 60%, rgba(243, 196, 107, .14), transparent 70%), linear-gradient(180deg, #1a1230, #07050d)',
      image: '/themes/astral-cathedral.jpg',
      position: '50% 40%',
      stage: overlay('nebula', ['#c39bff', '#f3c46b', '#ffffff'], { opacity: 0.5, speed: 0.5, blend: 'screen' }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#f5f0ff', cursor: '#f0cb91', background: '#0a0712', selection: '#49355f' },
    immersive: {
      'heading-font': 'Palatino, "Palatino Linotype", Georgia, serif',
      'caption-font': '600 11px/1.5 Georgia, serif',
      'panel-radius': '34% 34% 6px 6px / 24px 24px 6px 6px',
      'chrome-finish': 'linear-gradient(100deg, #21122c70, #21122cd6 48%, #21122c70), url("/themes/astral-cathedral-arcade.svg"), linear-gradient(160deg, #483054ed, #26162ff2 58%, #39223ee6)',
      'panel-edge': 'linear-gradient(90deg, #8561a2, #c584b7 28%, #edc88d 46%, #57385e 49%, #fff0cd 50%, #57385e 51%, #edc88d 54%, #c584b7 72%, #8561a2)',
      'badge-face': 'conic-gradient(from 45deg, #392944, #5b406f 25%, #32203d 25%, #543857 50%, #714e7d 50%, #4b345b 75%, #33233f 75%, #392944)',
      'badge-ink': '#ffe3ad',
      imprint: '"✧  VESPER CHAPEL" / ""',
      'control-finish': 'linear-gradient(180deg, #fff2d438, transparent 34%, #41224e12 78%, #8e604d33), linear-gradient(90deg, #ecc48657 1px, transparent 1px calc(100% - 1px), #ecc48657 1px)',
      'control-radius': '16px 16px 4px 4px / 9px 9px 4px 4px',
      'focus-outline': '3px double #fff0cf',
      selection: '#604272',
      'row-hover': 'radial-gradient(ellipse at left, #51334f, #2b2036 72%)',
      'row-active': 'linear-gradient(90deg, #c39765 0 1px, #26182e 1px 3px, #c39765 3px 4px, #49314e 4px, #302039 65%, #352840)',
      'section-rule': 'linear-gradient(90deg, transparent, #a98571 40%, transparent 48%, #efca8d 50%, transparent 52%, #a98571 60%, transparent)',
      'sheet-finish': 'linear-gradient(105deg, #1f1629ed 20%, #211629f2 65%, #2e1d3866), url("/themes/astral-cathedral-arcade.svg"), linear-gradient(145deg, #38253e, #231529)',
      'scrollbar-thumb': '#bea27c',
      'control-motion': '210ms cubic-bezier(.25,.65,.3,1)',
    },
  },
  {
    id: 'sakura-mist',
    name: 'Sakura Mist',
    blurb: 'Cherry boughs in bloom, plum silk and petals on the wind.',
    family: 'artwork',
    bg: '#1a1117',
    tint: '#22161e',
    text: '#fff4f8',
    muted: '#e4cdd4',
    accent: '#efacc0',
    accent2: '#ffd1e0',
    line: '#ffe0ec',
    glass: 0.84,
    backdrop: {
      gradient: 'radial-gradient(90% 42% at 68% 50%, #ca9cb47d, transparent 75%), linear-gradient(163deg, #48415b, #84536b 51%, #453549 80%, #2c2031)',
      image: '/themes/sakura-mist.jpg',
      position: '50% 50%',
      stage: overlay('petals', ['#f8bbcf', '#ffe4d8', '#da8fac'], { opacity: 0.87, speed: 0.56, blend: 'normal' }),
      veil: 'linear-gradient(175deg, #59314d59, #ad668322 39%, transparent 53%, #452c4b66), radial-gradient(105% 86% at 62% 38%, transparent 44%, #31192a78)',
    },
    terminal: { foreground: '#fff4f8', cursor: '#efacc0', background: '#160e13', selection: '#63374d' },
    immersive: {
      'heading-font': 'Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif',
      'caption-font': 'italic 500 11px/1.5 Georgia, serif',
      'panel-radius': '26px 8px 26px 8px',
      'chrome-finish': 'url("/themes/sakura-mist-sprig.svg"), repeating-linear-gradient(168deg, transparent 0 4px, #f1cbcf08 4px 5px, transparent 5px 9px), linear-gradient(112deg, #372231e8, #503042da 32%, #372335db 62%, #583c4edd)',
      'panel-edge': 'linear-gradient(90deg, transparent 2%, #be8e9f77 14%, #edb5c7 27%, #fff0de 29%, #b3869e 33%, #966b8866 58%, transparent 94%)',
      'badge-face': 'conic-gradient(from 26deg at 35% 28%, #854f67, #533448 15%, #694459 35%, #462e43 55%, #75465f 79%, #a16b80)',
      'badge-ink': '#ffebdc',
      imprint: '"HANAMI   /   花見" / ""',
      'control-finish': 'linear-gradient(164deg, #fcd8d521, transparent 43%, #3c193113 72%, #f5cfcb1f), linear-gradient(180deg, #f8d8d236, transparent 2px)',
      'control-radius': '16px 6px 16px 6px',
      'focus-outline': '3px double #ffe4cd',
      selection: '#713f59',
      'row-hover': 'linear-gradient(105deg, #a97589 0 2px, #4a3142 2px, #3d2939 42%, #312432)',
      'row-active': 'linear-gradient(105deg, #f7c3bf 0 3px, #744e60 3px 5px, #573747 5px, #453042 56%, #53374c)',
      'section-rule': 'radial-gradient(ellipse 10px 2px at 20px 50%, #e5b0b9 58%, transparent 73%), linear-gradient(90deg, transparent 3px, #b482976e 14px, #d0a1ae88 44px, transparent 90%)',
      'sheet-finish': 'url("/themes/sakura-mist-sprig.svg"), repeating-linear-gradient(6deg, transparent 0 6px, #edc4bb06 6px 7px), linear-gradient(128deg, #432c3cef, #291e2bf2 54%, #473345ec)',
      'scrollbar-thumb': '#ba8d9f',
      'control-motion': '270ms cubic-bezier(.22,.64,.3,1)',
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    blurb: 'Northern lights rippling over a polar night.',
    family: 'shader',
    bg: '#030a10',
    tint: '#050f17',
    text: '#ecfaf5',
    muted: '#9bb9b0',
    accent: '#47f0b0',
    accent2: '#8a6bff',
    line: '#cffbea',
    glass: 0.7,
    backdrop: {
      gradient: 'radial-gradient(80% 50% at 50% 0%, rgba(71, 240, 176, .3), transparent 70%), radial-gradient(60% 50% at 80% 20%, rgba(138, 107, 255, .25), transparent 70%), linear-gradient(180deg, #04121c, #010407)',
      stage: scene('aurora', ['#47f0b0', '#2fb8ff', '#8a6bff', '#020812'], { speed: 0.6 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#ecfaf5', cursor: '#47f0b0', background: '#020a0f', selection: '#14423a' },
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    blurb: 'A drafting table at midnight: grid lines and cyan ink.',
    family: 'shader',
    bg: '#041226',
    tint: '#06172e',
    text: '#eaf4ff',
    muted: '#9db5d3',
    accent: '#4cc3ff',
    accent2: '#8fd8ff',
    line: '#cfe8ff',
    glass: 0.72,
    backdrop: {
      gradient: 'radial-gradient(80% 70% at 50% 20%, rgba(76, 195, 255, .2), transparent 70%), linear-gradient(180deg, #082044, #030c1a)',
      stage: scene('grid', ['#4cc3ff', '#8fd8ff', '#0a2a55', '#041226'], { speed: 0.5 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#eaf4ff', cursor: '#4cc3ff', background: '#030e1e', selection: '#143a66' },
  },
  {
    id: 'outrun',
    name: 'Outrun',
    blurb: 'A neon horizon racing toward a chrome sun.',
    family: 'shader',
    bg: '#0b0418',
    tint: '#10061f',
    text: '#fbefff',
    muted: '#c3a8d6',
    accent: '#ff4fd8',
    accent2: '#2de2ff',
    line: '#f4d6ff',
    glass: 0.72,
    backdrop: {
      gradient: 'radial-gradient(60% 40% at 50% 60%, rgba(255, 79, 216, .35), transparent 70%), linear-gradient(180deg, #12052a 0%, #2a0838 55%, #07020f 100%)',
      stage: scene('synthwave', ['#ff4fd8', '#2de2ff', '#ffb347', '#0b0418'], { speed: 0.8 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#fbefff', cursor: '#ff4fd8', background: '#090312', selection: '#4a1450' },
  },
  {
    id: 'solar-silk',
    name: 'Solar Silk',
    blurb: 'Molten silk in Factory orange and magenta.',
    family: 'shader',
    bg: '#0c0507',
    tint: '#12070a',
    text: '#fff1ec',
    muted: '#c9a69c',
    accent: '#ff7a2f',
    accent2: '#ff3d7f',
    line: '#ffdccf',
    glass: 0.72,
    backdrop: {
      gradient: 'radial-gradient(70% 70% at 20% 80%, rgba(255, 122, 47, .4), transparent 70%), radial-gradient(60% 60% at 85% 20%, rgba(255, 61, 127, .3), transparent 70%), linear-gradient(160deg, #1a0709, #060203)',
      stage: scene('silk', ['#ff7a2f', '#ff3d7f', '#6a1fff', '#0c0507'], { speed: 0.5 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#fff1ec', cursor: '#ff7a2f', background: '#0a0405', selection: '#4a1c18' },
  },
  {
    id: 'deep-field',
    name: 'Deep Field',
    blurb: 'Drifting nebulae and a thousand distant suns.',
    family: 'shader',
    bg: '#05040c',
    tint: '#080712',
    text: '#eef0ff',
    muted: '#a4a8c8',
    accent: '#7aa2ff',
    accent2: '#ff7ad9',
    line: '#d6deff',
    glass: 0.7,
    backdrop: {
      gradient: 'radial-gradient(60% 60% at 30% 40%, rgba(122, 162, 255, .25), transparent 70%), radial-gradient(50% 50% at 75% 65%, rgba(255, 122, 217, .2), transparent 70%), linear-gradient(180deg, #080818, #020205)',
      stage: scene('nebula', ['#7aa2ff', '#ff7ad9', '#ffd59a', '#05040c'], { speed: 0.4 }),
      veil: VIGNETTE,
    },
    terminal: { foreground: '#eef0ff', cursor: '#7aa2ff', background: '#04030a', selection: '#262c5a' },
  },
  {
    id: 'velvet',
    name: 'Velvet',
    blurb: 'A still mesh of plum and indigo. No motion, easy on the battery.',
    family: 'gradient',
    bg: '#0b0714',
    tint: '#110b1d',
    text: '#f6f0ff',
    muted: '#b4a8c9',
    accent: '#b98cff',
    accent2: '#ff7ab6',
    line: '#e8dcff',
    glass: 0.7,
    backdrop: {
      gradient:
        'radial-gradient(55% 65% at 15% 20%, rgba(185, 140, 255, .45), transparent 70%), radial-gradient(50% 60% at 85% 30%, rgba(255, 122, 182, .3), transparent 70%), radial-gradient(70% 60% at 60% 100%, rgba(90, 80, 255, .35), transparent 70%), linear-gradient(160deg, #150c26, #07040d)',
      veil: VIGNETTE,
    },
    terminal: { foreground: '#f6f0ff', cursor: '#b98cff', background: '#090611', selection: '#3a2a5c' },
  },
  {
    id: 'glacier',
    name: 'Glacier',
    blurb: 'Cold blue light through polar ice.',
    family: 'gradient',
    bg: '#04101a',
    tint: '#061522',
    text: '#eef8ff',
    muted: '#a0b8c8',
    accent: '#7fd4ff',
    accent2: '#c6f0ff',
    line: '#d6f1ff',
    glass: 0.7,
    backdrop: {
      gradient:
        'radial-gradient(60% 50% at 70% 0%, rgba(198, 240, 255, .35), transparent 70%), radial-gradient(60% 60% at 10% 80%, rgba(60, 140, 220, .35), transparent 70%), conic-gradient(from 200deg at 60% 40%, rgba(127, 212, 255, .12), transparent 30%, rgba(127, 212, 255, .08) 60%, transparent), linear-gradient(180deg, #0b2236, #020910)',
      veil: VIGNETTE,
    },
    terminal: { foreground: '#eef8ff', cursor: '#7fd4ff', background: '#030c14', selection: '#173d55' },
  },
  {
    id: 'dune',
    name: 'Dune',
    blurb: 'Warm sand under a low copper sun.',
    family: 'gradient',
    bg: '#120c07',
    tint: '#18100a',
    text: '#fbf3ea',
    muted: '#c9b49d',
    accent: '#f0a35e',
    accent2: '#e86a3a',
    line: '#ffe8cf',
    glass: 0.74,
    backdrop: {
      gradient: 'radial-gradient(45% 45% at 75% 35%, rgba(240, 163, 94, .55), transparent 70%), radial-gradient(90% 50% at 30% 100%, rgba(232, 106, 58, .35), transparent 70%), linear-gradient(180deg, #2a1709 0%, #160c06 60%, #0a0604 100%)',
      veil: VIGNETTE,
    },
    terminal: { foreground: '#fbf3ea', cursor: '#f0a35e', background: '#0e0905', selection: '#4a3018' },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    blurb: 'A green CRT glow with faint scanlines.',
    family: 'gradient',
    bg: '#020a04',
    tint: '#030e06',
    text: '#d9ffe4',
    muted: '#8fbf9c',
    accent: '#39ff88',
    accent2: '#b6ff5c',
    line: '#c8ffd8',
    glass: 0.78,
    backdrop: {
      gradient: 'radial-gradient(80% 70% at 50% 50%, rgba(57, 255, 136, .16), transparent 75%), linear-gradient(180deg, #041a0a, #010502)',
      veil: 'repeating-linear-gradient(180deg, rgba(0, 0, 0, .22) 0 1px, transparent 1px 3px), radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(0, 0, 0, .7) 100%)',
    },
    terminal: { foreground: '#c8ffd8', cursor: '#39ff88', background: '#010703', selection: '#164a26' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    blurb: 'Monochrome glass with nothing but white for an accent.',
    family: 'gradient',
    bg: '#09090a',
    tint: '#0e0e10',
    text: '#f2f2f2',
    muted: '#a6a6a8',
    accent: '#e9e9ea',
    accent2: '#8a8a90',
    line: '#ffffff',
    glass: 0.72,
    backdrop: {
      gradient: 'radial-gradient(60% 60% at 80% 10%, rgba(255, 255, 255, .1), transparent 70%), radial-gradient(70% 60% at 10% 100%, rgba(255, 255, 255, .06), transparent 70%), linear-gradient(160deg, #18181b, #050506)',
      veil: VIGNETTE,
    },
    terminal: { foreground: '#eeeeee', cursor: '#e9e9ea', background: '#060607', selection: '#3a3a3e' },
  },
] as const satisfies readonly CompanionTheme[];

export type CompanionThemeId = (typeof COMPANION_THEMES)[number]['id'];

export const COMPANION_THEME_IDS: readonly CompanionThemeId[] = COMPANION_THEMES.map((t) => t.id);
export const OG_THEME_ID: CompanionThemeId = 'og';
export const DEFAULT_THEME_ID: CompanionThemeId = 'og';

/** The gallery's copy of a theme's artwork, sized for a card at any pixel ratio (lossless, from the full-resolution file). */
export function themePreview(theme: Pick<CompanionTheme, 'backdrop'>): string | undefined {
  return theme.backdrop.image?.replace(/^\/themes\/([^/]+)\.jpg$/, '/themes/previews/$1.webp');
}

export function companionTheme(id: string | undefined): CompanionTheme {
  return COMPANION_THEMES.find((t) => t.id === id) ?? COMPANION_THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

/** How see-through the glass is: Clear shows more backdrop, Solid none (and blurs nothing). */
export const GLASS_LEVELS = ['clear', 'frosted', 'solid'] as const;
export type GlassLevel = (typeof GLASS_LEVELS)[number];

// ---- Colors ----------------------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** #rgb or #rrggbb as 0–255 channels. */
export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a #rrggbb color: ${hex}`);
  const s = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');
export const toHex = ({ r, g, b }: Rgb) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** `a` moved `t` of the way to `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${round3(Math.min(1, Math.max(0, alpha)))})`;
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const rgbLuminance = ({ r, g, b }: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const ratioOf = (x: number, y: number) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  return rgbLuminance(parseHex(hex));
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  return ratioOf(luminance(a), luminance(b));
}

/** What reads on an accent-filled button: white, or the theme's dark base when the accent is light. */
export function accentInk(theme: Pick<CompanionTheme, 'accent' | 'bg'>): string {
  return contrastRatio('#ffffff', theme.accent) >= contrastRatio(theme.bg, theme.accent) ? '#ffffff' : theme.bg;
}

// ---- CSS -------------------------------------------------------------------------------------------

/** Pane opacity at each glass level, from the theme's own. */
export function glassAlpha(theme: Pick<CompanionTheme, 'glass'>, level: GlassLevel): number {
  if (level === 'solid') return 1;
  return round3(Math.min(1, Math.max(0.3, level === 'clear' ? theme.glass - 0.16 : theme.glass)));
}

/** The header's and the side's opacity: a step clearer than the panes, and the thinnest glass on the page. */
export function chromeAlpha(theme: Pick<CompanionTheme, 'glass'>, level: GlassLevel): number {
  return level === 'solid' ? 1 : round3(Math.max(0.3, glassAlpha(theme, level) - 0.1));
}

/** The strongest shade a picture needs: enough to keep text readable over a white one. */
export const MAX_PICTURE_SHADE = 0.9;

/**
 * The least black veil (0–MAX_PICTURE_SHADE) over a picture whose bright areas are `gray` (0–255)
 * that keeps the theme's text at 7:1 and its secondary text at 4.5:1 on the page's thinnest glass.
 */
export function pictureShade(theme: Pick<CompanionTheme, 'glass' | 'tint' | 'text' | 'muted'>, level: GlassLevel, gray: number): number {
  const alpha = chromeAlpha(theme, level);
  const tint = parseHex(theme.tint);
  const text = luminance(theme.text);
  const muted = luminance(theme.muted);
  const readable = (shade: number) => {
    const v = Math.min(255, Math.max(0, gray)) * (1 - shade) * (1 - alpha);
    const ground = rgbLuminance({ r: tint.r * alpha + v, g: tint.g * alpha + v, b: tint.b * alpha + v });
    return ratioOf(text, ground) >= 7 && ratioOf(muted, ground) >= 4.5;
  };
  if (readable(0)) return 0;
  let lo = 0;
  let hi = MAX_PICTURE_SHADE;
  while (hi - lo > 0.005) {
    const mid = (lo + hi) / 2;
    if (readable(mid)) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi * 100) / 100;
}

/**
 * How bright a picture's bright areas are, as one gray level (0–255): the `quantile` of its pixels'
 * luminance (the 90th percentile by default, 1 for the brightest), from RGBA bytes. Transparent
 * pixels count as the dark base they show.
 */
export function brightGray(pixels: ArrayLike<number>, quantile = 0.9): number {
  const n = Math.floor(pixels.length / 4);
  if (!n) return 0;
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pixels[i * 4 + 3] / 255;
    ys[i] = a * (0.2126 * linear(pixels[i * 4]) + 0.7152 * linear(pixels[i * 4 + 1]) + 0.0722 * linear(pixels[i * 4 + 2]));
  }
  ys.sort();
  const y = ys[Math.min(n - 1, Math.floor(n * quantile))];
  return Math.round(255 * (y <= 0.00304 ? y * 12.92 : 1.055 * y ** (1 / 2.4) - 0.055));
}

/**
 * The custom properties a theme sets on the companion's page. The kit's own tokens (--bg, --text,
 * --accent…) are retinted; `--th-*` are the glass and chrome the themed stylesheet layer reads.
 */
export function companionThemeVars(theme: CompanionTheme, level: GlassLevel = 'frosted'): Record<string, string> {
  const pane = glassAlpha(theme, level);
  const chrome = chromeAlpha(theme, level);
  const ink = accentInk(theme);
  return {
    ...Object.fromEntries(Object.entries(theme.immersive ?? {}).map(([key, value]) => [`--th-${key}`, value])),
    '--bg': theme.bg,
    '--surface': mixHex(theme.bg, theme.text, 0.035),
    '--surface-raised': mixHex(theme.bg, theme.text, 0.06),
    '--surface-hover': mixHex(theme.bg, theme.text, 0.085),
    '--text': theme.text,
    '--text-secondary': theme.muted,
    '--text-tertiary': rgba(theme.text, 0.5),
    '--text-inverse': theme.bg,
    '--border': rgba(theme.line, 0.09),
    '--border-strong': rgba(theme.line, 0.18),
    '--accent': theme.accent,
    '--accent-hover': mixHex(theme.accent, '#ffffff', 0.14),
    '--accent-pressed': mixHex(theme.accent, '#000000', 0.16),
    '--accent-muted': rgba(theme.accent, 0.16),
    '--shadow-window': `0 24px 64px rgba(0, 0, 0, .55), 0 0 0 1px ${rgba(theme.line, 0.05)}`,
    '--th-accent-ink': ink,
    '--th-accent2': theme.accent2,
    '--th-glow': rgba(theme.accent, 0.35),
    '--th-focus': rgba(theme.accent, 0.6),
    '--th-focus-ring': rgba(theme.accent, 0.14),
    '--th-chrome': rgba(theme.tint, chrome),
    '--th-chrome-deep': rgba(mixHex(theme.tint, '#000000', 0.25), Math.min(1, chrome + 0.06)),
    '--th-side': rgba(theme.tint, chrome),
    '--th-pane': rgba(theme.tint, pane),
    '--th-term': rgba(theme.terminal.background, pane),
    '--th-pop': rgba(theme.bg, level === 'solid' ? 1 : 0.94),
    '--th-hover': rgba(theme.text, 0.06),
    '--th-active': rgba(theme.text, 0.09),
    '--th-blur': level === 'solid' ? '0px' : level === 'clear' ? '14px' : '22px',
  };
}

/** The colors the terminal draws with in a theme, over the ANSI palette it keeps. */
export function companionTerminalColors(theme: CompanionTheme): { foreground: string; cursor: string; cursorAccent: string; selectionBackground: string } {
  return { foreground: theme.terminal.foreground, cursor: theme.terminal.cursor, cursorAccent: theme.terminal.background, selectionBackground: theme.terminal.selection };
}
