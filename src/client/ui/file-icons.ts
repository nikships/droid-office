// File-type and folder icons for the Bookshelf's file tree (ui/file-tree.ts), drawn as 16px SVG the
// way IDE icon themes do: a colored letter badge per language, and outline glyphs for docs, config,
// lock files and folders. `fileIcon` and `folderIcon` are pure lookups; `iconSvg` builds the node.

/** How an icon is drawn: a letter badge, a page, a cog, a padlock, an info dot, braces, or a folder. */
export type IconShape = 'badge' | 'page' | 'cog' | 'lock' | 'info' | 'braces' | 'folder';

export interface FileIcon {
  shape: IconShape;
  /** Fill or stroke color. */
  color: string;
  /** Letters on a badge (1 to 3), or on a page. */
  label?: string;
  /** Dark letters on a light badge. */
  darkText?: boolean;
}

const C = {
  ts: '#3b82d6',
  js: '#e8c547',
  react: '#4fc3e8',
  json: '#e8a33d',
  md: '#6aa8e0',
  css: '#5c8fe0',
  scss: '#d4639a',
  html: '#e4693a',
  py: '#4f8fd1',
  go: '#38b3d6',
  rs: '#d9825b',
  java: '#e0762f',
  kt: '#a77bf3',
  swift: '#f0683b',
  rb: '#d6463c',
  php: '#8892c6',
  c: '#6f8fc9',
  cpp: '#5f88d2',
  cs: '#7a5fc9',
  sh: '#7fbf5e',
  yaml: '#d06c6c',
  toml: '#a0806a',
  sql: '#d7a740',
  vue: '#41b883',
  svelte: '#ff5d2e',
  svg: '#e2a33a',
  xml: '#e07b39',
  docker: '#3d9be0',
  git: '#e8613a',
  lock: '#8c8c8c',
  config: '#9aa1ab',
  env: '#e8c547',
  license: '#d0b346',
  text: '#9a9a9a',
  test: '#3ccf91',
  lua: '#5470d6',
  dart: '#3fb0e0',
  ex: '#8f6bc9',
  hs: '#8e74c4',
  r: '#3a8ad6',
  graphql: '#e535ab',
  proto: '#8aa86a',
  tf: '#7b5fd6',
  gradle: '#5fa877',
  csv: '#5fa877',
} as const;

const badge = (label: string, color: string, darkText = false): FileIcon => ({ shape: 'badge', label, color, ...(darkText ? { darkText } : {}) });

/** By extension (lower case, without the dot). */
const BY_EXT: Record<string, FileIcon> = {
  ts: badge('TS', C.ts),
  mts: badge('TS', C.ts),
  cts: badge('TS', C.ts),
  tsx: badge('TSX', C.react, true),
  js: badge('JS', C.js, true),
  mjs: badge('JS', C.js, true),
  cjs: badge('JS', C.js, true),
  jsx: badge('JSX', C.react, true),
  json: { shape: 'braces', color: C.json },
  jsonc: { shape: 'braces', color: C.json },
  json5: { shape: 'braces', color: C.json },
  md: { shape: 'page', label: 'M', color: C.md },
  markdown: { shape: 'page', label: 'M', color: C.md },
  mdx: { shape: 'page', label: 'MX', color: C.md },
  txt: { shape: 'page', color: C.text },
  rst: { shape: 'page', label: 'R', color: C.text },
  adoc: { shape: 'page', label: 'A', color: C.text },
  css: badge('CSS', C.css),
  scss: badge('S', C.scss),
  sass: badge('S', C.scss),
  less: badge('L', C.css),
  html: badge('<>', C.html),
  htm: badge('<>', C.html),
  vue: badge('V', C.vue),
  svelte: badge('S', C.svelte),
  svg: badge('SVG', C.svg, true),
  xml: badge('<>', C.xml),
  py: badge('PY', C.py),
  pyi: badge('PY', C.py),
  ipynb: badge('NB', C.json, true),
  go: badge('GO', C.go),
  mod: badge('GO', C.go),
  rs: badge('RS', C.rs),
  java: badge('J', C.java),
  kt: badge('K', C.kt),
  kts: badge('K', C.kt),
  gradle: badge('G', C.gradle),
  swift: badge('SW', C.swift),
  m: badge('M', C.c),
  rb: badge('RB', C.rb),
  php: badge('PHP', C.php),
  c: badge('C', C.c),
  h: badge('H', C.c),
  cc: badge('C++', C.cpp),
  cpp: badge('C++', C.cpp),
  hpp: badge('H++', C.cpp),
  cs: badge('C#', C.cs),
  sh: badge('$_', C.sh),
  bash: badge('$_', C.sh),
  zsh: badge('$_', C.sh),
  fish: badge('$_', C.sh),
  ps1: badge('PS', C.cs),
  bat: badge('BAT', C.config),
  yml: badge('YML', C.yaml),
  yaml: badge('YML', C.yaml),
  toml: { shape: 'cog', color: C.toml },
  ini: { shape: 'cog', color: C.config },
  cfg: { shape: 'cog', color: C.config },
  conf: { shape: 'cog', color: C.config },
  properties: { shape: 'cog', color: C.config },
  editorconfig: { shape: 'cog', color: C.config },
  sql: badge('SQL', C.sql, true),
  graphql: badge('GQL', C.graphql),
  gql: badge('GQL', C.graphql),
  proto: badge('PB', C.proto),
  lua: badge('LUA', C.lua),
  dart: badge('DT', C.dart),
  ex: badge('EX', C.ex),
  exs: badge('EX', C.ex),
  hs: badge('HS', C.hs),
  r: badge('R', C.r),
  tf: badge('TF', C.tf),
  csv: badge('CSV', C.csv),
  tsv: badge('TSV', C.csv),
  lock: { shape: 'lock', color: C.lock },
  log: { shape: 'page', label: 'LOG', color: C.text },
  diff: badge('±', C.sh),
  patch: badge('±', C.sh),
  glsl: badge('GL', C.cs),
  wgsl: badge('GL', C.cs),
  vert: badge('GL', C.cs),
  frag: badge('GL', C.cs),
};

