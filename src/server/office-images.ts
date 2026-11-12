import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DROP_MAX_BYTES, PROMPT_IMAGE_ID, PROMPT_IMAGES_MAX } from '../shared/drops.js';
import type { Card, FileRef } from '../shared/whiteboard.js';
import type { ThreadEntry, ThreadImage } from '../shared/worker-thread.js';
import { dropName, type DropStore, pictureExt, pictureType } from './drops.js';
import { sendResponse } from './office-mcp/node-http.js';
import { DROP_IMAGE_ID, imageSize } from './thread-images.js';
import type { WhiteboardStore } from './whiteboard.js';
import type { CardOut } from './whiteboard-agent.js';

export const OFFICE_IMAGES_PATH = '/office/images';
export const OFFICE_IMAGES_DIR = 'images';
const OFFICE_MCP_WORKER_HEADER = 'x-droid-office-worker-id';

const MAX_STORED_IMAGES = 500;
const MAX_STORED_BYTES = 512 * 1024 * 1024;
/** Allows multipart framing or base64 JSON envelopes around a 25 MB image while bounding memory strictly. */
export const UPLOAD_WIRE_MAX = Math.ceil((DROP_MAX_BYTES * 4) / 3) + 128 * 1024;

export type OfficeImageKind = 'attachment' | 'content' | 'picture' | 'render' | 'thread';

export interface StoredImageMeta {
  id: string;
  name: string;
  mimeType: ThreadImage['type'];
  bytes: number;
  width?: number;
  height?: number;
  cardId?: string;
  ref?: string;
  kind?: OfficeImageKind;
}

export interface OfficeImageRef extends StoredImageMeta {
  url?: string;
}

export interface StoredOfficeImage extends StoredImageMeta {
  body: Buffer;
  ext: string;
  file: string;
}

export interface OfficeImageStoreOptions {
  origin?: () => string | undefined;
  maxCount?: number;
  maxBytes?: number;
}

const IMAGE_KINDS = new Set<string>(['attachment', 'content', 'picture', 'render', 'thread']);
const IMAGE_MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FORBIDDEN_SEGMENTS = new Set(['.git', '.ssh', '.gnupg', '.aws']);

function normalizeOrigin(origin: string | undefined): string | undefined {
  const trimmed = origin?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

function canonicalImageName(rawName: string | undefined, mimeType: ThreadImage['type'], ext: string): string {
  const safe = dropName(rawName?.trim() || 'image', mimeType);
  const stem = safe.replace(/\.[^.]*$/, '') || 'image';
  return `${stem}${ext}`;
}

function safeHeaderFilename(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length && out.length < 200; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f && code !== 0x22 && code !== 0x5c) out += raw[i];
  }
  return out || 'image';
}

export function withImageOrigin(list: readonly StoredImageMeta[] | undefined, origin?: string): OfficeImageRef[] | undefined {
  if (!list?.length) return undefined;
  const base = normalizeOrigin(origin);
  return list.map((img): OfficeImageRef => {
    const { url: _stale, ...rest } = img as OfficeImageRef;
    const validId = PROMPT_IMAGE_ID.test(rest.id);
    return {
      ...rest,
      ...(base && validId ? { url: `${base}${OFFICE_IMAGES_PATH}/${rest.id}` } : {}),
    };
  });
}

function safeRealpath(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

function isWithinRoot(realFile: string, realRoot: string | undefined): boolean {
  if (!realRoot) return false;
  return realFile === realRoot || realFile.startsWith(realRoot + path.sep);
}

/** Rejects sensitive dot-directories and internal `.droid-office` state files outside worktrees, worker drops, or whiteboard blobs. */
function forbiddenWorkerFileReason(realFile: string, workerId: string): string | undefined {
  const parts = realFile.split(path.sep).filter(Boolean);
  for (const seg of parts) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return `Refusing to read image inside ${seg}.`;
  }
  const officeIdx = parts.lastIndexOf('.droid-office');
  if (officeIdx >= 0) {
    const sub = parts[officeIdx + 1];
    const sub2 = parts[officeIdx + 2];
    const allowedWorktree = sub === 'worktrees' && Boolean(sub2);
    const allowedDrop = sub === 'drops' && sub2 === workerId;
    const allowedBlob = sub === 'whiteboard' && sub2 === 'blobs';
    if (!allowedWorktree && !allowedDrop && !allowedBlob) {
      return 'Refusing to read internal .droid-office state files.';
    }
  }
  return undefined;
}

