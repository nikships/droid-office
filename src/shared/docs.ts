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
  /** Its uncommitted change in git, when it has one (absent when it's clean or the folder isn't a checkout). */
  git?: DocGitStatus;
}

/** A file's uncommitted change: modified, added (staged new), untracked (new, not staged), renamed, or in conflict. */
export type DocGitStatus = 'M' | 'A' | 'U' | 'R' | 'C';

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

/** A folder node in the bookshelf's file tree. */
export interface DocTreeDir {
  /** What the tree shows: one folder's name, or a chain of single-child folders joined ("src/client/ui"). */
  name: string;
  /** The deepest folder's path from the project folder. */
  path: string;
  dirs: DocTreeDir[];
  files: DocFile[];
  /** Files under this folder, at any depth. */
  count: number;
  /** Files under this folder, at any depth, with an uncommitted change in git. */
  changed: number;
}

/** One line of the file tree as it shows: a folder (open or shut) or a file, and how deep it sits. */
export type DocTreeRow = { kind: 'dir'; dir: DocTreeDir; depth: number; expanded: boolean } | { kind: 'file'; file: DocFile; depth: number };

/** File-manager order: case-insensitive, with numbers by value ("v2" before "v10"). */
export const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Builds a folder tree from `files`, squashing single-child folder chains ("src/client/ui") the way
 * IDEs compact them, with folders before files at each level, both in file-manager order.
 */
export function buildDocTree(files: DocFile[]): DocTreeDir {
  const root: DocTreeDir = { name: '', path: '', dirs: [], files: [], count: 0, changed: 0 };
  const byPath = new Map<string, DocTreeDir>([['', root]]);
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      const p = d.path ? `${d.path}/${part}` : part;
      let next = byPath.get(p);
      if (!next) {
        next = { name: part, path: p, dirs: [], files: [], count: 0, changed: 0 };
        byPath.set(p, next);
        d.dirs.push(next);
      }
      d = next;
    }
    d.files.push(f);
  }
  const squash = (d: DocTreeDir): DocTreeDir => {
    d.dirs = d.dirs.map(squash);
    while (d.dirs.length === 1 && !d.files.length && d.path) {
      const only = d.dirs[0];
      d = { ...only, name: `${d.name}/${only.name}` };
    }
    d.dirs.sort((a, b) => compareNames(a.name, b.name));
    d.files.sort((a, b) => compareNames(baseName(a.path), baseName(b.path)));
    d.count = d.files.length + d.dirs.reduce((sum, sub) => sum + sub.count, 0);
    d.changed = d.files.filter((f) => f.git).length + d.dirs.reduce((sum, sub) => sum + sub.changed, 0);
    return d;
  };
  return squash(root);
}

/** The tree's rows top to bottom, going into a folder only when its path is in `expanded`. */
export function docTreeRows(tree: DocTreeDir, expanded: ReadonlySet<string>): DocTreeRow[] {
  const rows: DocTreeRow[] = [];
  const walk = (d: DocTreeDir, depth: number) => {
    for (const sub of d.dirs) {
      const open = expanded.has(sub.path);
      rows.push({ kind: 'dir', dir: sub, depth, expanded: open });
      if (open) walk(sub, depth + 1);
    }
    for (const file of d.files) rows.push({ kind: 'file', file, depth });
  };
  walk(tree, 0);
  return rows;
}

/** The paths of the tree's folders that hold `path` (a file's or a folder's), outermost first. */
export function docTreeAncestors(tree: DocTreeDir, path: string): string[] {
  const out: string[] = [];
  let d: DocTreeDir | undefined = tree;
  while (d) {
    const next: DocTreeDir | undefined = d.dirs.find((sub) => path === sub.path || path.startsWith(`${sub.path}/`));
    if (!next || next.path === path) break;
    out.push(next.path);
    d = next;
  }
  return out;
}

/** Every folder path at or under `dir`, for expanding or collapsing a whole branch. */
export function docTreeDirPaths(dir: DocTreeDir): string[] {
  const out: string[] = dir.path ? [dir.path] : [];
  for (const sub of dir.dirs) out.push(...docTreeDirPaths(sub));
  return out;
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
