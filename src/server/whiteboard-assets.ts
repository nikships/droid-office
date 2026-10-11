// What a Whiteboard card's content is made of when it comes from files on this machine
// (docs/whiteboard.md, "Content, assets and links"): a page and the local files it references, a whole
// folder package, an image, or a picture for a mark. Everything is read into memory as blobs keyed by
// sha256, ready for the store to write; nothing here writes.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { MAX_ASSET_BYTES, MAX_CARD_BYTES, MAX_FILES_PER_CARD, MAX_HTML_BYTES, type PICTURE_MIMES, isContentPath, type CardContent, type FileRef } from '../shared/whiteboard.js';

/** Content types by extension, for card files. Anything else is served as bytes. */
const MIMES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

export function mimeOf(file: string): string {
  return MIMES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A file's bytes as a board file. */
export function fileRef(bytes: Buffer, mime: string): FileRef {
  return { hash: sha256(bytes), size: bytes.length, mime };
}

/** Why some files couldn't be made into a card: the message says what to do. */
export class LoadError extends Error {}

/** Content read from files, with its blobs, and what to watch for a link. */
export interface Loaded {
  content: CardContent;
  blobs: Map<string, Buffer>;
  /** The folder the content's paths are relative to. */
  root: string;
  /** Every file read (absolute), for a link's watcher. */
  files: string[];
}

const KB = 1024;
const MB = 1024 * KB;
function bytes(n: number): string {
  if (n >= MB) return `${Math.round((n / MB) * 10) / 10} MB`;
  if (n >= KB) return `${Math.round((n / KB) * 10) / 10} KB`;
  return `${n} bytes`;
}

// ---- References in markup and CSS ----

/** Attributes that load a file, by tag; `*` applies to every tag. */
const LOADING_ATTRS: Record<string, string[]> = {
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  script: ['src'],
  link: ['href'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  embed: ['src'],
  object: ['data'],
  input: ['src'],
  iframe: ['src'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
};

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The relative file references in an HTML document: what its tags load, and url()s in its CSS. */
export function htmlReferences(html: string): string[] {
  const out: string[] = [];
  const styles: string[] = [];
  // Inline scripts and comments hold no tags the page loads; style blocks are CSS.
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1')
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_all, css: string) => {
      styles.push(css);
      return '';
    });
  for (const m of markup.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
    const tag = m[1].toLowerCase();
    const wanted = LOADING_ATTRS[tag] ?? [];
    for (const a of m[2].matchAll(ATTR)) {
      const name = a[1].toLowerCase();
      const value = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      if (name === 'style') styles.push(value);
      else if (!wanted.includes(name)) continue;
      else if (name === 'srcset') out.push(...srcset(value));
      else out.push(value);
    }
  }
  for (const css of styles) out.push(...cssReferences(css));
  return out;
}

/** url()s and @imports in CSS. */
export function cssReferences(css: string): string[] {
  const out: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) out.push(m[1]);
  return out;
}

function srcset(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|apos|#39|lt|gt);/g, (_all, e: string) => ({ amp: '&', quot: '"', apos: "'", '#39': "'", lt: '<', gt: '>' })[e] ?? '');
}