/**
 * Office-wide content-addressed image store (`<officeDataDir>/images/<16-hex-id>/<name>`), shared across
 * Tailnet uploads/downloads, `team_message` / `team_hire` / `office_worker_prompt` attachments, worker
 * reports, and Whiteboard reads.
 */
export class OfficeImageStore {
  private readonly dir: string;
  private originFn?: () => string | undefined;
  private readonly maxCount: number;
  private readonly maxBytes: number;

  constructor(dataDir: string, opts: OfficeImageStoreOptions = {}) {
    this.dir = path.join(dataDir, OFFICE_IMAGES_DIR);
    this.originFn = opts.origin;
    this.maxCount = opts.maxCount ?? MAX_STORED_IMAGES;
    this.maxBytes = opts.maxBytes ?? MAX_STORED_BYTES;
  }

  setOrigin(origin: (() => string | undefined) | undefined): void {
    this.originFn = origin;
  }

  origin(): string | undefined {
    return normalizeOrigin(this.originFn?.());
  }

  urlFor(id: string, originOverride?: string): string | undefined {
    if (!PROMPT_IMAGE_ID.test(id)) return undefined;
    const base = normalizeOrigin(originOverride) ?? this.origin();
    return base ? `${base}${OFFICE_IMAGES_PATH}/${id}` : undefined;
  }

  withUrl(meta: StoredImageMeta, originOverride?: string): OfficeImageRef {
    const { url: _stale, ...rest } = meta as OfficeImageRef;
    const url = this.urlFor(rest.id, originOverride);
    return { ...rest, ...(url ? { url } : {}) };
  }

  withUrls(list: readonly StoredImageMeta[] | undefined, originOverride?: string): OfficeImageRef[] | undefined {
    if (!list?.length) return undefined;
    return list.map((item) => this.withUrl(item, originOverride));
  }

