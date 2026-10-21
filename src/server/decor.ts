import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_DECOR, checkImageUrl, sanitizePlacement, uploadName, type Decoration } from '../shared/decor.js';

/** The pictures on the office walls, saved in .droid-office/decor.json. */
export class Decor {
  private items: Decoration[] = [];
  private file: string;
  /** The pictures hung from the owner's computer rather than from a link. */
  readonly pictures: PictureStore;
  /** The uploaded pictures on the walls as of the last change. */
  private hung = new Set<string>();

  constructor(dataDir: string, converters?: Converter[]) {
    this.file = path.join(dataDir, 'decor.json');
    this.pictures = new PictureStore(dataDir, converters);
    this.load();
    this.prunePictures();
  }

  list(): Decoration[] {
    return this.items;
  }

  add(input: unknown, by: string): Decoration | string {
    if (this.items.length >= MAX_DECOR) return `The walls are full (${MAX_DECOR} pictures). Take one down first.`;
    const p = sanitizePlacement(input);
    if (typeof p === 'string') return p;
    const gone = this.notKept(p.url);
    if (gone) return gone;
    const d: Decoration = { ...p, id: randomBytes(5).toString('hex'), by, at: Date.now() };
    this.items.push(d);
    this.save();
    this.prunePictures();
    return d;
  }

  /** Changes any part of a picture's placement; what the patch leaves out stays as it was. */
  update(id: string, patch: unknown): Decoration | string {
    const i = this.items.findIndex((d) => d.id === id);
    if (i < 0) return 'Someone already took that picture down';
    const { id: _, by, at, ...placement } = this.items[i];
    const p = sanitizePlacement({ ...placement, ...(patch && typeof patch === 'object' ? patch : {}) });
    if (typeof p === 'string') return p;
    const gone = p.url !== placement.url && this.notKept(p.url);
    if (gone) return gone;
    this.items[i] = { ...p, id, by, at };
    this.save();
    this.prunePictures();
    return this.items[i];
  }

  remove(id: string): Decoration | undefined {
    const i = this.items.findIndex((d) => d.id === id);
    if (i < 0) return undefined;
    const [d] = this.items.splice(i, 1);
    this.save();
    this.prunePictures();
    return d;
  }

  /** Why an uploaded picture can't hang: this floor doesn't keep it (any more). */
  private notKept(url: string): string | undefined {
    const name = uploadName(url);
    return name && !this.pictures.has(name) ? 'That picture is no longer kept on this floor. Choose it from your computer again.' : undefined;
  }

  private prunePictures() {
    const now = new Set(this.items.flatMap((d) => uploadName(d.url) ?? []));
    // A picture just taken down starts its day off the walls now, not from when it went up.
    for (const name of this.hung) if (!now.has(name)) this.pictures.touch(name);
    this.hung = now;
    this.pictures.prune(now);
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Decoration>[];
      for (const s of Array.isArray(saved) ? saved : []) {
        const p = sanitizePlacement(s);
        if (typeof p === 'string' || typeof s.id !== 'string') continue;
        this.items.push({ ...p, id: s.id, by: typeof s.by === 'string' ? s.by : '?', at: typeof s.at === 'number' ? s.at : Date.now() });
      }
    } catch {
      // a broken file just means bare walls
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}

// ---- Pictures from the owner's computer -----------------------------------------------------------
// A picture chosen in the Hang a picture window goes up as its bytes (POST /api/decor/picture). A
// format every browser draws is kept as it is; anything else (HEIC, TIFF, PSD, a camera's RAW, a PDF)
// is converted with what this machine has: sips on a Mac, ImageMagick elsewhere. Each one is kept in
// the floor's .droid-office/pictures/ under the hash of its bytes, so the same picture is kept once.

export type PictureSaved = { url: string } | { status: number; error: string };

/** The formats every browser can draw, by the name ending they're kept under. */
const DRAWABLE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
/** A converted picture never needs more pixels than a wall texture holds. */
const MAX_SIDE = 4096;
/** An upload not on any wall yet (the window still open, or the owner aiming) is kept this long. */
const UNHUNG_MS = 24 * 60 * 60_000;
const CONVERT_MS = 60_000;

/** The name ending a drawable picture is kept under, from its first bytes. */
function drawableExt(b: Buffer): string | undefined {
  const at = (i: number, s: string) => b.subarray(i, i + s.length).toString('latin1') === s;
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(4, 'ftypavif') || at(4, 'ftypavis')) return 'avif';
  return undefined;
}