/** A reference that points at a file of the page's own, as a decoded relative path; undefined for remote, inline or templated ones. */
function localRef(ref: string): { path: string } | { skip: true } | { outside: string } {
  const r = ref.trim();
  if (!r || r.startsWith('#') || r.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(r) || /\$\{|\{\{|<%/.test(r)) return { skip: true };
  const bare = r.split(/[?#]/)[0];
  if (!bare) return { skip: true };
  if (bare.startsWith('/')) return { outside: 'starts at the site root; write it relative to the page' };
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // keep it as written
  }
  return { path: decoded };
}

// ---- Loading ----

/** Collects files into one card's content while keeping to the per-card limits. */
class Collector {
  readonly files: Record<string, FileRef> = {};
  readonly blobs = new Map<string, Buffer>();
  readonly read: string[] = [];
  readonly missing = new Map<string, string>();
  private total = 0;
  private readonly realRoot: string;

  constructor(readonly root: string) {
    this.realRoot = realpathSync(root);
  }

  /** Adds a file by its path inside the root; why not, if it can't be. */
  add(rel: string, abs: string, limit: number, what: string): string | undefined {
    if (Object.hasOwn(this.files, rel)) return undefined;
    if (!isContentPath(rel)) return 'its path is not a plain relative path inside the folder';
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      return 'not found';
    }
    if (!st.isFile()) return 'not a file';
    const real = realpathSync(abs);
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) return 'a link to a file outside the folder';
    if (st.size > limit) return `${bytes(st.size)}, over the ${bytes(limit)} limit per ${what}`;
    if (Object.keys(this.files).length >= MAX_FILES_PER_CARD) return `over the ${MAX_FILES_PER_CARD} files a card holds`;
    const body = readFileSync(abs);
    const ref = fileRef(body, mimeOf(abs));
    if (!this.blobs.has(ref.hash)) {
      if (this.total + body.length > MAX_CARD_BYTES) return `over the ${bytes(MAX_CARD_BYTES)} a card holds`;
      this.total += body.length;
      this.blobs.set(ref.hash, body);
    }
    this.files[rel] = ref;
    this.read.push(abs);
    return undefined;
  }

  /** Follows a page's or stylesheet's references to files in the folder, collecting each once. */
  crawl(rel: string) {
    const queue = [rel];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const ref = this.files[cur];
      if (!ref) continue;
      const text = this.blobs.get(ref.hash)?.toString('utf8') ?? '';
      const refs = /^text\/html\b/.test(ref.mime) ? htmlReferences(text) : /^text\/css\b/.test(ref.mime) ? cssReferences(text) : [];
      for (const raw of refs) {
        const local = localRef(raw);
        if ('skip' in local) continue;
        if ('outside' in local) {
          this.miss(raw, local.outside);
          continue;
        }
        const abs = path.resolve(this.root, path.dirname(cur), local.path);
        const inside = path.relative(this.root, abs);
        if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
          this.miss(raw, "outside the page's folder");
          continue;
        }
        const relPath = inside.split(path.sep).join('/');
        const why = this.add(relPath, abs, MAX_ASSET_BYTES, 'file');
        if (why) this.miss(raw, why);
        else queue.push(relPath);
      }
    }
  }

  miss(ref: string, reason: string) {
    if (this.missing.size < 500 && !this.missing.has(ref)) this.missing.set(ref.slice(0, 2000), reason);
  }

  done(entry: string): Loaded {
    const content: CardContent = { entry, files: this.files };
    if (this.missing.size) content.missing = [...this.missing].map(([ref, reason]) => ({ ref, reason }));
    return { content, blobs: this.blobs, root: this.root, files: this.read };
  }
}

function checkPage(file: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch {
    throw new LoadError(`${file} doesn't exist`);
  }
  if (!st.isFile()) throw new LoadError(`${file} is not a file`);
  if (st.size > MAX_HTML_BYTES) throw new LoadError(`${file} is ${bytes(st.size)}; the limit for a card's HTML is ${bytes(MAX_HTML_BYTES)}`);
}

/**
 * A page and the local files it references in markup and CSS, inside its own folder, with what
 * couldn't be collected in `content.missing`. The page is served from that folder, so it needs no
 * rewriting.
 */
export function loadPage(file: string): Loaded {
  const abs = path.resolve(file);
  checkPage(abs);
  const root = path.dirname(abs);
  const c = new Collector(root);
  const entry = path.basename(abs);
  if (!isContentPath(entry)) throw new LoadError(`${entry} can't be a card's page name`);
  const body = readFileSync(abs);
  const ref = { hash: sha256(body), size: body.length, mime: 'text/html; charset=utf-8' };
  c.files[entry] = ref;
  c.blobs.set(ref.hash, body);
  c.read.push(abs);
  c.crawl(entry);
  return c.done(entry);
}

/**
 * A whole folder as one card, for pages that load files at run time (ES module imports, fetch): every
 * file in it except hidden ones and node_modules, with `entry` (index.html by default) as its page.
 * Over a limit, the whole package is refused.
 */