/** By whole file name (lower case), checked before the extension. */
const BY_NAME: Record<string, FileIcon> = {
  'package.json': badge('NPM', '#cb3837'),
  'package-lock.json': { shape: 'lock', color: '#cb3837' },
  'yarn.lock': { shape: 'lock', color: '#2c8ebb' },
  'pnpm-lock.yaml': { shape: 'lock', color: '#f69220' },
  'bun.lockb': { shape: 'lock', color: '#f2e0c0' },
  'cargo.lock': { shape: 'lock', color: C.rs },
  'go.sum': { shape: 'lock', color: C.go },
  'gemfile.lock': { shape: 'lock', color: C.rb },
  'poetry.lock': { shape: 'lock', color: C.py },
  'uv.lock': { shape: 'lock', color: C.py },
  'tsconfig.json': { shape: 'cog', color: C.ts },
  'jsconfig.json': { shape: 'cog', color: C.js },
  'biome.json': { shape: 'cog', color: '#60a5fa' },
  'biome.jsonc': { shape: 'cog', color: '#60a5fa' },
  '.gitignore': badge('GIT', C.git),
  '.gitattributes': badge('GIT', C.git),
  '.gitmodules': badge('GIT', C.git),
  '.gitkeep': badge('GIT', C.git),
  '.dockerignore': badge('DK', C.docker),
  dockerfile: badge('DK', C.docker),
  'docker-compose.yml': badge('DK', C.docker),
  'docker-compose.yaml': badge('DK', C.docker),
  'compose.yml': badge('DK', C.docker),
  'compose.yaml': badge('DK', C.docker),
  makefile: { shape: 'cog', color: '#e07b39' },
  'cmakelists.txt': { shape: 'cog', color: '#e07b39' },
  license: { shape: 'page', label: '©', color: C.license },
  'license.md': { shape: 'page', label: '©', color: C.license },
  'license.txt': { shape: 'page', label: '©', color: C.license },
  copying: { shape: 'page', label: '©', color: C.license },
  'agents.md': { shape: 'info', color: '#ee6018' },
  'claude.md': { shape: 'info', color: '#d97757' },
  'readme.md': { shape: 'info', color: C.md },
  readme: { shape: 'info', color: C.md },
  'readme.txt': { shape: 'info', color: C.md },
  'changelog.md': { shape: 'page', label: 'CH', color: C.md },
  '.nvmrc': badge('N', C.sh),
  '.node-version': badge('N', C.sh),
  '.npmrc': badge('NPM', '#cb3837'),
  gemfile: badge('RB', C.rb),
  rakefile: badge('RB', C.rb),
  'go.mod': badge('GO', C.go),
  'cargo.toml': badge('RS', C.rs),
  'pyproject.toml': badge('PY', C.py),
  'requirements.txt': badge('PY', C.py),
  'vite.config.ts': badge('VI', '#a78bfa'),
  'vite.config.js': badge('VI', '#a78bfa'),
  gradlew: { shape: 'cog', color: C.gradle },
  'gradle.properties': { shape: 'cog', color: C.gradle },
  'electron-builder.yml': { shape: 'cog', color: '#47848f' },
};