/** What a converter made of a file: PNG or JPEG bytes, or that it couldn't read it, or that it isn't installed. */
export type Converted = Buffer | 'unreadable' | 'missing';
/** Converts the picture at `input`, writing anything it needs in `dir`. */
export type Converter = (input: string, dir: string) => Promise<Converted>;

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: CONVERT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' }));
  });
}

async function readIf(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch {
    return undefined;
  }
}

/** macOS's own image tool, which reads whatever Preview opens. */
export function sipsConverter(bin = '/usr/bin/sips'): Converter {
  return async (input, dir) => {
    const info = await run(bin, ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', input]);
    if (info.missing) return 'missing';
    const num = (key: string) => Number(new RegExp(`${key}: (\\d+)`).exec(info.out)?.[1] ?? 0);
    const w = num('pixelWidth');
    const h = num('pixelHeight');
    // sips exits 0 for a file it can't read, and says <nil> (or 0 for a broken PDF) instead of a size.
    if (!info.ok || !(w > 0 && h > 0)) return 'unreadable';
    const alpha = /hasAlpha: yes/.test(info.out);
    const out = path.join(dir, alpha ? 'out.png' : 'out.jpg');
    const args = ['-s', 'format', alpha ? 'png' : 'jpeg', ...(alpha ? [] : ['-s', 'formatOptions', '90'])];
    if (Math.max(w, h) > MAX_SIDE) args.push('-Z', String(MAX_SIDE));
    const done = await run(bin, [...args, input, '--out', out]);
    return (done.ok && (await readIf(out))) || 'unreadable';
  };
}

/**
 * The formats ImageMagick is asked to read, by name ending, as the coder it reads them with. Named
 * explicitly so the file's own bytes never pick a coder that runs scripts or delegates (MVG, MSL,
 * SVG, PostScript and PDF through Ghostscript).
 */
const MAGICK_CODERS: Record<string, string> = {
  heic: 'HEIC',
  heif: 'HEIC',
  tif: 'TIFF',
  tiff: 'TIFF',
  psd: 'PSD',
  bmp: 'BMP',
  ico: 'ICO',
  tga: 'TGA',
  jxl: 'JXL',
  jp2: 'JP2',
  exr: 'EXR',
  dng: 'DNG',
  cr2: 'CR2',
  cr3: 'CR3',
  nef: 'NEF',
  arw: 'ARW',
  raf: 'RAF',
  orf: 'ORF',
  rw2: 'RW2',
};
/** Keeps one upload from taking the machine's memory or disk. */
const MAGICK_LIMITS = ['-limit', 'memory', '512MiB', '-limit', 'map', '1GiB', '-limit', 'disk', '2GiB', '-limit', 'area', '256MP'];

/** ImageMagick 7, for machines without sips. The first page or frame, turned the way the camera held it. */
export function magickConverter(bin = 'magick'): Converter {
  return async (input, dir) => {
    const coder = MAGICK_CODERS[path.extname(input).slice(1)];
    if (!coder) return 'unreadable';
    const src = `${coder}:${input}[0]`;
    const probe = await run(bin, [...MAGICK_LIMITS, src, '-format', '%[opaque]', 'info:']);
    if (probe.missing) return 'missing';
    if (!probe.ok) return 'unreadable';
    const opaque = /true/i.test(probe.out);
    const out = path.join(dir, opaque ? 'out.jpg' : 'out.png');
    const done = await run(bin, [...MAGICK_LIMITS, src, '-auto-orient', '-resize', `${MAX_SIDE}x${MAX_SIDE}>`, ...(opaque ? ['-quality', '90'] : []), out]);
    return (done.ok && (await readIf(out))) || 'unreadable';
  };
}

function defaultConverters(): Converter[] {
  return [...(process.platform === 'darwin' && existsSync('/usr/bin/sips') ? [sipsConverter()] : []), magickConverter()];
}

/** The name endings an upload keeps when it's written out for a converter; any other goes without one. */
const CONVERTIBLE = new Set([...Object.keys(MAGICK_CODERS), 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);

/** A name ending safe to give the file a converter reads, from the name the browser sent. */
function safeExt(name: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name.trim())?.[1].toLowerCase();
  return ext && CONVERTIBLE.has(ext) ? `.${ext}` : '';
}
/** The pictures from the owner's computer that hang on one floor's walls. */
export class PictureStore {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private converters: Converter[] = defaultConverters(),
  ) {
    this.dir = path.join(dataDir, 'pictures');
  }

  /** Keeps a picture, converting it first when browsers can't draw it; its `upload:` reference, or why not. */
  async save(body: Buffer, name = ''): Promise<PictureSaved> {
    if (!body.length) return { status: 400, error: 'That file is empty' };
    let ext = drawableExt(body);
    let bytes = body;
    if (!ext) {
      const converted = await this.convert(body, name);
      if ('error' in converted) return converted;
      bytes = converted.body;
      ext = drawableExt(bytes);
      if (!ext) return { status: 415, error: unreadable(name) };
    }
    const file = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const full = path.join(this.dir, file);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      if (existsSync(full)) {
        // Uploaded again: it's wanted, so it starts its time off the walls over.
        const now = new Date();
        await utimes(full, now, now);
      } else await writeFile(full, bytes, { mode: 0o600 });
    } catch {
      return { status: 500, error: "The office couldn't keep that picture on this computer's disk" };
    }
    return { url: `upload:${file}` };
  }

  /** An uploaded picture's bytes and type, by its file name. */
  async read(name: string): Promise<{ type: string; body: Buffer } | undefined> {
    const file = uploadName(`upload:${name}`);
    if (!file) return undefined;
    const body = await readIf(path.join(this.dir, file));
    return body ? { type: DRAWABLE[file.slice(file.lastIndexOf('.') + 1)], body } : undefined;
  }

  /** Whether this floor keeps the picture by this file name. */
  has(name: string): boolean {
    const file = uploadName(`upload:${name}`);
    return !!file && existsSync(path.join(this.dir, file));
  }

  /** Starts a picture's day off the walls over, from now. */
  touch(name: string) {
    const now = new Date();
    try {
      utimesSync(path.join(this.dir, name), now, now);
    } catch {
      // already gone
    }
  }

  /** Deletes the pictures no wall shows any more, once they've been off the walls a day. */
  prune(keep: Set<string>, now = Date.now()) {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (keep.has(n) || !uploadName(`upload:${n}`)) continue;
      const full = path.join(this.dir, n);
      try {
        if (now - statSync(full).mtimeMs > UNHUNG_MS) rmSync(full, { force: true });
      } catch {
        // already gone
      }
    }
  }

  /** Conversions run one at a time: each can take a decoder's worth of memory for up to a minute. */
  private convert(body: Buffer, name: string): Promise<{ body: Buffer } | { status: number; error: string }> {
    const job = this.queue.then(() => this.convertNow(body, name));
    this.queue = job.catch(() => {});
    return job;
  }

  private async convertNow(body: Buffer, name: string): Promise<{ body: Buffer } | { status: number; error: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'droid-office-picture-'));
    try {
      const input = path.join(dir, `in${safeExt(name)}`);
      await writeFile(input, body, { mode: 0o600 });
      let installed = false;
      for (const convert of this.converters) {
        const out = await convert(input, dir).catch((): Converted => 'unreadable');
        if (Buffer.isBuffer(out) && out.length) return { body: out };
        if (out !== 'missing') installed = true;
      }
      return { status: 415, error: installed ? unreadable(name) : noConverter(name) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function fileLabel(name: string): string {
  return name.trim() ? `“${path.basename(name.trim())}”` : 'That file';
}

function unreadable(name: string): string {
  return `${fileLabel(name)} isn't a picture this computer can open. Try a PNG, JPEG, HEIC, GIF, WebP or TIFF.`;
}

function noConverter(name: string): string {
  return `This computer has nothing to convert ${fileLabel(name)} with (on Linux, install ImageMagick 7). Or save it as a PNG or JPEG and choose that.`;
}
// ---- Image proxy ------------------------------------------------------------------------------
// Browsers only let WebGL draw an image from another site when that site sends CORS headers, and
// most don't. So the office fetches pictures itself and serves them from its own origin. It only
// does this for signed-in people, who can already run any command on this machine from a shell
// worker, so fetching a link for them gives them nothing new.

export type ImageResult = { type: string; body: Buffer } | { status: number; error: string };

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const CACHE_BYTES = 96 * 1024 * 1024;
const CACHE_MS = 30 * 60_000;
const TIMEOUT_MS = 12_000;

/** Recognizes common image formats from their first bytes, for hosts that don't say. */
function sniff(b: Buffer): string | undefined {
  const at = (i: number, s: string) => b.subarray(i, i + s.length).toString('latin1') === s;
  if (at(0, '\x89PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(4, 'ftypavif') || at(4, 'ftypavis')) return 'image/avif';
  if (at(0, 'BM')) return 'image/bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = b.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return undefined;
}

export class ImageProxy {
  private cache = new Map<string, { type: string; body: Buffer; at: number }>();
  private bytes = 0;
  private inflight = new Map<string, Promise<ImageResult>>();

  get(raw: string): Promise<ImageResult> {
    const checked = checkImageUrl(raw);
    if ('error' in checked) return Promise.resolve({ status: 400, error: checked.error });
    const url = checked.url;
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      // Most recently used goes to the back, so eviction takes the stalest first.
      this.cache.delete(url);
      this.cache.set(url, hit);
      return Promise.resolve(hit);
    }
    let p = this.inflight.get(url);
    if (!p) {
      p = this.fetch(url).finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return p;
  }

  private async fetch(url: string): Promise<ImageResult> {
    const host = new URL(url).host;
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
          'user-agent': 'Mozilla/5.0 (compatible; droid-office; +https://github.com/nikships/droid-office)',
        },
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (e.name === 'TimeoutError') return { status: 504, error: `${host} took too long to answer` };
      return { status: 502, error: `Couldn't reach ${host}${e.cause?.code ? ` (${e.cause.code})` : ''}` };
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { status: 502, error: `${host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` };
    }
    let type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'text/html' || type === 'application/xhtml+xml') {
      void res.body?.cancel().catch(() => {});
      return { status: 415, error: 'That link is a web page, not an image. Right-click the picture and choose “Copy image address”.' };
    }
    if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      void res.body?.cancel().catch(() => {});
      return { status: 413, error: 'That image is over 15 MB. Try a smaller one.' };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => {});
          return { status: 413, error: 'That image is over 15 MB. Try a smaller one.' };
        }
        chunks.push(Buffer.from(value));
      }
    } catch {
      return { status: 502, error: `${host} stopped sending the image halfway` };
    }
    const body = Buffer.concat(chunks);
    if (!type.startsWith('image/')) {
      const sniffed = sniff(body);
      if (!sniffed) return { status: 415, error: `That link isn't an image${type ? ` (it's ${type})` : ''}` };
      type = sniffed;
    }
    const entry = { type, body, at: Date.now() };
    const old = this.cache.get(url);
    if (old) this.bytes -= old.body.length;
    this.cache.delete(url);
    this.cache.set(url, entry);
    this.bytes += body.length;
    for (const [k, v] of this.cache) {
      if (this.bytes <= CACHE_BYTES) break;
      this.cache.delete(k);
      this.bytes -= v.body.length;
    }
    return entry;
  }
}
