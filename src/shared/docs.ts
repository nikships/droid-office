// The bookshelf: the project's Markdown docs and editable text files, listed, searched, read and
// saved by the office (server/docs.ts) and opened in the Bookshelf window (ui/bookshelf.ts).

/** One file on the bookshelf (a Markdown doc or any editable text file in the project). */
export interface DocFile {
  /** From the project folder, with forward slashes: "docs/setup.md" or "src/server/docs.ts". */
  path: string;
  /** Its first heading (or front matter title), when it has one near the top. */
  title?: string;
  size: number;
  /** Last modified, ms since epoch. */
  mtime: number;
}

/** What GET /api/docs answers: the files in the floor's project, by path. */
export interface DocList {
  files: DocFile[];
  /** There were more than the office lists. */
  more: boolean;
}

/** What GET /api/docs/file answers. */
export interface DocText {
  path: string;
  text: string;
  /** Last modified on disk (ms since epoch), passed back on save to catch concurrent edits. */
  mtime: number;
}

/** What PUT /api/docs/file expects in its JSON body. */
export interface DocSaveRequest {
  path: string;
  text: string;
  /** When provided, the server refuses with 409 if the file's mtime on disk no longer matches. */
  baseMtime?: number;
}

/** What PUT /api/docs/file answers after writing the file atomically. */
export interface DocSaveResult {
  path: string;
  size: number;
  mtime: number;
  title?: string;
}

/** One matching line inside a project file from GET /api/docs/search. */
export interface DocSearchMatch {
  /** 1-based line number. */
  line: number;
  /** Snipped line text around the match. */
  text: string;
}

/** One file with content matches from GET /api/docs/search. */
export interface DocSearchHit {
  path: string;
  title?: string;
  matches: DocSearchMatch[];
}

/** What GET /api/docs/search answers. */
export interface DocSearchResults {
  query: string;
  hits: DocSearchHit[];
  more: boolean;
}

/** Extensions that are binary assets rather than editable text files. */
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'tiff',
  'tif',
  'avif',
  'heic',
  'icns',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'aac',
  'm4a',
  'mp4',
  'webm',
  'mov',
  'avi',
  'mkv',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'dmg',
  'pkg',
  'iso',
  'jar',
  'war',
  'apk',
  'aab',
  'exe',
  'dll',
  'so',
  'dylib',
  'a',
  'o',
  'obj',
  'class',
  'pyc',
  'pyo',
  'wasm',
  'node',
  'glb',
  'bin',
  'dat',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'sqlite',
  'sqlite3',
  'db',
  'ds_store',
]);

/** True when `p` is a clean relative path inside the project (no `..`, leading `/`, NUL or runtime state). */
export function isSafeProjectPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  if (/(^|\/)\.\.?(\/|$)/.test(p)) return false;
  if (/(^|\/)\.(git|droid-office)(\/|$)/.test(p)) return false;
  return true;
}

/** A Markdown doc on the bookshelf, by its extension. */
export function isDocPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p) && isSafeProjectPath(p);
}

/** Any text/code file in the project that can be opened and edited on the bookshelf. */
export function isEditablePath(p: string): boolean {
  if (!isSafeProjectPath(p)) return false;
  const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  if (!base || base === '.ds_store') return false;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true;
  const ext = base.slice(dot + 1);
  return !BINARY_EXTENSIONS.has(ext);
}

/** Sniffs the first 8 KB of a file for NUL bytes to keep binary files out of the text editor. */
export function isBinaryBuffer(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** A folder node in the bookshelf's collapsible file tree. */
export interface DocTreeDir {
  name: string;
  path: string;
  dirs: DocTreeDir[];
  files: DocFile[];
  /** Total files under this directory (including nested subdirectories). */
  count: number;
}

/**
 * Builds a folder tree from `files`, squashing single-child directory chains ("src/client/ui")
 * and sorting folders before files at each level.
 */
export function buildDocTree(files: DocFile[]): DocTreeDir {
  const root: DocTreeDir = { name: '', path: '', dirs: [], files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      const p = d.path ? `${d.path}/${part}` : part;
      let next = d.dirs.find((x) => x.name === part && x.path === p);
      if (!next) d.dirs.push((next = { name: part, path: p, dirs: [], files: [], count: 0 }));
      d = next;
    }
    d.files.push(f);
  }
  const squash = (d: DocTreeDir): DocTreeDir => {
    d.dirs = d.dirs.map(squash);
    while (d.dirs.length === 1 && !d.files.length && d.path) {
      const only = d.dirs[0];
      d = { name: `${d.name}/${only.name}`, path: only.path, dirs: only.dirs, files: only.files, count: 0 };
    }
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.path.localeCompare(b.path));
    d.count = d.files.length + d.dirs.reduce((sum, sub) => sum + sub.count, 0);
    return d;
  };
  return squash(root);
}

/** Visible files in tree display order, skipping directories whose path is in `collapsed`. */
export function flattenDocTree(dir: DocTreeDir, collapsed: ReadonlySet<string> = new Set()): DocFile[] {
  if (dir.path && collapsed.has(dir.path)) return [];
  return [...dir.dirs.flatMap((sub) => flattenDocTree(sub, collapsed)), ...dir.files];
}

/**
 * Where a link in the doc at `from` goes in the project, as a path from the project folder, with any
 * #anchor apart: "../README.md#setup" from "docs/a.md" is { path: "README.md", hash: "setup" }. A link
 * starting with / is from the project folder, as on GitHub. Undefined for links elsewhere (another
 * site, mailto:…) or out of the project.
 */
export function resolveDocLink(from: string, href: string): { path: string; hash: string } | undefined {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return undefined;
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt + 1) : '';
  let rel = (hashAt >= 0 ? href.slice(0, hashAt) : href).replace(/\?.*$/, '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  // Just an anchor: somewhere in this same doc.
  if (!rel) return { path: from, hash };
  const parts = rel.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? { path: parts.join('/'), hash } : undefined;
}