  put(body: Buffer, rawName?: string, extra?: Pick<StoredImageMeta, 'cardId' | 'ref' | 'kind'>): { ok: true; image: StoredImageMeta } | { ok: false; status: number; error: string; code: string } {
    if (!body.length) return { ok: false, status: 400, error: 'Empty image upload.', code: 'bad_argument' };
    if (body.length > DROP_MAX_BYTES) {
      return { ok: false, status: 413, error: `Image exceeds the ${DROP_MAX_BYTES / 1024 / 1024} MB limit.`, code: 'too_large' };
    }
    const mimeType = pictureType(body);
    const ext = pictureExt(body);
    if (!mimeType || !ext) {
      return { ok: false, status: 415, error: 'Only PNG, JPEG, GIF and WebP images are supported.', code: 'unsupported_media_type' };
    }
    const id = createHash('sha256').update(body).digest('hex').slice(0, 16);
    const entryDir = path.join(this.dir, id);
    const name = canonicalImageName(rawName, mimeType, ext);
    const dims = imageSize(body, mimeType);
    const existing = this.get(id);
    if (existing) {
      const now = new Date();
      try {
        utimesSync(existing.file, now, now);
        utimesSync(entryDir, now, now);
      } catch {
        // best-effort touch
      }
      return {
        ok: true,
        image: {
          id,
          name: rawName?.trim() ? name : existing.name,
          mimeType,
          bytes: existing.bytes,
          ...(dims ? dims : {}),
          ...(extra?.cardId ? { cardId: extra.cardId } : {}),
          ...(extra?.ref ? { ref: extra.ref } : {}),
          ...(extra?.kind ? { kind: extra.kind } : {}),
        },
      };
    }
    mkdirSync(entryDir, { recursive: true, mode: 0o700 });
    const dest = path.join(entryDir, name);
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, dest);
    } finally {
      rmSync(tmp, { force: true });
    }
    this.prune(id);
    return {
      ok: true,
      image: {
        id,
        name,
        mimeType,
        bytes: body.length,
        ...(dims ? dims : {}),
        ...(extra?.cardId ? { cardId: extra.cardId } : {}),
        ...(extra?.ref ? { ref: extra.ref } : {}),
        ...(extra?.kind ? { kind: extra.kind } : {}),
      },
    };
  }

  get(id: string): StoredOfficeImage | undefined {
    if (!PROMPT_IMAGE_ID.test(id)) return undefined;
    const entryDir = path.join(this.dir, id);
    try {
      const names = readdirSync(entryDir);
      for (const name of names) {
        if (name.endsWith('.tmp')) continue;
        const file = path.join(entryDir, name);
        const st = lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > DROP_MAX_BYTES) continue;
        const body = readFileSync(file);
        const mimeType = pictureType(body);
        const ext = pictureExt(body);
        if (!mimeType || !ext) continue;
        return {
          id,
          name,
          mimeType,
          bytes: body.length,
          ...imageSize(body, mimeType),
          body,
          ext,
          file,
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  has(id: string): boolean {
    return Boolean(this.get(id));
  }

  private prune(keepId: string): void {
    let entries: Array<{ id: string; dir: string; mtimeMs: number; size: number }> = [];
    try {
      for (const id of readdirSync(this.dir)) {
        if (!PROMPT_IMAGE_ID.test(id)) continue;
        const dir = path.join(this.dir, id);
        let mtimeMs = 0;
        let size = 0;
        try {
          const st = lstatSync(dir);
          if (!st.isDirectory() || st.isSymbolicLink()) continue;
          mtimeMs = st.mtimeMs;
          for (const child of readdirSync(dir)) {
            const cst = lstatSync(path.join(dir, child));
            if (cst.isFile()) {
              size += cst.size;
              if (cst.mtimeMs > mtimeMs) mtimeMs = cst.mtimeMs;
            }
          }
          entries.push({ id, dir, mtimeMs, size });
        } catch {
          // concurrent cleanup
        }
      }
    } catch {
      return;
    }
    let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    if (entries.length <= this.maxCount && totalBytes <= this.maxBytes) return;
    entries = entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let remaining = entries.length;
    for (const entry of entries) {
      if (remaining <= this.maxCount && totalBytes <= this.maxBytes) break;
      if (entry.id === keepId) continue;
      try {
        rmSync(entry.dir, { recursive: true, force: true });
        remaining--;
        totalBytes -= entry.size;
      } catch {
        // already removed
      }
    }
  }

  /** Registers raster images on one Whiteboard card (content files, picture marks, and optional rendered PNG tiles). */
  collectCardImages(whiteboard: WhiteboardStore, card: CardOut | Card, opts?: { pngTiles?: readonly string[]; pngRev?: number }): StoredImageMeta[] {
    const out: StoredImageMeta[] = [];
    const seen = new Set<string>();
    const addBlob = (hash: string, rawName: string, kind: OfficeImageKind, ref: string) => {
      const bytes = whiteboard.readBlob(hash);
      if (!bytes || !pictureType(bytes)) return;
      const stored = this.put(bytes, rawName, { cardId: card.id, kind, ref });
      if (!stored.ok) return;
      const dedupeKey = `${stored.image.id}:${kind}:${ref}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      out.push(stored.image);
    };
    if (card.content) {
      for (const [relPath, fileRef] of Object.entries(card.content.files as Record<string, FileRef>)) {
        addBlob(fileRef.hash, path.basename(relPath) || 'image', 'content', relPath);
      }
    }
    for (const pic of card.pictures) {
      addBlob(pic.file.hash, `${card.id}-${pic.id}`, 'picture', pic.id);
    }
    if (opts?.pngTiles?.length) {
      opts.pngTiles.forEach((base64, idx) => {
        const bytes = Buffer.from(base64, 'base64');
        const ref = `tile-${idx + 1}`;
        const stored = this.put(bytes, `${card.id}-rev${opts.pngRev ?? 0}-${ref}.png`, { cardId: card.id, kind: 'render', ref });
        if (!stored.ok) return;
        const dedupeKey = `${stored.image.id}:render:${ref}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        out.push(stored.image);
      });
    }
    return out;
  }

  /** Registers prompt-drop and session-file images referenced by a `thread.snapshot` page, capped at `PROMPT_IMAGES_MAX`. */
  async collectThreadImages(
    entries: readonly ThreadEntry[],
    loader: {
      dropPicture(name: string): { body: Buffer } | undefined;
      sessionPicture(imageId: string): Promise<{ body: Buffer } | undefined>;
    },
  ): Promise<StoredImageMeta[]> {
    const out: StoredImageMeta[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.images?.length) continue;
      for (const img of entry.images) {
        if (out.length >= PROMPT_IMAGES_MAX || seen.has(img.id)) continue;
        seen.add(img.id);
        const drop = DROP_IMAGE_ID.exec(img.id)?.[1];
        const loaded = drop ? loader.dropPicture(drop) : await loader.sessionPicture(img.id);
        if (!loaded) continue;
        const stored = this.put(loaded.body, drop ?? `thread-${entry.seq}`, { kind: 'thread', ref: img.id });
        if (stored.ok) out.push(stored.image);
      }
    }
    return out;
  }

  /**
   * Resolves worker-supplied `images` (16-hex image IDs, Whiteboard card IDs, or safe local image paths)
   * plus any Whiteboard cards referenced in `text`, capped at `PROMPT_IMAGES_MAX`.
   */
  ingestWorkerReportImages(opts: {
    explicit?: readonly string[];
    text?: string;
    cwd: string;
    floorDir: string;
    workerId: string;
    drops?: Pick<DropStore, 'stagedPicture'>;
    whiteboard?: WhiteboardStore;
  }): { ok: true; images: StoredImageMeta[] } | { ok: false; error: string } {
    const out: StoredImageMeta[] = [];
    const seenIds = new Set<string>();
    const pushUnique = (meta: StoredImageMeta) => {
      if (out.length >= PROMPT_IMAGES_MAX) return;
      const key = `${meta.id}:${meta.cardId ?? ''}:${meta.ref ?? ''}`;
      if (seenIds.has(key)) return;
      seenIds.add(key);
      out.push(meta);
    };

    const allowedRoots = [safeRealpath(opts.cwd), safeRealpath(opts.floorDir), safeRealpath(os.tmpdir())].filter((r): r is string => Boolean(r));
    const boardCards = opts.whiteboard?.board.cards ?? [];
    const cardMap = new Map(boardCards.map((c) => [c.id, c]));

    for (const raw of opts.explicit ?? []) {
      const item = raw.trim();
      if (!item) continue;
      if (out.length >= PROMPT_IMAGES_MAX) {
        return { ok: false, error: `At most ${PROMPT_IMAGES_MAX} images can be attached at once.` };
      }
      if (PROMPT_IMAGE_ID.test(item)) {
        const existing = this.get(item);
        if (existing) {
          pushUnique({
            id: existing.id,
            name: existing.name,
            mimeType: existing.mimeType,
            bytes: existing.bytes,
            ...(existing.width ? { width: existing.width } : {}),
            ...(existing.height ? { height: existing.height } : {}),
            kind: 'attachment',
          });
          continue;
        }
        const staged = opts.drops?.stagedPicture(item);
        if (staged) {
          const saved = this.put(staged.body, `image${staged.ext}`, { kind: 'attachment' });
          if (!saved.ok) return { ok: false, error: saved.error };
          pushUnique(saved.image);
          continue;
        }
        return { ok: false, error: `Unknown image id ${item}. Pass a valid image id, Whiteboard card id, or local image file path.` };
      }

      const card = cardMap.get(item);
      if (card && opts.whiteboard) {
        const cardImgs = this.collectCardImages(opts.whiteboard, card);
        if (!cardImgs.length) {
          return { ok: false, error: `Whiteboard card ${item} contains no PNG, JPEG, GIF or WebP images (use png: true in whiteboard_read to render HTML/Markdown cards).` };
        }
        for (const img of cardImgs) pushUnique(img);
        continue;
      }

      const abs = path.resolve(opts.cwd, item);
      if (!existsSync(abs)) return { ok: false, error: `Image file not found: ${item}` };
      let preStat: ReturnType<typeof statSync>;
      try {
        preStat = statSync(abs);
      } catch {
        return { ok: false, error: `Cannot read image file: ${item}` };
      }
      if (!preStat.isFile()) return { ok: false, error: `Not a regular file: ${item}` };
      if (preStat.size <= 0) return { ok: false, error: `Image file is empty: ${item}` };
      if (preStat.size > DROP_MAX_BYTES) return { ok: false, error: `Image file exceeds ${DROP_MAX_BYTES / 1024 / 1024} MB: ${item}` };
      const real = safeRealpath(abs);
      if (!real || !allowedRoots.some((root) => isWithinRoot(real, root))) {
        return { ok: false, error: `Image path must stay inside your working folder, floor repository, or temp directory: ${item}` };
      }
      const forbidden = forbiddenWorkerFileReason(real, opts.workerId);
      if (forbidden) return { ok: false, error: `${forbidden} (${item})` };
      let body: Buffer;
      let fd: number | undefined;
      try {
        const flags = fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0);
        fd = openSync(real, flags);
        const fst = fstatSync(fd);
        if (!fst.isFile() || fst.dev !== preStat.dev || fst.ino !== preStat.ino) {
          return { ok: false, error: `Cannot read image file: ${item}` };
        }
        if (fst.size <= 0) return { ok: false, error: `Image file is empty: ${item}` };
        if (fst.size > DROP_MAX_BYTES) return { ok: false, error: `Image file exceeds ${DROP_MAX_BYTES / 1024 / 1024} MB: ${item}` };
        body = readFileSync(fd);
      } catch {
        return { ok: false, error: `Cannot read image file: ${item}` };
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // already closed
          }
        }
      }
      const stored = this.put(body, path.basename(abs), { kind: 'attachment' });
      if (!stored.ok) return { ok: false, error: `${stored.error} (${item})` };
      pushUnique(stored.image);
    }

    if (opts.text && opts.whiteboard && out.length < PROMPT_IMAGES_MAX) {
      for (const card of boardCards) {
        if (out.length >= PROMPT_IMAGES_MAX) break;
        const escaped = card.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(opts.text)) continue;
        for (const img of this.collectCardImages(opts.whiteboard, card)) pushUnique(img);
      }
    }

    return { ok: true, images: out };
  }
}

