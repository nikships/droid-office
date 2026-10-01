import type { EncodeReply, EncodeRequest } from './image-encoder';

const scope = self as unknown as Pick<Worker, 'onmessage' | 'postMessage'>;
scope.onmessage = async ({ data }: MessageEvent<EncodeRequest>) => {
  const { id, bitmap, width, height, opaque } = data;
  try {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: opaque ? 'image/jpeg' : 'image/png', quality: 0.92 });
    const buffer = await blob.arrayBuffer();
    scope.postMessage({ id, fmt: blob.type === 'image/jpeg' ? 'jpeg' : 'png', buffer } satisfies EncodeReply, [buffer]);
  } catch (error) {
    bitmap.close();
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies EncodeReply);
  }
};