const TEXT_ICON: FileIcon = { shape: 'page', color: C.text };
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The icon for a project file, by its name, then test files, then its extension. */
export function fileIcon(path: string): FileIcon {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const named = BY_NAME[base];
  if (named) return named;
  if (base.startsWith('.env')) return badge('ENV', C.env, true);
  if (/^dockerfile\./.test(base) || /\.dockerfile$/.test(base)) return badge('DK', C.docker);
  if (TEST_FILE.test(base)) return badge(base.endsWith('x') ? 'TSX' : /\.[cm]?ts$/.test(base) ? 'TS' : 'JS', C.test, true);
  if (/^\.?(eslint|prettier|stylelint|babel|lint-staged|commitlint)/.test(base)) return { shape: 'cog', color: C.config };
  const dot = base.lastIndexOf('.');
  if (dot > 0 || (dot === 0 && base.length > 1)) {
    const byExt = BY_EXT[base.slice(dot + 1)];
    if (byExt) return byExt;
  }
  if (base.startsWith('.')) return { shape: 'cog', color: C.config };
  return TEXT_ICON;
}

/** Folders whose name says what's in them get their own color, as IDE icon themes give them. */
const FOLDER_COLOR: Record<string, string> = {
  src: '#5aa9e6',
  lib: '#5aa9e6',
  app: '#5aa9e6',
  client: '#4fc3e8',
  server: '#a78bfa',
  shared: '#8ea4c8',
  test: '#3ccf91',
  tests: '#3ccf91',
  __tests__: '#3ccf91',
  spec: '#3ccf91',
  e2e: '#3ccf91',
  docs: '#6aa8e0',
  doc: '#6aa8e0',
  '.github': '#9aa1ab',
  '.gitlab': '#e8613a',
  '.vscode': '#3b82d6',
  '.idea': '#ee6018',
  '.agents': '#ee6018',
  '.factory': '#ee6018',
  '.claude': '#d97757',
  scripts: '#7fbf5e',
  bin: '#7fbf5e',
  tools: '#7fbf5e',
  deploy: '#e8a33d',
  infra: '#e8a33d',
  config: '#9aa1ab',
  public: '#3ccf91',
  assets: '#e2a33a',
  images: '#e2a33a',
  build: '#9a9a9a',
  dist: '#9a9a9a',
  android: '#7cc36e',
  ios: '#9aa1ab',
  components: '#4fc3e8',
  ui: '#4fc3e8',
  world: '#e8c547',
  styles: '#d4639a',
};

const FOLDER_DEFAULT = '#c9a26a';

