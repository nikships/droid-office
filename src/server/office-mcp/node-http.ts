import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/** The web-standard Request for a Node request, aborted with `signal` when the client goes away. */
export function webRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal, ...(body ? { body, duplex: 'half' } : {}) };
  return new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`), init);
}

/** Writes a web Response to Node, streaming its body (an SSE stream included) until it ends or the client leaves. */
export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  res.flushHeaders();
  const reader = response.body.getReader();
  const gone = () => void reader.cancel().catch(() => undefined);
  res.once('close', gone);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      if (!res.write(value))
        await new Promise<void>((resolve) => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
    }
  } catch {
    // The client left mid-stream, or the stream failed; either way this response is over.
  } finally {
    res.off('close', gone);
    res.end();
  }
}