export function restoreStoredImages(raw: unknown): StoredImageMeta[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: StoredImageMeta[] = [];
  for (const entry of raw.slice(0, PROMPT_IMAGES_MAX)) {
    if (!entry || typeof entry !== 'object') continue;
    const x = entry as Record<string, unknown>;
    if (typeof x.id !== 'string' || !PROMPT_IMAGE_ID.test(x.id)) continue;
    if (typeof x.name !== 'string' || !x.name || x.name.length > 256) continue;
    if (typeof x.mimeType !== 'string' || !IMAGE_MIMES.has(x.mimeType)) continue;
    if (typeof x.bytes !== 'number' || !Number.isSafeInteger(x.bytes) || x.bytes <= 0 || x.bytes > DROP_MAX_BYTES) continue;
    const width = typeof x.width === 'number' && Number.isSafeInteger(x.width) && x.width > 0 ? x.width : undefined;
    const height = typeof x.height === 'number' && Number.isSafeInteger(x.height) && x.height > 0 ? x.height : undefined;
    const cardId = typeof x.cardId === 'string' && x.cardId.length <= 64 ? x.cardId : undefined;
    const ref = typeof x.ref === 'string' && x.ref.length <= 256 ? x.ref : undefined;
    const kind = typeof x.kind === 'string' && IMAGE_KINDS.has(x.kind) ? (x.kind as OfficeImageKind) : undefined;
    out.push({
      id: x.id,
      name: x.name,
      mimeType: x.mimeType as ThreadImage['type'],
      bytes: x.bytes,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(cardId ? { cardId } : {}),
      ...(ref ? { ref } : {}),
      ...(kind ? { kind } : {}),
    });
  }
  return out.length ? out : undefined;
}

