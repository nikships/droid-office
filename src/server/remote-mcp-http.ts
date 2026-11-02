import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { bearerToken, isLoopback, lanTokenOk, loopbackHost } from './lan.js';
import { createOfficeMcp, OFFICE_MCP_PATH, type OfficeMcpDeps } from './office-mcp/index.js';
import type { RemoteOffice } from './remote-office.js';

export const REMOTE_ADMIN_PATH = '/office/remote-workers';
export const REMOTE_ADMIN_TOKEN = 'remote-mcp-admin-token';

/** This listener has exactly one route. It must NEVER be attached to the main or hook server. */
export function remoteMcpListener(deps: OfficeMcpDeps & { remote: RemoteOffice; remoteTransport: { hostname: string } }) {
  const mcp = createOfficeMcp(deps);
  const server = createServer(async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress) || req.url?.split('?')[0] !== OFFICE_MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) req.destroy();
    });
    try {
      await mcp.handle(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), name: z.string().trim().min(1).max(60), floor: z.string().min(1).max(128) }),
  z.object({ action: z.enum(['rotate', 'revoke']), id: z.string().min(1).max(128) }),
]);

/** Provisioning is owner-local, protected by a separate file credential, never a remote MCP tool. */
export class RemoteMcpAdmin {
  private readonly token = randomBytes(32).toString('hex');

  constructor(
    dataDir: string,
    private readonly office: RemoteOffice,
    private readonly hostname: string,
    private readonly port: number,
  ) {
    writeFileSync(path.join(dataDir, REMOTE_ADMIN_TOKEN), this.token, { mode: 0o600 });
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!isLoopback(req.socket.remoteAddress) || !loopbackHost(req.headers.host) || req.headers.origin || req.headers['sec-fetch-site'] || !lanTokenOk(bearerToken(req), this.token))
      return send(403, { error: 'Owner-local provisioning credential required' });
    if (req.method === 'GET') return send(200, { workers: this.office.store.list(), floors: this.office.list(''), hostname: this.hostname, backendPort: this.port });
    if (req.method !== 'POST') return send(405, { error: 'Use GET or POST' });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 4096) return send(413, { error: 'Request too large' });
      }
      const command = commandSchema.parse(JSON.parse(body));
      if (command.action === 'add') {
        const { worker, token } = this.office.add(command.name, command.floor);
        return send(200, { worker: worker.id, token, hostname: this.hostname });
      }
      if (command.action === 'rotate') return send(200, { worker: command.id, token: this.office.store.rotate(command.id), hostname: this.hostname });
      await this.office.revoke(command.id);
      return send(200, { revoked: command.id });
    } catch (err) {
      return send(400, { error: err instanceof z.ZodError ? 'Invalid provisioning request' : err instanceof Error ? err.message : 'Provisioning failed' });
    }
  }
}
