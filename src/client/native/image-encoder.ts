import { base64ToBytes, type TextureFormat } from './wire';

export interface EncodedImage {
  fmt: TextureFormat;
  bytes: Uint8Array;
}

export type ImageEncoder = (source: unknown, width: number, height: number, opaque: boolean) => Promise<EncodedImage>;

export interface EncodeRequest {
  id: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  opaque: boolean;
}

export type EncodeReply = { id: number; fmt: TextureFormat; buffer: ArrayBuffer } | { id: number; error: string };

/**
 * Immediate fallback: WebView can defer canvas.toBlob/convertToBlob on the window for seconds.
 * Keep the compressed PNG/JPEG wire format, but never wait for an idle canvas callback.
 */
export const domImageEncoder: ImageEncoder = async (source, width, height, opaque) => {
  const canvas = typeof HTMLCanvasElement === 'function' && source instanceof HTMLCanvasElement ? source : document.createElement('canvas');
  if (canvas !== source) {
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(source as CanvasImageSource, 0, 0, width, height);
  }
  const url = canvas.toDataURL(opaque ? 'image/jpeg' : 'image/png', 0.92);
  const comma = url.indexOf(',');
  const fmt = url.startsWith('data:image/jpeg;base64,') ? 'jpeg' : url.startsWith('data:image/png;base64,') ? 'png' : null;
  if (!fmt || comma < 0) throw new Error(`could not encode a ${width}x${height} texture`);
  return { fmt, bytes: base64ToBytes(url.slice(comma + 1)) };
};

/** One lazy worker per scene. Snapshot on the window; encode and read the blob off its busy loop. */
export class NativeImageEncoder {
  private worker: Worker | null = null;
  private failed = false;
  private disposed = false;
  private nextId = 0;
  private pending = new Map<number, { resolve: (image: EncodedImage) => void; reject: (error: Error) => void }>();

  readonly encode: ImageEncoder = async (source, width, height, opaque) => {
    if (this.disposed) throw new Error('image encoder disposed');
    if (this.failed || typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return domImageEncoder(source, width, height, opaque);
    const bitmap = await createImageBitmap(source as ImageBitmapSource);
    if (this.disposed) {
      bitmap.close();
      throw new Error('image encoder disposed');
    }
    if (this.failed) {
      bitmap.close();
      return domImageEncoder(source, width, height, opaque);
    }
    try {
      if (!this.worker) {
        const worker = new Worker(new URL('./image-encoder.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }: MessageEvent<EncodeReply>) => {
          const job = this.pending.get(data.id);
          if (!job) return;
          this.pending.delete(data.id);
          if ('error' in data) job.reject(new Error(data.error));
          else job.resolve({ fmt: data.fmt, bytes: new Uint8Array(data.buffer) });
        };
        worker.onerror = worker.onmessageerror = () => {
          this.failed = true;
          this.stop(new Error('image encoding worker failed'));
        };
        this.worker = worker;
      }
    } catch {
      bitmap.close();
      this.failed = true;
      return domImageEncoder(source, width, height, opaque);
    }
    const worker = this.worker;
    return new Promise<EncodedImage>((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, bitmap, width, height, opaque } satisfies EncodeRequest, [bitmap]);
      } catch (error) {
        this.pending.delete(id);
        bitmap.close();
        reject(error);
      }
    });
  };

  dispose() {
    this.disposed = true;
    this.stop(new Error('image encoder disposed'));
  }

  private stop(error: Error) {
    this.worker?.terminate();
    this.worker = null;
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }
}