export function loadPackage(dir: string, entry = 'index.html'): Loaded {
  const root = path.resolve(dir);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(root);
  } catch {
    throw new LoadError(`${dir} doesn't exist`);
  }
  if (!st.isDirectory()) throw new LoadError(`${dir} is not a folder; push a single page with --file`);
  const entryPath = entry.split(/[\\/]/).join('/');
  if (!isContentPath(entryPath)) throw new LoadError(`--entry ${entry} must be a path inside the folder`);
  checkPage(path.join(root, entryPath));
  const c = new Collector(root);
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(root, rel)).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = path.join(root, childRel);
      const ls = lstatSync(abs);
      if (ls.isDirectory()) walk(childRel);
      else if (ls.isFile() || ls.isSymbolicLink()) {
        const why = c.add(childRel, abs, childRel === entryPath ? MAX_HTML_BYTES : MAX_ASSET_BYTES, 'file');
        if (why && why !== 'not a file') throw new LoadError(`${childRel} in ${dir} is ${why}. Make the folder smaller, or push one page with --file.`);
      }
    }
  };
  walk('');
  const page = c.files[entryPath];
  if (!page) throw new LoadError(`${dir} has no ${entryPath}; name its page with --entry`);
  c.files[entryPath] = { ...page, mime: 'text/html; charset=utf-8' };
  // Report references the package can't satisfy (outside it, or missing); nothing more is collected.
  const known = new Set(Object.keys(c.files));
  for (const [rel, ref] of Object.entries(c.files)) {
    const text = /^text\/(html|css)\b/.test(ref.mime) ? (c.blobs.get(ref.hash)?.toString('utf8') ?? '') : '';
    if (!text) continue;
    for (const raw of /^text\/html\b/.test(ref.mime) ? htmlReferences(text) : cssReferences(text)) {
      const local = localRef(raw);
      if ('skip' in local) continue;
      if ('outside' in local) c.miss(raw, local.outside);
      else {
        const inside = path.posix.normalize(path.posix.join(path.posix.dirname(rel), local.path));
        if (inside.startsWith('..')) c.miss(raw, "outside the package's folder");
        else if (!known.has(inside)) c.miss(raw, 'not found in the folder');
      }
    }
  }
  return c.done(entryPath);
}

/** The picture formats a mark takes, by their first bytes. */
export function pictureMime(b: Buffer): (typeof PICTURE_MIMES)[number] | undefined {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** A PNG, JPEG, GIF or WebP's pixel size, when its header says. */
export function imageSize(b: Buffer): { w: number; h: number } | undefined {
  const mime = pictureMime(b);
  try {
    if (mime === 'image/png' && b.length >= 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (mime === 'image/gif' && b.length >= 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (mime === 'image/webp' && b.length >= 30) {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A picture file for a mark: PNG, JPEG, WebP or GIF, by its bytes. */
export function loadPicture(file: string): { ref: FileRef; bytes: Buffer; size?: { w: number; h: number } } {
  const abs = path.resolve(file);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new LoadError(`${file} doesn't exist`);
  }
  if (!st.isFile()) throw new LoadError(`${file} is not a file`);
  if (st.size > MAX_ASSET_BYTES) throw new LoadError(`${file} is ${bytes(st.size)}; the limit for a picture is ${bytes(MAX_ASSET_BYTES)}`);
  const body = readFileSync(abs);
  const mime = pictureMime(body);
  if (!mime) throw new LoadError(`${file} isn't a PNG, JPEG, WebP or GIF picture`);
  return { ref: fileRef(body, mime), bytes: body, size: imageSize(body) };
}

/** An image as an html card: a generated page that shows it, with the image as its one asset. */
export function loadImageCard(file: string, title: string): Loaded {
  const pic = loadPicture(file);
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[pic.ref.mime as (typeof PICTURE_MIMES)[number]];
  const name = `image.${ext}`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
  const html = Buffer.from(
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<style>html,body{margin:0;background:#fff}img{display:block;max-width:100%;height:auto;margin:0 auto}</style>\n</head>\n<body>\n<img data-wb-id="image" src="${name}" alt="${esc(title)}"${pic.size ? ` width="${pic.size.w}" height="${pic.size.h}"` : ''}>\n</body>\n</html>\n`,
  );
  const page = fileRef(html, 'text/html; charset=utf-8');
  const blobs = new Map([
    [page.hash, html],
    [pic.ref.hash, pic.bytes],
  ]);
  return { content: { entry: 'index.html', files: { 'index.html': page, [name]: pic.ref } }, blobs, root: path.dirname(path.resolve(file)), files: [path.resolve(file)] };
}

/** HTML given as text (stdin), with no assets. */
export function pageFromText(html: string): Loaded {
  const body = Buffer.from(html, 'utf8');
  if (body.length > MAX_HTML_BYTES) throw new LoadError(`The HTML is ${bytes(body.length)}; the limit for a card's HTML is ${bytes(MAX_HTML_BYTES)}`);
  if (!html.trim()) throw new LoadError('The HTML is empty');
  const ref = fileRef(body, 'text/html; charset=utf-8');
  return { content: { entry: 'index.html', files: { 'index.html': ref } }, blobs: new Map([[ref.hash, body]]), root: '', files: [] };
}
