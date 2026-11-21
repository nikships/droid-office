import type http from 'node:http';
import { createReadStream, readFileSync, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { HotReload } from '../hot-reload.js';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);
const MIN_COMPRESS_BYTES = 512;
const MAX_CACHED_COMPRESSED = 256;

function negotiateEncoding(req?: http.IncomingMessage): 'br' | 'gzip' | null {
  if (!req || req.method === 'HEAD') return null;
  const raw = req.headers['accept-encoding'];
  const accept = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  if (!accept) return null;
  if (/\bbr\b(?:\s*;\s*q=(?!0(?:\.0+)?\b)[0-9.]+|(?!\s*;\s*q=))/.test(accept)) return 'br';
  if (/\bgzip\b(?:\s*;\s*q=(?!0(?:\.0+)?\b)[0-9.]+|(?!\s*;\s*q=))/.test(accept)) return 'gzip';
  return null;
}

function compressBuffer(body: Buffer, encoding: 'br' | 'gzip'): Promise<Buffer> {
  if (encoding === 'br') {
    return brotliAsync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } });
  }
  return gzipAsync(body, { level: 6 });
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

export function createStaticFiles(hotReload: HotReload) {
  const immutableCompressed = new Map<string, Promise<Buffer>>();

  /**
   * `immutable` is only for content-hashed names. `revalidate` is for files whose name stays put while
   * their bytes change between releases: the browser keeps them but asks each load, and gets a 304.
   */
  const serveFile = (res: http.ServerResponse, file: string, cache: boolean | 'revalidate', req?: http.IncomingMessage) => {
    const ext = path.extname(file);
    const compressible = COMPRESSIBLE.has(ext);
    const headers: http.OutgoingHttpHeaders = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': cache === 'revalidate' ? 'no-cache' : cache ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...(compressible ? { vary: 'Accept-Encoding' } : {}),
    };
    let st: Stats | undefined;
    if (cache === 'revalidate' || compressible) {
      try {
        st = statSync(file);
      } catch {
        // Let createReadStream handle missing/unreadable files below.
      }
    }
    if (cache === 'revalidate' && st) {
      headers.etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      if (req?.headers['if-none-match'] === headers.etag) {
        res.writeHead(304, headers).end();
        return;
      }
    }
    const encoding = compressible && st && st.size >= MIN_COMPRESS_BYTES ? negotiateEncoding(req) : null;
    if (encoding) {
      const sendCompressed = async () => {
        let compressed: Buffer;
        if (cache === true) {
          const key = `${encoding}:${file}`;
          let cached = immutableCompressed.get(key);
          if (!cached) {
            cached = readFile(file).then((raw) => compressBuffer(raw, encoding));
            cached.catch(() => immutableCompressed.delete(key));
            if (immutableCompressed.size >= MAX_CACHED_COMPRESSED) {
              const oldest = immutableCompressed.keys().next().value;
              if (oldest !== undefined) immutableCompressed.delete(oldest);
            }
            immutableCompressed.set(key, cached);
          }
          compressed = await cached;
        } else {
          compressed = await compressBuffer(await readFile(file), encoding);
        }
        headers['content-encoding'] = encoding;
        headers['content-length'] = String(compressed.length);
        res.writeHead(200, headers);
        res.end(compressed);
      };
      void sendCompressed().catch((err) => {
        if (!res.headersSent) res.destroy(err as Error);
      });
      return;
    }
    res.writeHead(200, headers);
    createReadStream(file)
      .on('error', (err) => res.destroy(err))
      .pipe(res);
  };

  /** A file of the client bundle, or undefined when it's missing, a folder, or outside the bundle. */
  const publicFile = (p: string): string | undefined => hotReload.file(p);

  const serveIndex = (res: http.ServerResponse, token: string | null, req?: http.IncomingMessage) => {
    let html = readFileSync(path.join(hotReload.publicDir, 'index.html'), 'utf8');
    html = html.replace(/<meta\b[^>]*name=["']office-revision["'][^>]*>/gi, '').replace(/<script\b[^>]*src=["']\/api\/hot-reload\/client\.js["'][^>]*>\s*<\/script>/gi, '');
    // A <script> tag can't append the LAN token itself, so the page carries it into the URL.
    const recovery = `<meta name="office-revision" content="${hotReload.state().revision}"><script src="/api/hot-reload/client.js${token ? `?t=${encodeURIComponent(token)}` : ''}" defer></script>`;
    // Also inject when a source edit deletes the original tags (or even the head).
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => head + recovery) : recovery + html;
    const headers: http.OutgoingHttpHeaders = { 'content-type': MIME['.html'], 'cache-control': 'no-store', vary: 'Accept-Encoding', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
    const encoding = html.length >= MIN_COMPRESS_BYTES ? negotiateEncoding(req) : null;
    if (encoding) {
      void compressBuffer(Buffer.from(html, 'utf8'), encoding)
        .then((compressed) => {
          headers['content-encoding'] = encoding;
          headers['content-length'] = String(compressed.length);
          res.writeHead(200, headers);
          res.end(compressed);
        })
        .catch((err) => {
          if (!res.headersSent) res.destroy(err as Error);
        });
      return;
    }
    res.writeHead(200, headers);
    res.end(html);
  };

  return { serveFile, publicFile, serveIndex };
}
