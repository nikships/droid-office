import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { isLoopback } from './lan.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpDeps } from './office-mcp/index.js';
import type { RemoteOffice } from './remote-office.js';
import { planServe, TailscaleCli } from './tailscale.js';
import type { RemoteMcpBot, RemoteMcpConnection, RemoteMcpState, RemoteMcpStatus } from '../shared/remote-mcp.js';

/** In the office's own `.droid-office/`: whether the endpoint is on, and the ports it last used, so its URL stays put. */
export const REMOTE_MCP_FILE = 'remote-mcp.json';
const BACKEND_PORT = 4611;
const RETRY_MS = 30_000;

/** This listener has exactly one route. It must NEVER be attached to the main or hook server. */
export function remoteMcpListener(deps: OfficeMcpDeps & { remote: RemoteOffice; remoteTransport: NonNullable<OfficeMcpDeps['remoteTransport']> }) {
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

interface Saved {
  on: boolean;
  backendPort?: number;
  httpsPort?: number;
}

const port = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536 ? (v as number) : undefined);

function readSaved(file: string): Saved {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return { on: raw.on !== false, backendPort: port(raw.backendPort), httpsPort: port(raw.httpsPort) };
  } catch {
    return { on: true };
  }
}

export function remoteMcpUrl(hostname: string, httpsPort: number): string {
  return `https://${hostname}${httpsPort === 443 ? '' : `:${httpsPort}`}${OFFICE_MCP_PATH}`;
}

export interface RemoteMcpOptions {
  dataDir: string;
  office: RemoteOffice;
  mcp: Omit<OfficeMcpDeps, 'remote' | 'remoteTransport'>;
  cli?: TailscaleCli;
  /** Where the loopback listener tries first; 0 picks any free port. */
  backendPort?: number;
  retryMs?: number;
  log?(line: string): void;
}

/**
 * External workers' MCP on the owner's tailnet, on by default: a loopback-only listener, and a Tailscale
 * Serve mapping to it the office makes and removes itself. Serve is tailnet-only HTTPS (never Funnel), and
 * tailscaled keeps the mapping across restarts, so the URL in Settings stays the same.
 */
export class RemoteMcp {
  private saved: Saved;
  private server?: Server;
  private status: RemoteMcpStatus = 'off';
  private reason?: string;
  private fixUrl?: string;
  private hostname?: string;
  private owner?: string;
  private httpsPort?: number;
  private work: Promise<unknown> = Promise.resolve();
  private retry?: NodeJS.Timeout;
  private triedAt = 0;
  private closed = false;
  private readonly cli: TailscaleCli;
  private readonly file: string;

  constructor(private readonly opts: RemoteMcpOptions) {
    this.file = path.join(opts.dataDir, REMOTE_MCP_FILE);
    this.cli = opts.cli ?? new TailscaleCli();
    this.saved = readSaved(this.file);
  }

  start(): Promise<RemoteMcpState> {
    return this.saved.on ? this.queue(() => this.enable()) : Promise.resolve(this.state());
  }

  set(on: boolean): Promise<RemoteMcpState> {
    this.save({ ...this.saved, on });
    return this.queue(() => (on ? this.enable() : this.disable()));
  }

  /** Settings asks again: a Tailscale that came up since, or a mapping removed from outside, is caught here. */
  refresh(): Promise<RemoteMcpState> {
    // Waiting on the owner in Tailscale's admin console, `serve` blocks on the same link again: Settings gets
    // what's known now, and the office asks again in the background at most once per retry interval.
    if (this.fixUrl) {
      if (Date.now() - this.triedAt >= (this.opts.retryMs ?? RETRY_MS)) void this.start();
      return Promise.resolve(this.state());
    }
    return this.start();
  }

  add(name: string): RemoteMcpState {
    this.opts.office.add(name);
    return this.state();
  }

  rotate(id: string): RemoteMcpState {
    this.opts.office.store.rotate(id);
    return this.state();
  }

  revoke(id: string): RemoteMcpState {
    this.opts.office.revoke(id);
    return this.state();
  }

  addKey(id: string, name: string): RemoteMcpState {
    this.opts.office.store.addKey(id, name);
    return this.state();
  }

  revokeKey(id: string, key: string): RemoteMcpState {
    this.opts.office.store.revokeKey(id, key);
    return this.state();
  }

