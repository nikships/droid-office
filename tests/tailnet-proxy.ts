import { once } from 'node:events';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tailnetHttpsListener } from '../src/server/tailnet-https.js';

/** Emulate Serve's loopback hop, using the production boundary and real HTTP/WebSocket handlers. */
export async function tailnetProxy(t: { after(fn: () => unknown): unknown }, office: Server) {
  const origin = 'https://office.example.ts.net:8444';
  const host = new URL(origin).host;
  const listener = tailnetHttpsListener({
    origin: () => origin,
    owner: () => 'owner@example.com',
    request: (req, res) => office.emit('request', req, res),
    upgrade: (req, socket, head) => office.emit('upgrade', req, socket, head),
  });
  listener.server.listen(0, '127.0.0.1');
  await once(listener.server, 'listening');
  t.after(async () => {
    const closed = once(listener.server, 'close');
    listener.close();
    await closed;
  });
  const base = `http://127.0.0.1:${(listener.server.address() as AddressInfo).port}`;
  const fetchViaServe: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).origin !== base) return fetch(input, init);
    if (!req.headers.has('host')) req.headers.set('host', host);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
    return new Promise((resolve, reject) => {
      const outgoing = request(req.url, { method: req.method, headers: Object.fromEntries(req.headers), signal: req.signal }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const status = incoming.statusCode ?? 500;
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
        });
        incoming.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
  return { base, origin, host, fetch: fetchViaServe, listener };
}