export function formatImageLines(images: readonly OfficeImageRef[] | undefined, indent = ''): string[] {
  if (!images?.length) return [];
  return [
    `${indent}Images:`,
    ...images.map((img) => {
      const dims = img.width && img.height ? `, ${img.width}×${img.height}` : '';
      const source = img.cardId ? `${img.kind ?? 'card'} ${img.cardId}${img.ref ? `/${img.ref}` : ''}: ` : img.kind && img.kind !== 'attachment' ? `${img.kind}${img.ref ? ` ${img.ref}` : ''}: ` : '';
      const urlPart = img.url ? ` — ${img.url}` : '';
      return `${indent}  ${source}${img.name} (id: ${img.id}, ${img.mimeType}${dims}, ${img.bytes} B)${urlPart}`;
    }),
  ];
}

export type ParsedImageRoute = { kind: 'collection' } | { kind: 'item'; id: string } | { kind: 'invalid_item' };

export function parseImageRoute(pathname: string): ParsedImageRoute | undefined {
  if (pathname === OFFICE_IMAGES_PATH || pathname === `${OFFICE_IMAGES_PATH}/`) return { kind: 'collection' };
  if (!pathname.startsWith(`${OFFICE_IMAGES_PATH}/`)) return undefined;
  const tail = pathname.slice(OFFICE_IMAGES_PATH.length + 1);
  let decoded = tail;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    return { kind: 'invalid_item' };
  }
  return PROMPT_IMAGE_ID.test(decoded) ? { kind: 'item', id: decoded } : { kind: 'invalid_item' };
}

function headerOnlyRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  return new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`), { method: req.method ?? 'GET', headers });
}

function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; body: Buffer } | { ok: false; tooLarge?: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (result: { ok: true; body: Buffer } | { ok: false; tooLarge?: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.resume();
        done({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => done({ ok: true, body: Buffer.concat(chunks, total) }));
    req.once('error', () => done({ ok: false }));
    req.once('aborted', () => done({ ok: false }));
  });
}

function dispositionFileName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header)?.[1];
  if (quoted) return quoted;
  return /filename\s*=\s*([^\s;]+)/i.exec(header)?.[1];
}

async function decodeUploadPayload(rawBody: Buffer, contentType: string, fallbackName: string | undefined): Promise<{ ok: true; bytes: Buffer; name?: string } | { ok: false; status: number; error: string; code: string }> {
  const media = contentType.split(';')[0].trim().toLowerCase();
  if (media === 'multipart/form-data') {
    try {
      const formReq = new Request('http://127.0.0.1/office/images', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: new Uint8Array(rawBody),
      });
      const form = await formReq.formData();
      let picked: File | undefined;
      for (const preferred of ['file', 'image']) {
        const candidate = form.get(preferred);
        if (candidate instanceof File) {
          picked = candidate;
          break;
        }
      }
      if (!picked) {
        for (const value of form.values()) {
          if (value instanceof File) {
            picked = value;
            break;
          }
        }
      }
      if (!picked) return { ok: false, status: 400, error: 'Multipart upload needs a file field (for example -F file=@image.png).', code: 'bad_argument' };
      const bytes = Buffer.from(await picked.arrayBuffer());
      const explicitName = typeof form.get('name') === 'string' ? String(form.get('name')) : undefined;
      return { ok: true, bytes, name: explicitName || picked.name || fallbackName };
    } catch {
      return { ok: false, status: 400, error: 'Malformed multipart/form-data image upload.', code: 'bad_argument' };
    }
  }

  if (media === 'application/json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, status: 400, error: 'Invalid JSON upload body.', code: 'bad_argument' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'JSON upload expects an object with base64 "data" (and optional "name").', code: 'bad_argument' };
    }
    const obj = parsed as Record<string, unknown>;
    const rawData = typeof obj.data === 'string' ? obj.data.trim() : '';
    if (!rawData) return { ok: false, status: 400, error: 'JSON upload requires a non-empty base64 "data" string.', code: 'bad_argument' };
    const stripped = rawData.startsWith('data:') ? rawData.slice(rawData.indexOf(',') + 1).replace(/\s+/g, '') : rawData.replace(/\s+/g, '');
    if (!stripped || stripped.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
      return { ok: false, status: 400, error: 'Invalid base64 image data.', code: 'bad_argument' };
    }
    const bytes = Buffer.from(stripped, 'base64');
    const jsonName = typeof obj.name === 'string' ? obj.name : fallbackName;
    return { ok: true, bytes, name: jsonName };
  }

  return { ok: true, bytes: rawBody, name: fallbackName };
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, workerId?: string, extraHeaders?: Record<string, string>): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(workerId ? { [OFFICE_MCP_WORKER_HEADER]: workerId } : {}),
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Tailnet HTTP image upload (`POST /office/images`) and download (`GET /office/images/:id`), gated by the
 * exact same Tailscale Serve + bearer credential check as `/office/mcp`. Never reads tokens from URLs or logs them.
 */
export async function handleOfficeImages(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    route: ParsedImageRoute;
    images: OfficeImageStore;
    authorize(request: Request): Response | { workerId: string; remoteOrigin?: string };
  },
): Promise<void> {
  const probe = headerOnlyRequest(req);
  const auth = opts.authorize(probe);
  if (auth instanceof Response) {
    req.resume();
    await sendResponse(res, auth);
    return;
  }
  const { workerId, remoteOrigin } = auth;
  const method = req.method ?? 'GET';
  const reqUrl = new URL(probe.url);

  if (method === 'GET' || method === 'HEAD') {
    const queryId = reqUrl.searchParams.get('id')?.trim();
    const id = opts.route.kind === 'item' ? opts.route.id : opts.route.kind === 'collection' && queryId && PROMPT_IMAGE_ID.test(queryId) ? queryId : undefined;
    if (!id) {
      sendJson(res, 404, { error: 'Image not found.', code: 'not_found' }, workerId);
      return;
    }
    const stored = opts.images.get(id);
    if (!stored) {
      sendJson(res, 404, { error: 'Image not found.', code: 'not_found' }, workerId);
      return;
    }
    res.writeHead(200, {
      'content-type': stored.mimeType,
      'content-length': String(stored.body.length),
      'content-disposition': `inline; filename="${safeHeaderFilename(stored.name)}"`,
      'cache-control': 'private, max-age=86400, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      [OFFICE_MCP_WORKER_HEADER]: workerId,
    });
    res.end(method === 'HEAD' ? undefined : stored.body);
    return;
  }

  if (method === 'POST') {
    if (opts.route.kind !== 'collection') {
      req.resume();
      sendJson(res, 405, { error: 'POST uploads go to /office/images.', code: 'method_not_allowed' }, workerId, { allow: 'GET, HEAD' });
      return;
    }
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > UPLOAD_WIRE_MAX) {
      req.resume();
      sendJson(res, 413, { error: `Image exceeds the ${DROP_MAX_BYTES / 1024 / 1024} MB limit.`, code: 'too_large' }, workerId);
      return;
    }
    const read = await readBoundedBody(req, UPLOAD_WIRE_MAX);
    if (!read.ok) {
      if (read.tooLarge) sendJson(res, 413, { error: `Image exceeds the ${DROP_MAX_BYTES / 1024 / 1024} MB limit.`, code: 'too_large' }, workerId);
      else if (!res.headersSent) sendJson(res, 400, { error: 'Upload interrupted or unreadable.', code: 'bad_argument' }, workerId);
      return;
    }
    const headerName = typeof req.headers['x-file-name'] === 'string' ? req.headers['x-file-name'] : dispositionFileName(typeof req.headers['content-disposition'] === 'string' ? req.headers['content-disposition'] : undefined);
    const fallbackName = reqUrl.searchParams.get('name')?.slice(0, 256) || headerName?.slice(0, 256);
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'application/octet-stream';
    const decoded = await decodeUploadPayload(read.body, contentType, fallbackName);
    if (!decoded.ok) {
      sendJson(res, decoded.status, { error: decoded.error, code: decoded.code }, workerId);
      return;
    }
    const stored = opts.images.put(decoded.bytes, decoded.name);
    if (!stored.ok) {
      sendJson(res, stored.status, { error: stored.error, code: stored.code }, workerId);
      return;
    }
    sendJson(res, 200, { ...opts.images.withUrl(stored.image, remoteOrigin) }, workerId);
    return;
  }

  req.resume();
  const allow = opts.route.kind === 'collection' ? 'GET, HEAD, POST' : 'GET, HEAD';
  sendJson(res, 405, { error: 'Method not allowed.', code: 'method_not_allowed' }, workerId, { allow });
}
