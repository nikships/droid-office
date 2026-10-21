import { UPLOAD_MAX_BYTES } from '../../shared/decor';
import { store } from '../state';
import { withToken } from '../token';

// A picture chosen from the owner's computer for the walls. The browser shrinks and re-encodes what
// it can draw, so a 40 MB photo goes up as a few MB; what it can't (HEIC in Chrome, TIFF, PSD, RAW,
// PDF) goes up as it is, and the office converts it (see PictureStore in server/decor.ts).

/** What the Finder offers: every image, plus formats macOS opens that browsers don't call images. */
export const PICTURE_ACCEPT = 'image/*,.heic,.heif,.tif,.tiff,.psd,.pdf,.dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.svg,.jxl,.jp2,.tga,.exr';

/** Formats kept as they are when they're already small enough. */
const KEEP = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const KEEP_BYTES = 12 * 1024 * 1024;
/** No wall texture holds more than this (MAX_TEXTURE in world/gallery.ts). */
const MAX_SIDE = 4096;
/** Vector art has no size of its own worth keeping; it's drawn at this many pixels on its longest side. */
const VECTOR_SIDE = 2048;

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

function decode(file: Blob): Promise<HTMLImageElement | null> {
  const src = URL.createObjectURL(file);
  const img = new Image();
  img.src = src;
  return img
    .decode()
    .then(
      () => img,
      () => null,
    )
    .finally(() => URL.revokeObjectURL(src));
}

/** An SVG with no size of its own still has the shape of its viewBox; 0 × 0 when it has neither. */
async function viewBox(file: Blob): Promise<{ w: number; h: number }> {
  const text = await file.text().catch(() => '');
  const m = /<svg[^>]*\sviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i.exec(text);
  const w = Number(m?.[1]);
  const h = Number(m?.[2]);
  return w > 0 && h > 0 ? { w, h } : { w: 0, h: 0 };
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The picture as the office should keep it: the file itself, or a smaller copy the browser drew. */
export async function preparePicture(file: File): Promise<Blob> {
  const vector = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  // An SVG is drawn into pixels rather than kept, so the office only ever serves raster pictures.
  const img = await decode(file);
  if (!img) return file;
  let iw = img.naturalWidth;
  let ih = img.naturalHeight;
  if (vector && !(iw && ih)) ({ w: iw, h: ih } = await viewBox(file));
  if (!vector && iw && ih && KEEP.has(file.type) && file.size <= KEEP_BYTES && Math.max(iw, ih) <= MAX_SIDE) return file;
  const w0 = iw || VECTOR_SIDE;
  const h0 = ih || VECTOR_SIDE;
  const k = vector ? VECTOR_SIDE / Math.max(w0, h0) : Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * k));
  canvas.height = Math.max(1, Math.round(h0 * k));
  const g = canvas.getContext('2d');
  if (!g) return file;
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  // WebP keeps transparency and stays small. A browser that can't write it hands back a PNG.
  let out = await encode(canvas, 'image/webp', 0.92);
  if (out && out.size > KEEP_BYTES) out = await encode(canvas, 'image/jpeg', 0.88);
  return out ?? file;
}

/** Keeps a picture from this computer on the current floor; the reference to hang it by. */
export async function uploadPicture(file: File): Promise<string> {
  const body = await preparePicture(file);
  if (body.size > UPLOAD_MAX_BYTES) throw new Error(`“${file.name}” is ${mb(body.size)}; pictures from your computer can be up to ${mb(UPLOAD_MAX_BYTES)}.`);
  const q = new URLSearchParams({ floor: store.floor ?? '', name: file.name });
  let res: Response;
  try {
    res = await fetch(withToken(`/api/decor/picture?${q}`), { method: 'POST', headers: { 'content-type': body.type || 'application/octet-stream' }, body });
  } catch {
    throw new Error("Couldn't reach the office to keep that picture. Check it's still running and try again.");
  }
  const r = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !r.url) throw new Error(r.error ?? `The office couldn't keep that picture (${res.status})`);
  return r.url;
}

/** Whether a file is one the Finder would offer: an image, or a format macOS opens as one. */
export function isPictureFile(f: File): boolean {
  return f.type.startsWith('image/') || PICTURE_ACCEPT.split(',').some((a) => a.startsWith('.') && f.name.toLowerCase().endsWith(a));
}

/** The first picture file in a drop or a paste, if there is one. */
export function pictureFile(data: DataTransfer | null): File | undefined {
  return data ? [...data.files].find(isPictureFile) : undefined;
}

/** A link dropped from a web page (an image dragged out of another tab), if that's what came. */
export function droppedLink(data: DataTransfer | null): string | undefined {
  const list = data?.getData('text/uri-list') ?? '';
  const first = list.split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  return first?.trim() || undefined;
}
