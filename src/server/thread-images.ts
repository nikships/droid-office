import { open } from 'node:fs/promises';
import path from 'node:path';
import { splitImages } from '../shared/drops.js';
import type { ThreadImage } from '../shared/worker-thread.js';
import { DROP_NAME, isDropName, pictureType } from './drops.js';

const TYPES = new Set<ThreadImage['type']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** `<line offset>.<content part>.<tool result part, or x>.<hash of the data>` */
const IMAGE_ID = /^(\d{1,15})\.(\d{1,4})\.(\d{1,4}|x)\.([0-9a-f]{8})$/;
/** No more pictures than this are listed for one tool result or message. */
export const IMAGES_PER_ENTRY = 16;
/** The id of a picture sent with a prompt: `drop.` and its name in the worker's drops. */
export const DROP_IMAGE_ID = new RegExp(`^drop\\.(${DROP_NAME})$`);
/** Enough of a file to find a picture's size in its header, past a large EXIF block. */
const HEADER_BYTES = 256 * 1024;

export interface ImageAddress {
  offset: number;
  part: number;
  /** The picture's place in a tool result's content, or undefined for one directly in the message. */
  sub?: number;
  hash: string;
}

export function imageAddress(id: string): ImageAddress | undefined {
  const m = IMAGE_ID.exec(id);
  if (!m) return undefined;
  return { offset: Number(m[1]), part: Number(m[2]), ...(m[3] === 'x' ? {} : { sub: Number(m[3]) }), hash: m[4] };
}

/** FNV-1a: ties an id to the exact picture, so a rewritten or replaced session file can't serve another one. */
function hash(data: string): string {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/** Whether the bytes are a picture of their declared type. */
export function isImage(bytes: Uint8Array, type: ThreadImage['type']): boolean {
  return pictureType(bytes) === type;
}

/**
 * Whether a JPEG's Exif segment at `at` says to show it a quarter turn round (orientations 5 to 8), as a
 * phone photo taken upright does. Browsers and Android apply it, so the size it shows at is the other way round.
 */
function quarterTurned(bytes: Uint8Array, at: number, segmentEnd: number): boolean {
  const tiff = at + 10;
  const end = Math.min(segmentEnd, bytes.length);
  if (!ascii(bytes, at + 4, 'Exif\0\0')) return false;
  const little = ascii(bytes, tiff, 'II');
  if (!little && !ascii(bytes, tiff, 'MM')) return false;
  const u16 = little ? u16le : u16be;
  const ifd = tiff + (little ? u32le : u32be)(bytes, tiff + 4);
  if (ifd + 2 > end) return false;
  for (let k = 0, n = u16(bytes, ifd); k < n; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return false;
    if (u16(bytes, entry) === 0x0112) return u16(bytes, entry + 8) >= 5 && u16(bytes, entry + 8) <= 8;
  }
  return false;
}

/** The picture's size from its header, without decoding it. */
export function imageSize(bytes: Uint8Array, type: ThreadImage['type']): { width: number; height: number } | undefined {
  let size: { width: number; height: number } | undefined;
  if (type === 'image/png' && ascii(bytes, 12, 'IHDR')) size = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  else if (type === 'image/gif') size = { width: u16le(bytes, 6), height: u16le(bytes, 8) };
  else if (type === 'image/webp') {
    if (ascii(bytes, 12, 'VP8 ')) size = { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    else if (ascii(bytes, 12, 'VP8L')) {
      const [b0, b1, b2, b3] = bytes.subarray(21, 25);
      size = { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    } else if (ascii(bytes, 12, 'VP8X')) size = { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  } else if (type === 'image/jpeg') {
    let turned = false;
    for (let i = 2; i + 9 < bytes.length; ) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      // Every start-of-frame marker except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const [width, height] = [u16be(bytes, i + 7), u16be(bytes, i + 5)];
        size = turned ? { width: height, height: width } : { width, height };
        break;
      }
      if (marker === 0xe1 && !turned) turned = quarterTurned(bytes, i, i + 2 + u16be(bytes, i + 2));
      i += 2 + u16be(bytes, i + 2);
    }
  }
  return size && size.width > 0 && size.height > 0 && size.width <= 65_535 && size.height <= 65_535 ? size : undefined;
}

/**
 * The reference for a picture kept for this worker's prompt at `file`, read from its header; undefined when
 * it is gone, isn't a picture, or is anywhere but the worker's own `drops` folder (the only place its pictures are served from).
 */
async function dropImage(file: string, drops: string): Promise<ThreadImage | undefined> {
  const name = path.basename(file);
  if (!path.isAbsolute(file) || path.dirname(path.resolve(file)) !== path.resolve(drops) || !isDropName(name)) return undefined;
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const bytes = Buffer.alloc(HEADER_BYTES);
    const head = bytes.subarray(0, (await handle.read(bytes, 0, HEADER_BYTES, 0)).bytesRead);
    const type = pictureType(head);
    return type ? { id: `drop.${name}`, type, ...imageSize(head, type) } : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * A prompt the office sent with pictures (withImages in shared/drops.ts), for the worker whose kept files
 * are in `drops`: its own text, and the pictures in place of the paths listed after it. Undefined unless
 * every one is still kept, so the numbers the owner wrote ("image 2") always match what they see.
 */
export async function promptPictures(text: string, drops: string | undefined): Promise<{ text: string; images: ThreadImage[] } | undefined> {
  const split = splitImages(text);
  if (!split || !drops || split.paths.length > IMAGES_PER_ENTRY) return undefined;
  const images = await Promise.all(split.paths.map((file) => dropImage(file, drops)));
  return images.every((image) => !!image) ? { text: split.text, images: images as ThreadImage[] } : undefined;
}

interface Picture {
  type: ThreadImage['type'];
  data: string;
}

/** A content part that is an inline picture of a type a browser shows, or undefined. */
function picture(value: unknown): Picture | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const part = value as Record<string, unknown>;
  const source = part.source && typeof part.source === 'object' ? (part.source as Record<string, unknown>) : {};
  const type = source.media_type as ThreadImage['type'];
  if (part.type !== 'image' || source.type !== 'base64' || !TYPES.has(type) || typeof source.data !== 'string' || !BASE64.test(source.data)) return undefined;
  return { type, data: source.data };
}

/** The reference a thread entry carries for a picture at `at` (`<offset>.<part>.<sub or x>`), or undefined when it isn't one. */
export function imageRef(value: unknown, at: string): ThreadImage | undefined {
  const found = picture(value);
  if (!found) return undefined;
  const bytes = Buffer.from(found.data, 'base64');
  if (!isImage(bytes, found.type)) return undefined;
  return { id: `${at}.${hash(found.data)}`, type: found.type, ...imageSize(bytes, found.type) };
}

/** The picture a session record holds at `address`, when it is still the one its id was made from. */
export function imageAt(record: unknown, address: ImageAddress): { type: ThreadImage['type']; body: Buffer } | undefined {
  const row = record && typeof record === 'object' ? (record as Record<string, unknown>) : {};
  const message = row.message && typeof row.message === 'object' ? (row.message as Record<string, unknown>) : {};
  if (row.type !== 'message' || !Array.isArray(message.content)) return undefined;
  let value: unknown = message.content[address.part];
  if (address.sub !== undefined) {
    const result = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    if (result.type !== 'tool_result' || !Array.isArray(result.content)) return undefined;
    value = result.content[address.sub];
  }
  const found = picture(value);
  if (!found || hash(found.data) !== address.hash) return undefined;
  const body = Buffer.from(found.data, 'base64');
  return isImage(body, found.type) ? { type: found.type, body } : undefined;
}