  state(): RemoteMcpState {
    const url = this.status === 'serving' && this.hostname && this.httpsPort ? remoteMcpUrl(this.hostname, this.httpsPort) : undefined;
    const bots = this.opts.office.store.list().map((r): RemoteMcpBot => {
      const worker = this.opts.office.store.identity(r.id);
      const connection = (key?: string): RemoteMcpConnection | undefined => {
        const token = this.opts.office.store.token(r.id, key);
        return url && token ? { url, headers: { Authorization: `Bearer ${token}`, [OFFICE_MCP_WORKER_HEADER]: r.id } } : undefined;
      };
      const main = connection();
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        unread: r.unread,
        ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : {}),
        ...(worker ? { status: worker.status, activity: worker.activity } : {}),
        ...(main ? { connection: main } : {}),
        keys: r.keys.map((k) => {
          const c = connection(k.id);
          return { ...k, ...(c ? { connection: c } : {}) };
        }),
      };
    });
    return { on: this.saved.on, status: this.status, ...(url ? { url } : {}), ...(this.reason ? { reason: this.reason } : {}), ...(this.fixUrl ? { fixUrl: this.fixUrl } : {}), bots };
  }

  /** The office is stopping. The Serve mapping stays, so the next start keeps the same URL. */
  stop() {
    this.closed = true;
    clearTimeout(this.retry);
    this.closeListener();
  }

  private queue(task: () => Promise<void>): Promise<RemoteMcpState> {
    const run = this.work.then(task);
    this.work = run.catch(() => undefined);
    return run.then(
      () => this.state(),
      (err: Error) => {
        this.unavailable(err.message);
        return this.state();
      },
    );
  }

  private async enable() {
    clearTimeout(this.retry);
    if (this.closed || !this.saved.on) return;
    this.triedAt = Date.now();
    if (this.status !== 'serving') this.status = 'starting';
    const backend = await this.listen();
    const self = await this.cli.self();
    if (!self?.dnsName) return this.unavailable('Tailscale isn’t running on this computer, or MagicDNS is off. This turns on by itself once it is.');
    const routes = await this.cli.routes(self.dnsName);
    if (!routes) return this.unavailable('Tailscale didn’t say what it serves. Update Tailscale, then turn this off and on.');
    const target = `http://127.0.0.1:${backend}`;
    const previous = this.saved.backendPort !== undefined && this.saved.backendPort !== backend ? `http://127.0.0.1:${this.saved.backendPort}` : undefined;
    const plan = planServe(routes, target, this.saved.httpsPort, previous);
    if (!plan) return this.unavailable('Something else already serves every HTTPS port the office tries on your tailnet.');
    if (!plan.existing) {
      const done = await this.cli.serve(plan.port, target);
      if (!done.ok) return this.unavailable(done.message, done.fixUrl);
      this.log(`  🔌  External workers’ MCP is on your tailnet: ${remoteMcpUrl(self.dnsName, plan.port)}`);
    }
    if (this.closed) return;
    this.hostname = self.dnsName;
    this.owner = self.login;
    this.httpsPort = plan.port;
    this.status = 'serving';
    this.reason = routes.find((r) => r.port === plan.port)?.funnel ? 'Funnel is on for this port. The office refuses every request that comes through it.' : undefined;
    this.fixUrl = undefined;
    this.save({ ...this.saved, backendPort: backend, httpsPort: plan.port });
  }

  private async disable() {
    clearTimeout(this.retry);
    const backend = this.server?.listening ? (this.server.address() as AddressInfo).port : undefined;
    const ports = new Set([this.httpsPort, this.saved.httpsPort].filter((p) => p !== undefined));
    this.status = 'off';
    this.reason = this.fixUrl = this.hostname = this.owner = this.httpsPort = undefined;
    this.closeListener();
    const self = await this.cli.self();
    if (!self?.dnsName) return;
    const targets = new Set([backend, this.saved.backendPort].filter((p) => p !== undefined).map((p) => `http://127.0.0.1:${p}`));
    // Only the office's own mapping: a port someone pointed elsewhere since is theirs.
    for (const r of (await this.cli.routes(self.dnsName)) ?? []) if (ports.has(r.port) && r.proxy && targets.has(r.proxy)) await this.cli.unserve(r.port);
  }

  private unavailable(reason: string, fixUrl?: string) {
    this.status = 'unavailable';
    this.reason = reason;
    this.fixUrl = fixUrl;
    this.hostname = this.owner = this.httpsPort = undefined;
    clearTimeout(this.retry);
    // Waiting on the owner in Tailscale's admin console: asking again soon only repeats the same link.
    const wait = (this.opts.retryMs ?? RETRY_MS) * (fixUrl ? 10 : 1);
    if (!this.closed && this.saved.on) this.retry = setTimeout(() => void this.start(), wait).unref();
  }

  private async listen(): Promise<number> {
    if (this.server?.listening) return (this.server.address() as AddressInfo).port;
    const server = remoteMcpListener({ ...this.opts.mcp, remote: this.opts.office, remoteTransport: { hostname: () => this.hostname, owner: () => this.owner } });
    const first = this.saved.backendPort ?? this.opts.backendPort ?? BACKEND_PORT;
    for (const p of first ? [first, 0] : [0]) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(p, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        });
        this.server = server;
        return (server.address() as AddressInfo).port;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || p === 0) throw err;
      }
    }
    throw new Error('No free port for the external workers’ MCP');
  }

  private closeListener() {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
  }

  private save(next: Saved) {
    this.saved = next;
    try {
      writeFileSync(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    } catch {
      // the office still runs; the setting just won't survive a restart
    }
  }

  private log(line: string) {
    (this.opts.log ?? console.log)(line);
  }
}
