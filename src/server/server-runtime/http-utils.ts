import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { Config } from '../config.js';
import { isLoopback, loopbackHost } from '../lan.js';
export function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return readBytes(req, limit).then((b) => b.toString('utf8'));
}

export function readBytes(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Whether the page asking is the office itself. Loopback requests bypass the LAN token (they are the
 * office's own machine), so upgrades and owner writes always need the Origin to match too: without
 * that, any site the owner has open could drive their office over loopback.
 */
export function sameOrigin(req: http.IncomingMessage, cfg: Config): boolean {
  const origin = req.headers.origin;
  const host = (cfg.trustProxy && (req.headers['x-forwarded-host'] as string)) || req.headers.host;
  try {
    return !!origin && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Whether a request for `/api/status` comes from the Mac app's main process: from this machine, to a loopback
 * host name (not a site whose name a DNS rebinding pointed here), and not from another site's page (which sends Origin).
 */
export function statusRequest(req: http.IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress) && loopbackHost(req.headers.host) && !req.headers.origin;
}

export function refuseUpgrade(socket: Duplex) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

export function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(json);
}