/** The folder icon for `name` (the last segment of a squashed chain counts). */
export function folderIcon(name: string): FileIcon {
  const last = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  return { shape: 'folder', color: FOLDER_COLOR[last] ?? FOLDER_DEFAULT };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function label(text: string, x: number, y: number, size: number, fill: string): SVGElement {
  const t = svgEl('text', { x, y, 'font-size': size, fill, 'text-anchor': 'middle', 'font-weight': 700, 'font-family': 'var(--font-sans)', 'letter-spacing': '-0.02em' });
  t.textContent = text;
  return t;
}

/** A 16px icon node for `icon`; `open` draws a folder open. */
export function iconSvg(icon: FileIcon, open = false): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', width: 16, height: 16, class: 'ft-icon', 'aria-hidden': 'true', focusable: 'false' }) as SVGSVGElement;
  const { color } = icon;
  switch (icon.shape) {
    case 'badge': {
      const text = icon.label ?? '';
      svg.append(svgEl('rect', { x: 1, y: 2.5, width: 14, height: 11, rx: 2.2, fill: color }));
      const size = text.length >= 3 ? 5.6 : text.length === 2 ? 7 : 8.2;
      svg.append(label(text, 8, text.length >= 3 ? 10.2 : 10.7, size, icon.darkText ? '#141414' : '#ffffff'));
      break;
    }
    case 'page': {
      svg.append(svgEl('path', { d: 'M3.5 1.5h6l3 3v10h-9z', fill: 'none', stroke: color, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
      svg.append(svgEl('path', { d: 'M9.5 1.5v3h3', fill: 'none', stroke: color, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
      if (icon.label) svg.append(label(icon.label, 8, 12.2, icon.label.length >= 3 ? 4.4 : icon.label.length === 2 ? 5.2 : 6.6, color));
      else svg.append(svgEl('path', { d: 'M5.5 8h5M5.5 10.2h5M5.5 12.4h3', stroke: color, 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.8 }));
      break;
    }
    case 'cog':
      svg.append(svgEl('circle', { cx: 8, cy: 8, r: 5, fill: 'none', stroke: color, 'stroke-width': 2.4, 'stroke-dasharray': '2.2 1.73' }));
      svg.append(svgEl('circle', { cx: 8, cy: 8, r: 3.6, fill: 'none', stroke: color, 'stroke-width': 1.3 }));
      svg.append(svgEl('circle', { cx: 8, cy: 8, r: 1.2, fill: color }));
      break;
    case 'lock':
      svg.append(svgEl('path', { d: 'M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7', fill: 'none', stroke: color, 'stroke-width': 1.4 }));
      svg.append(svgEl('rect', { x: 3.5, y: 7, width: 9, height: 7, rx: 1.5, fill: color }));
      svg.append(svgEl('circle', { cx: 8, cy: 10.5, r: 1.1, fill: '#141414' }));
      break;
    case 'info':
      svg.append(svgEl('circle', { cx: 8, cy: 8, r: 6.3, fill: color }));
      svg.append(svgEl('circle', { cx: 8, cy: 5, r: 1.05, fill: '#141414' }));
      svg.append(svgEl('rect', { x: 7.1, y: 6.9, width: 1.8, height: 5, rx: 0.6, fill: '#141414' }));
      break;
    case 'braces':
      svg.append(
        svgEl('path', {
          d: 'M5.5 2.5c-1.6 0-2 .7-2 2v1.6c0 1-.5 1.6-1.5 1.9 1 .3 1.5.9 1.5 1.9v1.6c0 1.3.4 2 2 2M10.5 2.5c1.6 0 2 .7 2 2v1.6c0 1 .5 1.6 1.5 1.9-1 .3-1.5.9-1.5 1.9v1.6c0 1.3-.4 2-2 2',
          fill: 'none',
          stroke: color,
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
        }),
      );
      svg.append(svgEl('circle', { cx: 8, cy: 8, r: 1, fill: color }));
      break;
    case 'folder':
      if (open) {
        svg.append(svgEl('path', { d: 'M1.5 12.5v-9a1 1 0 0 1 1-1h3.2l1.5 1.5h5.3a1 1 0 0 1 1 1v1.5', fill: 'none', stroke: color, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
        svg.append(svgEl('path', { d: 'M1.5 12.5l2-6h11.5l-2 6z', fill: color, 'fill-opacity': 0.35, stroke: color, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
      } else {
        svg.append(svgEl('path', { d: 'M1.5 3.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z', fill: color, 'fill-opacity': 0.35, stroke: color, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
      }
      break;
  }
  return svg;
}

/** Small line glyphs for the tree's toolbar and chevrons, in the current text color. */
export type ToolGlyph = 'chevron' | 'collapse' | 'expand' | 'locate' | 'refresh' | 'search' | 'files';

const GLYPH_PATHS: Record<ToolGlyph, string> = {
  chevron: 'M6 4l4 4-4 4',
  collapse: 'M4 3l4 4 4-4M4 13l4-4 4 4',
  expand: 'M4 6l4-4 4 4M4 10l4 4 4-4',
  locate: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3l3.2 3.2',
  files: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3',
};

export function glyph(name: ToolGlyph, cls = 'ft-glyph'): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', width: 16, height: 16, class: cls, 'aria-hidden': 'true', focusable: 'false' }) as SVGSVGElement;
  svg.append(svgEl('path', { d: GLYPH_PATHS[name], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}
